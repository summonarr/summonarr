// Recording plays: the live-session finalize that turns an ActiveSession into a
// PlayHistory row (the SOLE writer of Jellyfin play history — guardrail 19), the
// playtime accounting the pollers and SSE share, the boot re-anchor (guardrail
// 21), the stale-session safety net and the retention purge.
import { prisma } from "./prisma";
import { emitSSE } from "./sse-emitter";
import { processSingleton } from "./process-singleton";
import { settleLimit } from "./concurrency";
import { tmdbDetailsKey } from "./tmdb-cache";
import type { ActiveSession, MediaType } from "@/generated/prisma";
import { getRetentionCutoff, getWatchedThreshold } from "./play-history-settings";
import { clearActivityCache } from "./play-history-cache";
import { emitActiveSessionsSnapshot } from "./play-history-snapshot";

export function calculateWatched(
  playDurationMs: number,
  totalDurationMs: number,
  thresholdPercent: number,
): boolean {
  if (totalDurationMs <= 0) return false;
  return (playDurationMs / totalDurationMs) * 100 >= thresholdPercent;
}

const MIN_PLAY_DURATION_S = 90;
// Cap any single accumulation delta. Protects against missed events, machine sleep, or clock skew
// inflating playtime. cleanupStaleSessions(30) handles ghost sessions; this is the per-event guard.
export const MAX_PLAYTIME_DELTA_MS = 5 * 60 * 1000;
// Grace window before a session that has disappeared from the upstream snapshot
// (/status/sessions for Plex, /Sessions for Jellyfin) is treated as stopped.
// Why: pause flickers — Plex Web spuriously emits state="stopped" on pause,
// and some Jellyfin clients briefly clear NowPlayingItem on background — would
// otherwise write a stopped PlayHistory row + delete the ActiveSession on every
// pause. Sessions that miss N consecutive 5s polls (≈12 polls @ 60s) are
// finalized; pauses that resume within the window are preserved as still-live.
// cleanupStaleSessions(30) is the longer 30-min safety net beneath this.
export const SESSION_ABSENCE_GRACE_MS = 60_000;
// End-of-file clamp window. When the playhead lands within this distance of the
// media's total duration at finalize, treat it as a full-completion stop —
// Plex/Jellyfin clients commonly leave the player at viewOffset ≈ duration − a
// few seconds when the user "stops at the credits," and even playback that
// runs to the end rarely reports exactly duration. Without the clamp,
// sessions that effectively reached the end get classed as 99% completionRatio
// (not completed) and slide just below the 80% watched threshold for media
// where the credits roll consumes the tail. Tautulli uses the same 10 s window
// (activity_handler.py:122-126).
const END_OF_FILE_CLAMP_MS = 10_000;
// A session is `completed` when its playhead reached this share of the content
// (the credits start when known). It answers "did they get to the end", per
// sitting, and splits arcs as a rewatch boundary. It is deliberately NOT the
// admin's completion threshold (getCompletionThreshold): that one judges an
// ARC's cumulative watched share, a different question.
export const SESSION_COMPLETED_RATIO = 0.95;
// How far back to look when chaining a new finalize into the resume-group of a
// previous unwatched watch of the same media by the same user. Tautulli sets
// no upper bound; we cap at 7 days so the chain doesn't link a rewatch months
// later (which is a separate logical viewing).
const RESUME_GROUPING_LOOKBACK_MS = 7 * 24 * 60 * 60 * 1000;

// Returns the bigint to add to ActiveSession.playtimeMs when applying an event at `now`.
// Only accumulates when the prior state was "playing" — pause/buffer/initial state contribute nothing.
export function computePlaytimeIncrement(
  session: Pick<ActiveSession, "state" | "lastSeenAt">,
  now: Date,
): bigint {
  if (session.state !== "playing") return BigInt(0);
  const delta = now.getTime() - session.lastSeenAt.getTime();
  if (delta <= 0) return BigInt(0);
  return BigInt(Math.min(MAX_PLAYTIME_DELTA_MS, delta));
}

