// The parts of the 5s play-history poller (POST /api/sync/play-history) that
// the Plex and Jellyfin passes share: the per-session write runner, the poster
// lookup, the absence sweep, the cached identity resolve and the playhead rules
// (guardrails 19, 20, 21). session-poll-plex.ts and session-poll-jellyfin.ts are
// the two passes; the route only orchestrates them.
import { prisma } from "@/lib/prisma";
import type { ActiveSession } from "@/generated/prisma";
import { mapLimit } from "@/lib/concurrency";
import { processSingleton } from "@/lib/process-singleton";
import {
  applyFinalTick,
  recordCompletedSession,
  resolveMediaServerUser,
  SESSION_ABSENCE_GRACE_MS,
  STALE_FINALIZE_CONCURRENCY,
} from "@/lib/play-history";

/** One server's tick: sessions it started, updated and ended. */
export type SyncResult = { started: number; updated: number; ended: number };

/** What one session's write did. "skipped" is counted nowhere. */
export type SessionWriteOutcome = "started" | "updated" | "ended" | "skipped";

// Both session helpers compose an episode's display title as
// `${show} — ${episode}` (plex.ts / jellyfin.ts). Recover the episode half by
// removing that exact prefix, NOT by splitting on the separator: the show name
// can contain " — " too, and splitting left its tail glued to the episode name.
// Falls back to the composed title when the prefix isn't there (nothing to strip).
const TITLE_SEP = " — ";
export function stripShowPrefix(composed: string, show: string | null | undefined): string | null {
  if (show && composed.startsWith(show + TITLE_SEP)) {
    return composed.slice(show.length + TITLE_SEP.length) || null;
  }
  const idx = composed.indexOf(TITLE_SEP);
  return idx === -1 ? null : composed.slice(idx + TITLE_SEP.length) || null;
}

// The 5s poller's /status/sessions snapshot lags the real-time SSE writer
// (applyLiveStateUpdate in plex-events.ts), which pushes progressMs ahead. When
// the poller then writes its slightly-older snapshot it would move progressMs
// *backward* by a few seconds, making the now-playing progress bar bounce every
// poll. Treat a small backward step (within this window) as stale-snapshot
// jitter and keep the fresher stored value; a larger backward jump is a genuine
// seek-back and is written through. ~2 poll intervals of slack. Only the poller
// clamps — SSE is the authoritative real-time source and always writes raw.
export const PROGRESS_JITTER_TOLERANCE_MS = 10_000;

/** A small backward step the poller clamps out (see PROGRESS_JITTER_TOLERANCE_MS). */
export function isJitterBackstep(fromMs: number, toMs: number): boolean {
  return toMs < fromMs && fromMs - toMs <= PROGRESS_JITTER_TOLERANCE_MS;
}

// Guardrail 20: the playhead MOVED, forward or backward — not a strict advance.
// A clamped jitter backstep is not movement: it is never written, so it could
// never converge and would keep the stall anchor fresh forever.
export function playheadMovedFrom(fromMs: number, toMs: number): boolean {
  return toMs !== fromMs && !isJitterBackstep(fromMs, toMs);
}

// One session's failed write (a title too long for its column, a transient DB
// error) must not reject the whole instance tick: every other session's result
// would be lost and the absence sweep after the writes would never run, so ended
// sessions stayed "playing". The failure is warned and the session skipped; the
// next tick retries it. `write` is called synchronously in item order, so a write
// whose synchronous prefix claims shared state (Jellyfin's single-use fallback row)
// keeps that order.
export function writeEachSession<T, R>(
  items: readonly T[],
  idOf: (item: T) => string,
  write: (item: T) => Promise<R>,
): Promise<Array<R | "skipped">> {
  return Promise.all(
    items.map(async (item): Promise<R | "skipped"> => {
      try {
        return await write(item);
      } catch (err) {
        console.warn(`[play-history] session write failed for ${idOf(item)}:`, err);
        return "skipped";
      }
    }),
  );
}

/** The tick's counts from its write outcomes, plus the sessions its sweep ended. */
export function tickResult(outcomes: ReadonlyArray<SessionWriteOutcome>, sweptEnded: number): SyncResult {
  let started = 0;
  let updated = 0;
  let ended = sweptEnded;
  for (const o of outcomes) {
    if (o === "started") started++;
    else if (o === "updated") updated++;
    else if (o === "ended") ended++;
  }
  return { started, updated, ended };
}

