import "server-only";
import { prisma } from "./prisma";
import { processSingleton } from "./process-singleton";
import { emitNotificationEvent } from "./notify-agents";
import { createInAppNotification } from "./in-app-notify";
import {
  countStreamsByOwner,
  evaluateStreams,
  parseStreamLimit,
  streamAlertText,
  type StreamAlertState,
} from "./stream-limit";

export const CONCURRENT_STREAM_LIMIT_KEY = "concurrentStreamLimit";

// Process-wide (guardrail 27a): every chunk's copy of this module must see the
// same transition state or each would alert once. A restart forgets it, so the
// first evaluation after boot may alert once for streams already over the limit.
const state = processSingleton<{ current: StreamAlertState }>("stream-limit:state", () => ({
  current: { over: new Set<string>(), alertedAt: new Map<string, number>() },
}));

/**
 * One evaluation, called by the 5s play-history poller after it has refreshed
 * ActiveSession. Never throws (the poll must not fail over an alert); returns the
 * number of owners alerted. Reads the limit with setting.findUnique ONLY, like
 * the rest of the poller's config reads.
 */
export async function evaluateConcurrentStreams(now: Date = new Date()): Promise<number> {
  try {
    const row = await prisma.setting.findUnique({ where: { key: CONCURRENT_STREAM_LIMIT_KEY } });
    const limit = parseStreamLimit(row?.value);
    if (limit === 0) {
      state.current = evaluateStreams(new Map(), 0, state.current, now.getTime()).state;
      return 0;
    }

    const sessions = await prisma.activeSession.findMany({
      select: {
        id: true,
        mediaServerUserId: true,
        serverUsername: true,
        lastSeenAt: true,
        title: true,
        seasonNumber: true,
        episodeNumber: true,
        mediaServerUser: { select: { userId: true, isServerAdmin: true, username: true } },
      },
    });
    const counts = countStreamsByOwner(
      sessions.map((s) => ({
        id: s.id,
        mediaServerUserId: s.mediaServerUserId,
        userId: s.mediaServerUser?.userId ?? null,
        username: s.mediaServerUser?.username || s.serverUsername,
        isServerAdmin: s.mediaServerUser?.isServerAdmin === true,
        lastSeenAt: s.lastSeenAt,
        title: s.title,
        seasonNumber: s.seasonNumber,
        episodeNumber: s.episodeNumber,
      })),
      now,
    );

    const result = evaluateStreams(counts, limit, state.current, now.getTime());
    // State is committed only after the evaluation succeeded; an alert that then
    // fails to send is best-effort (the cooldown still applies).
    state.current = result.state;
    if (result.alert.length === 0) return 0;

    const admins = await prisma.user
      .findMany({ where: { role: "ADMIN", deactivatedAt: null }, select: { id: true } })
      .catch(() => [] as { id: string }[]);
    for (const owner of result.alert) {
      const text = streamAlertText(owner, limit);
      emitNotificationEvent({
        event: "stream.concurrent",
        actor: { name: owner.username },
        text,
      });
      for (const a of admins) {
        createInAppNotification(a.id, {
          type: "STREAM_LIMIT",
          title: owner.username,
          body: text,
        });
      }
    }
    return result.alert.length;
  } catch (err) {
    console.error("[stream-limit] evaluation failed:", err instanceof Error ? err.message : err);
    return 0;
  }
}