// Build a finalized session to pass to recordCompletedSession. Callers that close a "live" session
// (SSE stop, poller-detected end) use this so the trailing playtime between lastSeenAt
// and the close event is counted. cleanupStaleSessions does not use this — a stale session has no
// signal it was still playing.
//
// Do NOT overwrite session.lastSeenAt here. recordCompletedSession's deleteMany uses lastSeenAt
// as the CAS reference against the DB row; mutating it would compare the row to a fabricated
// "now" rather than the value we read, the CAS would never match, and finalized sessions would
// stay in the ActiveSession table until cleanupStaleSessions(30) caught them 30 minutes later.
// Pass stoppedAt via recordCompletedSession's opts instead.
export function applyFinalTick(
  session: ActiveSession,
  now: Date,
  override?: { progressMs?: bigint },
): ActiveSession {
  const increment = computePlaytimeIncrement(session, now);
  return {
    ...session,
    playtimeMs: session.playtimeMs + increment,
    ...(override?.progressMs !== undefined ? { progressMs: override.progressMs } : {}),
  };
}

function toMediaType(value: string | null): MediaType | null {
  return value === "MOVIE" || value === "TV" ? value : null;
}

// How long a finalized session played, before any setting is read.
export interface MeasuredPlay {
  stoppedAt: Date;
  totalDurationMs: number;
  // The playhead at stop, snapped to the end inside END_OF_FILE_CLAMP_MS.
  clampedProgressMs: number;
  playDurationMs: number;
  playDurationS: number;
}

export function measurePlay(session: ActiveSession, now: Date, stoppedAtOverride?: Date): MeasuredPlay {
  // The polling sync may leave playtimeMs at zero for short watches that disappear between
  // two 5s ticks, and pre-stop pauses can leave state="paused" so applyFinalTick contributes
  // 0. progressMs (playhead at stop) is always populated, so falling back to it covers those
  // gaps. BUT progressMs is the playhead POSITION in the file, not elapsed wall-clock time:
  // a user who seeks to the credits and quits at five seconds has progressMs ≈ totalDuration
  // even though they only watched five seconds. Cap by the actual wall-clock window so the
  // fallback can't credit more time than physically elapsed.
  const stoppedAt =
    stoppedAtOverride ?? (session.lastSeenAt > session.startedAt ? session.lastSeenAt : now);
  const wallElapsedMs = Math.max(0, stoppedAt.getTime() - session.startedAt.getTime());

  // End-of-file clamp: a session that ended within END_OF_FILE_CLAMP_MS of
  // the media's runtime is treated as completed at exactly durationMs. Some
  // clients stop at credits with a stale viewOffset; without this, the
  // PlayHistory row records progressMs = duration − 4 s, completionRatio
  // ≈ 99.7%, completed = false. Tautulli applies the same 10 s clamp at
  // activity_handler.py:122-126.
  const rawProgressMs = Number(session.progressMs);
  const totalDurationMs = Number(session.durationMs);
  const clampedProgressMs =
    totalDurationMs > 0 && rawProgressMs >= totalDurationMs - END_OF_FILE_CLAMP_MS
      ? totalDurationMs
      : rawProgressMs;

  // Subtract the session's resume offset (startProgressMs, stamped at create)
  // before capping: the fallback wants the playhead ADVANCE within this
  // session, not the absolute file position — a resume at 40:00 that played
  // 2 min is 2 min of watching, not 42. The wall cap alone couldn't see that
  // (it bounded a 42-min position to the 10-min wall window, still inflating
  // playDuration 5× and zeroing pausedDuration). A backward seek clamps the
  // delta to 0 and playtimeMs governs; pre-existing rows carry the 0 default
  // and reproduce the old start-of-file math exactly. `?? 0` guards rows from
  // stubs/fixtures that predate the column.
  const cappedProgressMs = Math.min(
    Math.max(0, clampedProgressMs - Number(session.startProgressMs ?? 0)),
    wallElapsedMs,
  );
  // playtimeMs is capped by the same wall-clock window: it sums poll and SSE
  // ticks, and two writers crediting one interval (or a clock step) could push
  // it past the span the row records, so a new row never claims more play time
  // than stoppedAt − startedAt. The boot clamp in docker-entrypoint.sh still
  // corrects rows written before this.
  const playDurationMs = Math.max(Math.min(Number(session.playtimeMs), wallElapsedMs), cappedProgressMs);
  const playDurationS = Math.max(0, Math.floor(playDurationMs / 1000));
  return { stoppedAt, totalDurationMs, clampedProgressMs, playDurationMs, playDurationS };
}