// Posters for every distinct (tmdbId, mediaType) a tick resolved, keyed
// "<tmdbId>:<mediaType>". Best-effort: a failed read just leaves them null.
export async function lookupSessionPosters(
  resolved: ReadonlyArray<{ tmdbId: number | null; mediaType: "MOVIE" | "TV" | null }>,
): Promise<Map<string, string | null>> {
  const posterPairs = Array.from(
    new Map(
      resolved
        .filter((r): r is { tmdbId: number; mediaType: "MOVIE" | "TV" } => r.tmdbId != null && r.mediaType !== null)
        .map((r) => [`${r.tmdbId}:${r.mediaType}`, { tmdbId: r.tmdbId, mediaType: r.mediaType }]),
    ).values(),
  );
  const posterRows = posterPairs.length > 0
    ? await prisma.tmdbMediaCore.findMany({
        where: { OR: posterPairs.map((p) => ({ tmdbId: p.tmdbId, mediaType: p.mediaType })) },
        select: { tmdbId: true, mediaType: true, posterPath: true },
      }).catch(() => [])
    : [];
  return new Map(posterRows.map((r) => [`${r.tmdbId}:${r.mediaType}`, r.posterPath]));
}

// Rows this instance's server no longer reports and hasn't for the absence grace
// (SESSION_ABSENCE_GRACE_MS). A failed boot re-anchor leaves every lastSeenAt
// stale by the whole downtime, making the grace trivially true for sessions that
// are still playing: then nothing is selected, and the next tick retries
// (guardrail 21).
export function selectStaleSessions(
  rows: readonly ActiveSession[],
  seenSessionKeys: ReadonlySet<string>,
  reanchored: boolean,
  nowMs: number,
): ActiveSession[] {
  if (!reanchored) return [];
  return rows.filter(
    (session) =>
      !seenSessionKeys.has(session.sessionKey)
      && nowMs - session.lastSeenAt.getTime() >= SESSION_ABSENCE_GRACE_MS,
  );
}

/**
 * The absence sweep of one source on one server: finalize every row this tick
 * didn't see, past the grace. serverInstance-scoped: two instances legitimately
 * reuse the same raw sessionKey, and `seen` only holds THIS server's keys — an
 * unscoped read would let instance A's pass absence-finalize instance B's live
 * rows. No final tick and no stoppedAt: the session has been ABSENT for >= the
 * grace, so the interval since lastSeenAt is not playtime, and the stop happened
 * right after lastSeenAt, not now (cleanupStaleSessions' rule). skipSSE: the
 * route emits one batched activity:history-updated per run. Bounded (guardrail
 * 31): a media-server outage ages every active session into one sweep. A failed
 * finalize is warned and retried next tick. `afterFinalize` runs only once the
 * history row exists (guardrail 27). Returns how many were finalized.
 */
export async function finalizeAbsentSessions(opts: {
  source: "plex" | "jellyfin";
  instance: string;
  seen: ReadonlySet<string>;
  reanchored: boolean;
  nowMs: number;
  afterFinalize?: (session: ActiveSession) => void;
}): Promise<number> {
  const rows = await prisma.activeSession.findMany({ where: { source: opts.source, serverInstance: opts.instance } });
  const stale = selectStaleSessions(rows, opts.seen, opts.reanchored, opts.nowMs);
  const finalized = await mapLimit(stale, STALE_FINALIZE_CONCURRENCY, (session) =>
    recordCompletedSession(session, { skipSSE: true })
      .then(() => {
        opts.afterFinalize?.(session);
        return true;
      })
      .catch((err) => {
        console.warn(`[play-history] Failed to finalize ${opts.source} session ${session.id}:`, err);
        return false;
      }),
  );
  return finalized.filter(Boolean).length;
}

