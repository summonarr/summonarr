import "server-only";
import { prisma } from "./prisma";
import { resolveLinkedMediaServerUserIds } from "./my-watch-history";
import {
  PLAYBACK_CONTEXT_CANDIDATES,
  PLAYBACK_CONTEXT_WINDOW_DAYS,
  buildPlaybackContext,
  pickPlay,
  type IssueScopeRef,
  type PlaybackContext,
} from "./issue-playback-context";

// What the loader reads of a play. `id` only dedupes the two reads below;
// buildPlaybackContext copies none of it, and nothing network-identifying is
// read at all (guardrail 5j).
const PLAY_SELECT = {
  id: true,
  source: true, startedAt: true, stoppedAt: true, seasonNumber: true, episodeNumber: true,
  platform: true, player: true, device: true, playMethod: true,
  videoDecision: true, audioDecision: true, videoCodec: true, audioCodec: true,
  resolution: true, container: true, bitrate: true, transcodeReason: true,
  location: true, relayed: true,
} as const;

/**
 * The reporter's most recent play of the reported title, or null. Identity goes
 * through the shared linkage rule (guardrail 34), so a reporter whose Plex or
 * Jellyfin account is linked by id, email or an admin's pin is found; one with
 * no linked identity, or no recent play, gets null. Best effort by contract: a
 * failed read must never block filing an issue.
 */
export async function loadPlaybackContext(
  reporterId: string,
  title: { tmdbId: number; mediaType: "MOVIE" | "TV" },
  scope: IssueScopeRef,
  now: Date,
): Promise<PlaybackContext | null> {
  try {
    const ids = await resolveLinkedMediaServerUserIds(reporterId);
    if (ids.length === 0) return null;
    const since = new Date(now.getTime() - PLAYBACK_CONTEXT_WINDOW_DAYS * 86_400_000);
    const where = {
      mediaServerUserId: { in: ids },
      tmdbId: title.tmdbId,
      mediaType: title.mediaType,
      stoppedAt: { gte: since },
    };
    // The recent plays of the title, and — for a scoped issue — the newest play
    // of the reported episode/season itself: a reporter who watched past it
    // (25+ newer plays) would otherwise get another episode's play, exact:false,
    // although the exact one is inside the window. pickPlay ranks the union.
    const scoped =
      scope.scope === "EPISODE" && scope.seasonNumber != null && scope.episodeNumber != null
        ? { seasonNumber: scope.seasonNumber, episodeNumber: scope.episodeNumber }
        : scope.scope === "SEASON" && scope.seasonNumber != null
          ? { seasonNumber: scope.seasonNumber }
          : null;
    const [recent, exact] = await Promise.all([
      prisma.playHistory.findMany({
        where,
        orderBy: { startedAt: "desc" },
        take: PLAYBACK_CONTEXT_CANDIDATES,
        select: PLAY_SELECT,
      }),
      scoped
        ? prisma.playHistory.findMany({
            where: { ...where, ...scoped },
            // pickPlay takes the newest stoppedAt within a rank: that row is the one needed.
            orderBy: { stoppedAt: "desc" },
            take: 1,
            select: PLAY_SELECT,
          })
        : Promise.resolve([]),
    ]);
    const seen = new Set(recent.map((r) => r.id));
    const rows = [...recent];
    for (const r of exact) if (!seen.has(r.id)) rows.push(r);
    const pick = pickPlay(rows, scope, now);
    return pick ? buildPlaybackContext(pick.row, pick.exact) : null;
  } catch (err) {
    console.error("[issue-playback-context] read failed:", err instanceof Error ? err.message : err);
    return null;
  }
}