// The watched/completed verdicts and the stored durations for a measured play.
export function judgePlay(
  session: Pick<ActiveSession, "startedAt" | "creditsStartMs">,
  play: MeasuredPlay,
  watchedThresholdPct: number,
): { watched: boolean; completed: boolean; durationS: number; pausedDurationS: number } {
  // For watched / completed evaluation, treat "effective content end" as the
  // credits start when we have a marker — Plex players commonly stop at the
  // credits roll with progressMs just shy of duration, and a media that ran
  // 50 min of content + 5 min of credits should mark watched at the credits
  // boundary, not at 80% of the credit-inclusive 55 min total. Falls back to
  // the file duration when no marker exists.
  const totalDurationMs = play.totalDurationMs;
  const effectiveDurationMs =
    session.creditsStartMs != null && session.creditsStartMs > 0 && session.creditsStartMs <= totalDurationMs
      ? session.creditsStartMs
      : totalDurationMs;
  const watched = calculateWatched(play.playDurationMs, effectiveDurationMs, watchedThresholdPct);

  const totalElapsedS = Math.max(0, Math.floor((play.stoppedAt.getTime() - session.startedAt.getTime()) / 1000));
  const durationS = Math.max(0, Math.floor(totalDurationMs / 1000));
  const pausedDurationS = Math.max(0, totalElapsedS - play.playDurationS);

  // completionRatio uses effectiveDurationMs (credits-aware) for the same
  // reason as watched — reaching the credits is "completed."
  const completionRatio = effectiveDurationMs > 0 ? play.clampedProgressMs / effectiveDurationMs : 0;
  return { watched, completed: completionRatio >= SESSION_COMPLETED_RATIO, durationS, pausedDurationS };
}

// The poster path cached in the title's TMDB details blob, or null. A snapshot
// for the history row only; the activity views look posters up live.
async function cachedPosterPath(session: ActiveSession): Promise<string | null> {
  if (!session.tmdbId || !session.mediaType) return null;
  const cacheKey = tmdbDetailsKey(session.mediaType === "TV" ? "TV" : "MOVIE", session.tmdbId);
  const cacheRow = await prisma.tmdbCache
    .findUnique({ where: { key: cacheKey }, select: { data: true } })
    .catch((err: unknown) => {
      console.warn(`[play-history] poster lookup failed for ${cacheKey}; recording without one:`, err);
      return null;
    });
  if (!cacheRow) return null;
  try {
    const parsed: unknown = JSON.parse(cacheRow.data);
    return parsed && typeof parsed === "object" && "posterPath" in parsed && typeof parsed.posterPath === "string"
      ? parsed.posterPath
      : null;
  } catch {
    return null; // a malformed cache blob: no snapshot, the live lookup still finds one
  }
}