// resolveMediaServerUser runs a full advisory-lock transaction (~5 round trips
// on a max:5 pool) — right for a cold session, pure waste for the same
// (source, instance, user) resolving to the same row on every 5s tick. Memoize
// the resolved row id keyed by identity, busted whenever the mirrored inputs
// change (username/thumb/admin flag must still propagate promptly). A cache
// hit writes nothing, so it structurally cannot overwrite a manualUserLink pin
// (guardrail 34 — the pin logic still runs on every real resolve); userId
// healing on unchanged inputs is deferred at most RESOLVE_TTL_MS, and read-time
// attribution goes through MediaServerUser.userId anyway. Failures are not
// cached — the next tick retries.
const RESOLVE_TTL_MS = 5 * 60 * 1000;
const RESOLVE_CACHE_PRUNE_AT = 1024;
const resolveCache = processSingleton("session-poll:resolve-cache", () => new Map<string, { id: string; inputsKey: string; expiresAt: number }>());
export async function resolveMediaServerUserCached(
  params: Parameters<typeof resolveMediaServerUser>[0],
): Promise<string> {
  const key = `${params.source}:${params.serverInstance}:${params.sourceUserId}`;
  const inputsKey = JSON.stringify([params.username, params.thumbUrl ?? null, params.isServerAdmin ?? null]);
  const now = Date.now();
  const hit = resolveCache.get(key);
  if (hit && hit.expiresAt > now && hit.inputsKey === inputsKey) return hit.id;
  const id = await resolveMediaServerUser(params);
  if (resolveCache.size >= RESOLVE_CACHE_PRUNE_AT) {
    for (const [k, v] of resolveCache) if (v.expiresAt <= now) resolveCache.delete(k);
  }
  resolveCache.set(key, { id, inputsKey, expiresAt: now + RESOLVE_TTL_MS });
  return id;
}

/** "MOVIE" / "TV" for a media-server item type, else null (a clip, a track). */
export function mediaTypeOfItem(kind: "movie" | "episode" | string | null | undefined): "MOVIE" | "TV" | null {
  return kind === "episode" ? "TV" : kind === "movie" ? "MOVIE" : null;
}

/** Played percentage of a duration; 0 when the duration is unknown. */
export function progressPercentOf(positionMs: number, durationMs: number): number {
  return durationMs > 0 ? (positionMs / durationMs) * 100 : 0;
}

/** The poster a tick looked up for a resolved title, else null. */
export function posterOf(
  posters: ReadonlyMap<string, string | null>,
  tmdbId: number | null,
  mediaType: "MOVIE" | "TV" | null,
): string | null {
  return tmdbId != null && mediaType ? posters.get(`${tmdbId}:${mediaType}`) ?? null : null;
}

/**
 * Force-finalize a row whose playback has ended under its key (the next item
 * of an auto-play, a stalled ghost): its final tick is written as of `now`.
 * False — warned, nothing recorded — when the write fails, so the caller
 * skips the session and the next tick retries; the caller updates any
 * in-memory ledger only on true (guardrail 27).
 */
export async function forceFinalizeSession(
  existing: ActiveSession,
  now: Date,
  label: string,
  sessionId: string,
): Promise<boolean> {
  try {
    await recordCompletedSession(applyFinalTick(existing, now), { skipSSE: true, stoppedAt: now });
    return true;
  } catch (err) {
    console.warn(`[play-history] ${label} failed for ${sessionId}:`, err);
    return false;
  }
}

/**
 * The fields of a continuing session's CAS update that both sources write the
 * same way: the playtime increment, the one-shot duration backfill (durationMs
 * is write-once at create, so a first tick that stamped 0 is filled once a
 * real duration appears), the resolved title and its poster.
 */
export function continuingUpdateFields(opts: {
  existing: Pick<ActiveSession, "durationMs">;
  increment: bigint;
  durationMs: number;
  tmdbId: number | null;
  mediaType: "MOVIE" | "TV" | null;
  posterPath: string | null;
}): {
  playtimeMs?: { increment: bigint };
  durationMs?: bigint;
  tmdbId?: number;
  mediaType?: "MOVIE" | "TV" | null;
  posterPath?: string;
} {
  const { existing, increment, durationMs, tmdbId, mediaType, posterPath } = opts;
  return {
    ...(increment > BigInt(0) ? { playtimeMs: { increment } } : {}),
    ...(existing.durationMs === BigInt(0) && durationMs > 0 ? { durationMs: BigInt(durationMs) } : {}),
    ...(tmdbId != null ? { tmdbId, mediaType } : {}),
    ...(posterPath ? { posterPath } : {}),
  };
}