// Resume-grouping: link this row into a chain when a previous unwatched
// PlayHistory row exists for the same (user, source-item) within the last
// 7 days. The chain root self-references — every row in a chain shares the
// referenceId of the first row, so the UI can `GROUP BY referenceId` to
// collapse split watches ("paused on Monday, finished on Tuesday") into
// one logical viewing without recursive walks. We only look back from
// *unwatched* prior plays — once a chain reaches the watched threshold, the
// next play is a rewatch and starts its own chain.
async function resumeReferenceId(session: ActiveSession, stoppedAt: Date): Promise<string | null> {
  if (!session.sourceItemId) return null;
  const lookbackCutoff = new Date(stoppedAt.getTime() - RESUME_GROUPING_LOOKBACK_MS);
  // Ask for the most recent prior play and THEN test whether it was unwatched.
  // Putting `watched: false` in the WHERE instead (as this did) doesn't
  // implement the rule above — it just skips over watched rows to find an older
  // unwatched one, so a rewatch chains onto the completed watch that preceded
  // it: "paused Monday / finished Tuesday / rewatched Saturday" collapsed into a
  // single 3-segment viewing and the rewatch stopped counting as its own.
  const prior = await prisma.playHistory.findFirst({
    where: {
      source: session.source,
      sourceItemId: session.sourceItemId,
      mediaServerUserId: session.mediaServerUserId,
      startedAt: { gte: lookbackCutoff, lt: session.startedAt },
    },
    orderBy: { startedAt: "desc" },
    select: { id: true, referenceId: true, watched: true },
  }).catch((err: unknown) => {
    // The play still records; it just starts its own chain.
    console.warn(`[play-history] resume-group lookup failed for ${session.id}; recording unchained:`, err);
    return null;
  });
  if (!prior || prior.watched) return null;
  // Chain to the previous row's referenceId (already a chain root) or to the
  // row's own id (it's the root). Either way, every row in the chain shares one
  // referenceId value.
  return prior.referenceId ?? prior.id;
}

// CAS on lastSeenAt: only delete if the row hasn't been touched since the
// caller read it. Without this, a concurrent activeSession update or
// re-create from sync/play-history could be silently deleted here when
// recordCompletedSession was triggered by a stale stop signal. deleteMany
// matches 0 if the lastSeenAt timestamp shifted; in that case we leave the row
// alone (it's now part of a different playback session). A blind delete here
// could stomp a row the sync just rewrote (same `id`, new `lastSeenAt`, new
// `startedAt`) for a fresh playback, leaving the new watch with no
// ActiveSession — its trailing time and finalize then never fire.
async function deleteFinalizedSession(session: ActiveSession): Promise<void> {
  await prisma.activeSession
    .deleteMany({ where: { id: session.id, lastSeenAt: session.lastSeenAt } })
    .catch((err: unknown) => {
      // The row stays; cleanupStaleSessions finalizes it later (and the
      // history write it would repeat is deduplicated).
      console.warn(`[play-history] could not remove finalized session ${session.id}:`, err);
    });
}

// Finalize a completed ActiveSession into a PlayHistory row (with full playback
// metrics) and remove the ActiveSession. Idempotent across the concurrent
// finalize paths (SSE stop, poller stall, cleanup) via the createMany dedupe and
// lastSeenAt CAS. Short watches are dropped without a history row.
export async function recordCompletedSession(
  session: ActiveSession,
  opts: { skipSSE?: boolean; stoppedAt?: Date } = {},
): Promise<void> {
  // Take `now` once so every downstream timestamp/elapsed calc agrees on the same reference.
  const now = new Date();
  const play = measurePlay(session, now, opts.stoppedAt);

  // The short-circuit uses the same lastSeenAt CAS as the delete after a write.
  if (play.playDurationS < MIN_PLAY_DURATION_S) {
    await deleteFinalizedSession(session);
    return;
  }

  const verdict = judgePlay(session, play, await getWatchedThreshold());
  const posterPath = await cachedPosterPath(session);
  const referenceId = await resumeReferenceId(session, play.stoppedAt);
  const historyData = historyRow(session, play, verdict, posterPath, referenceId);

  // recordCompletedSession runs from three paths that can fire concurrently for the same
  // sessionKey: SSE 'stopped' notification, 5s poller stall/absence detection, and cleanupStaleSessions.
  // Prisma's upsert is SELECT-then-INSERT (not atomic) — under that race the loser hits P2002
  // even though `update: {}` already means "first writer wins". Catching P2002 in JS works but
  // still leaves a Postgres ERROR and a `prisma:error` log per collision because the INSERT
  // reaches the DB before failing. createMany({ skipDuplicates: true }) compiles to
  // INSERT ... ON CONFLICT DO NOTHING, which resolves the race inside Postgres with no error
  // emitted. Single-row createMany is the idiomatic Prisma way to express this.
  const inserted = await prisma.playHistory.createMany({
    data: [historyData],
    skipDuplicates: true,
  });
  if (inserted.count === 0) await extendEarlierRecord(historyData);

  await deleteFinalizedSession(session);

  // Invalidate cached stats so the next page load reflects the new record.
  // Callers that import many sessions in a tight loop (cron, sync) should pass
  // skipSSE=true and fire a single SSE at the loop boundary to avoid N+1
  // history-updated events triggering N refetches on every connected client.
  clearActivityCache();
  if (!opts.skipSSE) {
    emitSSE({ type: "activity:history-updated" });
    // Also push a fresh sessions snapshot. recordCompletedSession is the moment a
    // session leaves ActiveSession; the now-playing UI listens for activity:sessions
    // (history-updated only refreshes the history table). Without this emit the SSE
    // finalize paths cleared the row in the DB but the now-playing card stayed up for
    // up to 5 seconds until the next poll re-snapshotted — defeating the purpose of
    // subscribing to Plex SSE for instant stop detection.
    //
    // The play is recorded by now, so a failed snapshot read must not reject: the
    // SSE stop path would read that as a failed finalize and skip its ledger entry.
    // The next poll pushes a fresh snapshot anyway.
    await emitActiveSessionsSnapshot().catch((err: unknown) => {
      console.warn("[play-history] sessions snapshot after a finalize failed:", err);
    });
  }
}

// The PlayHistory row for a finalized session: its own columns copied through,
// the measured durations and verdicts, and the looked-up poster and chain.
function historyRow(
  session: ActiveSession,
  play: MeasuredPlay,
  verdict: ReturnType<typeof judgePlay>,
  posterPath: string | null,
  referenceId: string | null,
) {
  return {
    source: session.source,
    // Multi-server support: stamp which instance the watch happened on. The
    // ActiveSession row carries it from create (both pollers and the SSE
    // writer). PlayHistory's dedup unique key is [source, serverInstance,
    // sourceSessionId], so the same raw sessionKey on two instances can never
    // collide — and history attribution/debugging stays per-server.
    serverInstance: session.serverInstance,
    startedAt: session.startedAt,
    stoppedAt: play.stoppedAt,
    duration: verdict.durationS,
    playDuration: play.playDurationS,
    pausedDuration: verdict.pausedDurationS,
    watched: verdict.watched,
    completed: verdict.completed,
    mediaServerUserId: session.mediaServerUserId,
    tmdbId: session.tmdbId,
    // ActiveSession.mediaType is free text; the history column is the enum, and a
    // value outside it would fail the insert and lose the watch.
    mediaType: toMediaType(session.mediaType),
    title: session.title,
    year: session.year,
    posterPath,
    seasonNumber: session.seasonNumber,
    episodeNumber: session.episodeNumber,
    episodeTitle: session.episodeTitle,
    // Jellyfin (and some Plex clients) reuse PlaySessionId across distinct watches — DLNA, browser
    // tabs, and per-device session caches all reproduce it. Combining sessionKey with the playback's
    // own startedAt yields a key that's unique per watch instance while still being deterministic
    // when two finalize paths record the same watch (the createMany dedupe relies on that).
    sourceSessionId: `${session.sessionKey}:${session.startedAt.toISOString()}`,
    sourceItemId: session.sourceItemId,
    sourceShowId: session.sourceShowId ?? null,
    platform: session.platform,
    player: session.player,
    device: session.device,
    ipAddress: session.ipAddress,
    playMethod: session.playMethod,
    videoCodec: session.videoCodec,
    audioCodec: session.audioCodec,
    resolution: session.resolution,
    bitrate: session.bitrate,
    videoDecision: session.videoDecision,
    audioDecision: session.audioDecision,
    container: session.container,
    transcodeReason: session.transcodeReason,
    location: session.location,
    bandwidth: session.bandwidth,
    secure: session.secure,
    relayed: session.relayed,
    introStartMs: session.introStartMs,
    introEndMs: session.introEndMs,
    creditsStartMs: session.creditsStartMs,
    creditsEndMs: session.creditsEndMs,
    referenceId,
  };
}

// The watch was already recorded. That is usually a concurrent finalize of the
// same sitting, but it can be an EARLY one: a stale-session cleanup that wrote
// the row while the stream was still going (the poller then bumped lastSeenAt,
// so the CAS delete kept the session alive). The same sitting's later, longer
// finalize lands here with the same key, so it extends the stored row instead
// of being dropped. The CAS on playDuration keeps the longest record and never
// shortens one; the row stays the only one for the watch (guardrail 19).
async function extendEarlierRecord(row: ReturnType<typeof historyRow>): Promise<void> {
  await prisma.playHistory.updateMany({
    where: {
      source: row.source,
      serverInstance: row.serverInstance,
      sourceSessionId: row.sourceSessionId,
      playDuration: { lt: row.playDuration },
    },
    data: {
      stoppedAt: row.stoppedAt,
      duration: row.duration,
      playDuration: row.playDuration,
      pausedDuration: row.pausedDuration,
      watched: row.watched,
      completed: row.completed,
    },
  });
}

// In-memory once-guard, memoized as a promise so CONCURRENT boot callers (the
// SSE bootstrap and the 5s poller can race on the first tick) all await the
// SAME updateMany instead of a boolean letting the second caller proceed
// against un-re-anchored rows before the write commits. Resets on process
// restart — which is exactly when we want to re-anchor again.
// Process-wide (guardrail 27a): this module is compiled into the boot chunk (via
// plex-events) AND the poller's route chunk. A per-chunk memo let a chunk's
// first call — an SSE manager first connecting hours after boot — re-stamp
// every ActiveSession row mid-day, pushing back real absence finalizes.
const reanchorMemo = processSingleton<{ promise: Promise<void> | null }>(
  "play-history:reanchorPromise",
  () => ({ promise: null }),
);

// On the FIRST reconcile after this process started, bump lastSeenAt = now for
// every ActiveSession row so the absence grace (SESSION_ABSENCE_GRACE_MS) and
// cleanupStaleSessions are measured from boot, not from the last poll before
// the process went down.
//
// Why: lastSeenAt is the "we last saw this session live" anchor for all three
// finalize paths — the SSE bootstrap reconcile, the 5s poller's stale sweep,
// and cleanupStaleSessions. After a restart (Docker upgrade, host reboot) the
// poller and SSE were down for the entire outage, so every row's lastSeenAt is
// stale by the downtime and the >=60s grace becomes trivially true. A single
// transient absence at boot — Plex still spinning up, an incomplete
// /status/sessions, or a Plex-side sessionKey reset — then finalizes AND
// ledger-locks a session that's actually still playing, and the now-playing
// card never returns. Re-anchoring restores the grace: an ongoing session that
// is present in the snapshot keeps getting bumped and is never killed; a
// session that genuinely ended during the outage is finalized ~60s after boot
// once it's been confirmed absent across real post-boot observations.
//
// Idempotent per process; safe to call from both the SSE bootstrap and the
// poller (whichever runs first wins — the loser awaits the same in-flight
// write). On failure the memo is released so the next caller retries rather
// than leaving sessions exposed to the stale-anchor finalize.
/**
 * Returns whether every row now carries a post-boot `lastSeenAt`.
 *
 * Callers MUST skip their absence sweep on false. The whole point of the
 * re-anchor (guardrail 21) is that after a restart every row's `lastSeenAt` is
 * stale by the downtime, so the 60s absence grace is trivially satisfied and a
 * single transient gap finalizes — and ledger-locks — a session that is still
 * playing. If the re-anchor did not run, sweeping measures the grace off exactly
 * the pre-restart timestamps it exists to replace.
 *
 * It reports rather than throws on purpose: both callers invoke this before the
 * rest of their work, and a throw would take out far more than the sweep — the
 * poller would 500 its whole tick before either source loop ran, and the SSE
 * bootstrap would abort the connect so the stream never opened at all.
 */
export async function reanchorActiveSessionsOnBoot(): Promise<boolean> {
  const inFlight = (reanchorMemo.promise ??= prisma.activeSession
    .updateMany({ data: { lastSeenAt: new Date() } })
    .then(() => undefined));
  try {
    await inFlight;
    return true;
  } catch (err) {
    // Only clear our own promise — a later caller may have already memoized a retry.
    if (reanchorMemo.promise === inFlight) reanchorMemo.promise = null;
    console.warn("[play-history] boot re-anchor of ActiveSession.lastSeenAt failed:", err);
    return false;
  }
}

// Finalizes in flight at once for a batch of ended sessions — below the max:5
// pool, which the poller's other per-session work shares (guardrail 31).
export const STALE_FINALIZE_CONCURRENCY = 3;

// Safety net beneath the absence grace: finalize any ActiveSession whose
// lastSeenAt is older than maxAgeMinutes (no final tick — a stale row has no
// signal it was still playing).
export async function cleanupStaleSessions(maxAgeMinutes: number): Promise<void> {
  const cutoff = new Date(Date.now() - maxAgeMinutes * 60 * 1000);
  const stale = await prisma.activeSession.findMany({
    where: { lastSeenAt: { lt: cutoff } },
  });

  // No final tick: a stale session has no signal it was still playing — capping wall-clock from
  // lastSeenAt would falsely inflate playtimeMs by up to MAX_PLAYTIME_DELTA_MS for an abandoned watch.
  // Settled so one failure doesn't abort the rest, and failures surface as a warn. Bounded
  // (guardrail 31): each finalize runs ~4 queries on the max:5 pool, and a media-server
  // outage of 30+ minutes ages every active session into this one batch.
  const results = await settleLimit(
    stale,
    STALE_FINALIZE_CONCURRENCY,
    // Skip per-session SSE; cron callers fire a single activity:history-updated
    // at the loop boundary so connected clients don't refetch N times per run.
    (session) => recordCompletedSession(session, { skipSSE: true }),
  );
  // If anything actually finalized, emit one SSE for the whole batch.
  if (results.some((r) => r.status === "fulfilled")) {
    emitSSE({ type: "activity:history-updated" });
  }
  for (const r of results) {
    if (r.status === "rejected") {
      console.warn("[play-history] cleanupStaleSessions: recordCompletedSession failed:", r.reason);
    }
  }
}

// Rows per retention DELETE, and DELETEs per call. Turning retention on over a
// long history used to delete everything past the cutoff in ONE statement — a
// long transaction and a WAL burst inside the 5s poller's tick. Bounded batches
// keep each statement short; a backlog past one call's budget is finished by the
// next hourly run (rows past the cutoff are never evidence anyway, 14d).
export const PURGE_BATCH_SIZE = 5_000;
export const PURGE_MAX_BATCHES = 40;

// Delete PlayHistory rows older than the configured retention window (no-op when
// retention is unset/0). Returns the number of rows deleted. The cutoff is
// getRetentionCutoff's, so the purge and the never-watched window can't disagree.
export async function purgeOldHistory(): Promise<number> {
  const cutoff = await getRetentionCutoff(new Date(Date.now()));
  if (!cutoff) return 0;
  let purged = 0;
  for (let batch = 0; batch < PURGE_MAX_BATCHES; batch++) {
    const ids = await prisma.playHistory.findMany({
      where: { startedAt: { lt: cutoff } },
      select: { id: true },
      take: PURGE_BATCH_SIZE,
    });
    if (ids.length === 0) break;
    const result = await prisma.playHistory.deleteMany({
      // The cutoff again, so a row can only ever go for being past it.
      where: { startedAt: { lt: cutoff }, id: { in: ids.map((r) => r.id) } },
    });
    purged += result.count;
    if (ids.length < PURGE_BATCH_SIZE) break;
  }
  // The memoized aggregates (and /popular) were computed over the deleted rows.
  if (purged > 0) clearActivityCache();
  return purged;
}
