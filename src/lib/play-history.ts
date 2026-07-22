import { prisma } from "./prisma";
import { emitSSE } from "./sse-emitter";
import { sanitizeForLog } from "./sanitize";
import { normalizeEmail } from "./email-normalize";
import { posterUrl } from "./tmdb-types";
import type { ActiveSession, MediaType } from "@/generated/prisma";

// Postgres GROUP BY day omits zero-play days; the AreaChart needs an entry per
// day in the window so gaps render as 0 instead of collapsing the x-axis.
function padDailySeries<T extends { day: string }>(
  rows: T[],
  daysBack: number,
  fill: (day: string) => T,
): T[] {
  const byDay = new Map(rows.map((r) => [r.day, r]));
  const out: T[] = [];
  const today = new Date();
  today.setUTCHours(0, 0, 0, 0);
  for (let i = daysBack - 1; i >= 0; i--) {
    const d = new Date(today.getTime() - i * 24 * 60 * 60 * 1000);
    const key = d.toISOString().slice(0, 10);
    out.push(byDay.get(key) ?? fill(key));
  }
  return out;
}

const SETTING_KEYS = [
  "playHistoryEnabled",
  "playHistoryPlexEnabled",
  "playHistoryJellyfinEnabled",
  "playHistoryWatchedThreshold",
  "playHistoryCompletionThreshold",
  "playHistoryArcGapDays",
  "playHistoryRetentionDays",
] as const;
type SettingKey = (typeof SETTING_KEYS)[number];

const SETTINGS_CACHE_TTL = 15_000;
let settingsCache: { values: Record<SettingKey, string | null>; expiresAt: number } | null = null;
let settingsInflight: Promise<Record<SettingKey, string | null>> | null = null;

async function loadSettings(): Promise<Record<SettingKey, string | null>> {
  if (settingsCache && settingsCache.expiresAt > Date.now()) return settingsCache.values;
  if (settingsInflight) return settingsInflight;
  settingsInflight = (async () => {
    const rows = await prisma.setting.findMany({
      where: { key: { in: SETTING_KEYS as unknown as string[] } },
      select: { key: true, value: true },
    });
    const values = Object.fromEntries(SETTING_KEYS.map((k) => [k, null])) as Record<SettingKey, string | null>;
    for (const row of rows) {
      if ((SETTING_KEYS as readonly string[]).includes(row.key)) {
        values[row.key as SettingKey] = row.value ?? null;
      }
    }
    settingsCache = { values, expiresAt: Date.now() + SETTINGS_CACHE_TTL };
    return values;
  })();
  try {
    return await settingsInflight;
  } finally {
    settingsInflight = null;
  }
}

const activityCache = new Map<string, { data: unknown; expiresAt: number }>();
const STATS_TTL = 5 * 60 * 1000;
const CALENDAR_TTL = 30 * 60 * 1000;
const REWATCHED_TTL = 10 * 60 * 1000;

export async function isPlayHistoryEnabled(): Promise<boolean> {
  return (await loadSettings()).playHistoryEnabled === "true";
}

export async function isSourceEnabled(source: "plex" | "jellyfin"): Promise<boolean> {
  const settings = await loadSettings();
  const val = source === "plex" ? settings.playHistoryPlexEnabled : settings.playHistoryJellyfinEnabled;
  return val === "true";
}

export async function getWatchedThreshold(): Promise<number> {
  const val = (await loadSettings()).playHistoryWatchedThreshold;
  const parsed = val ? parseInt(val, 10) : NaN;
  return Number.isFinite(parsed) && parsed >= 0 && parsed <= 100 ? parsed : 80;
}

// Cumulative-watch threshold for an arc to count as a completion in getMostPopularOnServer.
// Stricter than getWatchedThreshold (per-session) — a "completion" should mean they basically finished it.
export async function getCompletionThreshold(): Promise<number> {
  const val = (await loadSettings()).playHistoryCompletionThreshold;
  const parsed = val ? parseInt(val, 10) : NaN;
  return Number.isFinite(parsed) && parsed >= 0 && parsed <= 100 ? parsed : 90;
}

// Gap (days) between consecutive sessions on the same media that splits one arc from the next.
// A weekend chunked watch stays one arc; a months-later rewatch starts a new arc.
export async function getArcGapDays(): Promise<number> {
  const val = (await loadSettings()).playHistoryArcGapDays;
  const parsed = val ? parseInt(val, 10) : NaN;
  return Number.isFinite(parsed) && parsed >= 1 && parsed <= 365 ? parsed : 14;
}

// Map a source-native show key (Plex ratingKey / Jellyfin itemId) to its tmdbId
// via the cached library tables. Returns null when unmapped or the key is empty.
export async function resolveShowTmdbId(
  source: "plex" | "jellyfin",
  showKey: string | null | undefined,
): Promise<number | null> {
  if (!showKey) return null;
  if (source === "plex") {
    const item = await prisma.plexLibraryItem.findFirst({
      where: { plexRatingKey: showKey, mediaType: "TV" },
      select: { tmdbId: true },
    });
    return item?.tmdbId ?? null;
  }
  const item = await prisma.jellyfinLibraryItem.findFirst({
    where: { jellyfinItemId: showKey, mediaType: "TV" },
    select: { tmdbId: true },
  });
  return item?.tmdbId ?? null;
}

// Thrown by resolveMediaServerUser when a caller passes a serverMachineId that doesn't match the
// machineId previously bound to a (source, sourceUserId) row — defense-in-depth against a payload
// from a different server impersonating an already-pinned (source, sourceUserId). Currently DORMANT:
// the sole caller (the play-history poller) is trusted and does not pass serverMachineId, and the
// Plex/Jellyfin webhook routes that once fed an untrusted machineId here were removed. Retained as
// scaffolding — reactivate by passing serverMachineId from a future untrusted ingestion path (NOT
// the poller, which would false-trip on a legitimate server migration).
export class MediaServerMismatchError extends Error {
  // Explicit fields (not constructor parameter properties) so the module loads
  // under Node's strip-only TS mode — the unit suite imports it.
  public readonly source: string;
  public readonly sourceUserId: string;
  constructor(source: string, sourceUserId: string) {
    super(`MediaServerUser ${source}:${sourceUserId} bound to a different server`);
    this.name = "MediaServerMismatchError";
    this.source = source;
    this.sourceUserId = sourceUserId;
  }
}

// FNV-1a 32-bit hash. Stable across runs; used to derive a Postgres advisory
// lock id from a string key.
function fnv1a32(s: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

// Upsert the MediaServerUser for a (source, sourceUserId) and link it to a local
// User by normalized email, serialized under an advisory lock. Returns the row id.
export async function resolveMediaServerUser(params: {
  source: string;
  sourceUserId: string;
  username: string;
  email?: string | null;
  thumbUrl?: string | null;
  serverMachineId?: string | null;
  isServerAdmin?: boolean;
}): Promise<string> {
  const { source, sourceUserId, username, thumbUrl, serverMachineId, isServerAdmin } = params;
  // Normalize once and use the same value for both lookup AND the upserted column,
  // so existing User rows (lowercase-stored) match Plex/Jellyfin server-reported
  // emails that vary in case, and so we don't write mixed-case copies into
  // MediaServerUser.email that won't round-trip the User lookup later.
  const email = params.email ? normalizeEmail(params.email) : null;

  // Serialize concurrent calls for the same MediaServerUser via an advisory
  // lock keyed on (source, sourceUserId). Two parallel webhook + sync paths
  // for the same playback otherwise hit a find→upsert TOCTOU where a
  // freshly-created User row falls into the gap and the MediaServerUser is
  // bound to no User. The User lookup is re-done INSIDE the lock so a
  // concurrent User.create is picked up.
  //
  // Mask to 31 bits (signed int32 positive range) so Postgres reads the value
  // as `int` and matches the pg_advisory_xact_lock(int, int) overload — there
  // is no (int, bigint) overload, so an unmasked uint32 > 2^31 fails with
  // "function pg_advisory_xact_lock(integer, bigint) does not exist". The
  // 1-bit entropy loss is acceptable: collisions across distinct
  // (source, sourceUserId) pairs serialize unrelated upserts on the same
  // lock — a tiny throughput cost, not a correctness issue.
  const lockKey = fnv1a32(`mediaServerUser:${source}:${sourceUserId}`) & 0x7fffffff;

  return prisma.$transaction(async (tx) => {
    await tx.$executeRawUnsafe(`SELECT pg_advisory_xact_lock(2020, ${lockKey})`);

    let userId: string | null = null;
    if (email) {
      const user = await tx.user.findUnique({ where: { email }, select: { id: true, mediaServer: true, deactivatedAt: true } });
      // Never relink play history to a deactivated account. A deleted user's email
      // is rewritten to deleted-<id>@deleted.invalid so it can't match here, but an
      // admin-deactivated (not deleted) account keeps its email — without this guard
      // the poller would attribute fresh watches to that dead account.
      if (user && !user.deactivatedAt && (!user.mediaServer || user.mediaServer.toLowerCase() === source.toLowerCase())) {
        userId = user.id;
      }
    }

    // Defense-in-depth server-binding check: once a (source, sourceUserId) row has
    // been pinned to a specific server (serverMachineId recorded), refuse any later
    // upsert that arrives carrying a DIFFERENT machineId. Without this, a caller who
    // has obtained the webhook secret could submit events stamped with their own
    // server's machineId for a (source, sourceUserId) that already belongs to the
    // operator's server, hijacking that identity and attributing play history (or a
    // user linkage) to a server they control. Pinning the first-seen machineId and
    // rejecting mismatches keeps each media-server user bound to the one server that
    // originally established it.
    if (serverMachineId) {
      const existing = await tx.mediaServerUser.findUnique({
        where: { source_sourceUserId: { source, sourceUserId } },
        select: { id: true, serverMachineId: true },
      });
      if (existing?.serverMachineId && existing.serverMachineId !== serverMachineId) {
        console.warn(
          `[play-history] refusing MediaServerUser upsert: source=${sanitizeForLog(source)} sourceUserId=${sanitizeForLog(sourceUserId)} bound to a different server`,
        );
        throw new MediaServerMismatchError(source, sourceUserId);
      }
    }

    const record = await tx.mediaServerUser.upsert({
      where: { source_sourceUserId: { source, sourceUserId } },
      create: {
        source,
        sourceUserId,
        username,
        email: email ?? null,
        thumbUrl: thumbUrl ?? null,
        userId,
        serverMachineId: serverMachineId ?? null,
        ...(isServerAdmin !== undefined ? { isServerAdmin } : {}),
      },
      update: {
        username,
        ...(email ? { email } : {}),
        ...(thumbUrl ? { thumbUrl } : {}),
        ...(userId ? { userId } : {}),
        ...(serverMachineId ? { serverMachineId } : {}),
        // Set-only on existing rows: a transient mismatch between the admin
        // token's plex user id and the row we're upserting (e.g. token
        // rotation, OIDC-linked admin re-key, multi-user server with the
        // admin signed in from a fresh client) must NEVER demote
        // isServerAdmin true→false. Only ever upgrade false→true here.
        ...(isServerAdmin === true ? { isServerAdmin: true } : {}),
      },
      select: { id: true },
    });

    return record.id;
  }, { timeout: 15_000 });
}

export function calculateWatched(
  playDurationMs: number,
  totalDurationMs: number,
  thresholdPercent: number,
): boolean {
  if (totalDurationMs <= 0) return false;
  return (playDurationMs / totalDurationMs) * 100 >= thresholdPercent;
}

const EXCLUDED_USERNAMES = new Set<string>();
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
// few seconds when the user "stops at the credits," and the natural endpoint
// of natural-end playback is rarely exactly duration. Without the clamp,
// sessions that effectively reached the end get classed as 99% completionRatio
// (not completed) and slide just below the 80% watched threshold for media
// where the credits roll consumes the tail. Tautulli uses the same 10 s window
// (activity_handler.py:122-126).
const END_OF_FILE_CLAMP_MS = 10_000;
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
// (webhook stop, polling-sync-detected end) use this so the trailing playtime between lastSeenAt
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

// Finalize a completed ActiveSession into a PlayHistory row (with full playback
// metrics) and remove the ActiveSession. Idempotent across the concurrent
// finalize paths (SSE stop, poller stall, cleanup) via the createMany dedupe and
// lastSeenAt CAS. Short/excluded watches are dropped without a history row.
export async function recordCompletedSession(
  session: ActiveSession,
  opts: { skipSSE?: boolean; stoppedAt?: Date } = {},
): Promise<void> {
  // Take `now` once so every downstream timestamp/elapsed calc agrees on the same reference.
  const now = new Date();

  // The polling sync may leave playtimeMs at zero for short watches that disappear between
  // two 5s ticks, and pre-stop pauses can leave state="paused" so applyFinalTick contributes
  // 0. progressMs (playhead at stop) is always populated, so falling back to it covers those
  // gaps. BUT progressMs is the playhead POSITION in the file, not elapsed wall-clock time:
  // a user who seeks to the credits and quits at five seconds has progressMs ≈ totalDuration
  // even though they only watched five seconds. Cap by the actual wall-clock window so the
  // fallback can't credit more time than physically elapsed.
  const stoppedAt =
    opts.stoppedAt ?? (session.lastSeenAt > session.startedAt ? session.lastSeenAt : now);
  const wallElapsedMs = Math.max(0, stoppedAt.getTime() - session.startedAt.getTime());

  // End-of-file clamp: a session that ended within END_OF_FILE_CLAMP_MS of
  // the media's runtime is treated as completed at exactly durationMs. Some
  // clients stop at credits with a stale viewOffset; without this, the
  // PlayHistory row records progressMs = duration − 4 s, completionRatio
  // ≈ 99.7%, completed = false. Tautulli applies the same 10 s clamp at
  // activity_handler.py:122-126.
  const rawProgressMs = Number(session.progressMs);
  const totalDurationMsRaw = Number(session.durationMs);
  const clampedProgressMs =
    totalDurationMsRaw > 0 && rawProgressMs >= totalDurationMsRaw - END_OF_FILE_CLAMP_MS
      ? totalDurationMsRaw
      : rawProgressMs;

  const cappedProgressMs = Math.min(clampedProgressMs, wallElapsedMs);
  const playDurationMs = Math.max(Number(session.playtimeMs), cappedProgressMs);
  const playDurationS = Math.max(0, Math.floor(playDurationMs / 1000));

  // Both short-circuits use the same lastSeenAt CAS the post-transaction
  // delete below uses. A blind delete here can stomp a row the
  // sync just rewrote (same `id`, new `lastSeenAt`, new `startedAt`) for a
  // fresh playback, leaving the new watch with no ActiveSession — its
  // trailing time and finalize then never fire.
  if (EXCLUDED_USERNAMES.has(session.serverUsername)) {
    await prisma.activeSession
      .deleteMany({ where: { id: session.id, lastSeenAt: session.lastSeenAt } })
      .catch(() => {});
    return;
  }
  if (playDurationS < MIN_PLAY_DURATION_S) {
    await prisma.activeSession
      .deleteMany({ where: { id: session.id, lastSeenAt: session.lastSeenAt } })
      .catch(() => {});
    return;
  }

  const threshold = await getWatchedThreshold();

  // For watched / completed evaluation, treat "effective content end" as the
  // credits start when we have a marker — Plex players commonly stop at the
  // credits roll with progressMs just shy of duration, and a media that ran
  // 50 min of content + 5 min of credits should mark watched at the credits
  // boundary, not at 80% of the credit-inclusive 55 min total. Falls back to
  // the file duration when no marker exists.
  const totalDurationMs = totalDurationMsRaw;
  const effectiveDurationMs =
    session.creditsStartMs != null && session.creditsStartMs > 0 && session.creditsStartMs <= totalDurationMs
      ? session.creditsStartMs
      : totalDurationMs;
  const watched = calculateWatched(playDurationMs, effectiveDurationMs, threshold);

  // `now` and `stoppedAt` were already established at the top so the cap on
  // cappedProgressMs and the historyData.stoppedAt agree on the same instant.
  const totalElapsedS = Math.max(0, Math.floor((stoppedAt.getTime() - session.startedAt.getTime()) / 1000));
  const durationS = Math.max(0, Math.floor(totalDurationMs / 1000));
  const pausedDurationS = Math.max(0, totalElapsedS - playDurationS);

  const progressMs = clampedProgressMs;
  // completionRatio uses effectiveDurationMs (credits-aware) for the same
  // reason as watched — reaching the credits is "completed."
  const completionRatio = effectiveDurationMs > 0 ? progressMs / effectiveDurationMs : 0;

  const completed = completionRatio >= 0.95;

  let posterPath: string | null = null;
  if (session.tmdbId && session.mediaType) {
    const cacheKey = `${session.mediaType === "TV" ? "tv" : "movie"}:${session.tmdbId}:details`;
    const cacheRow = await prisma.tmdbCache.findUnique({ where: { key: cacheKey }, select: { data: true } }).catch(() => null);
    if (cacheRow) {
      try {
        const parsed = JSON.parse(cacheRow.data) as { posterPath?: string | null };
        posterPath = parsed.posterPath ?? null;
      } catch { }
    }
  }

  // Jellyfin (and some Plex clients) reuse PlaySessionId across distinct watches — DLNA, browser
  // tabs, and per-device session caches all reproduce it. Combining sessionKey with the playback's
  // own startedAt yields a key that's unique per watch instance while still being deterministic
  // across webhook replays of the same Stop event.
  const uniqueSourceSessionId = `${session.sessionKey}:${session.startedAt.toISOString()}`;

  // Resume-grouping: link this row into a chain when a previous unwatched
  // PlayHistory row exists for the same (user, source-item) within the last
  // 7 days. The chain root self-references — every row in a chain shares the
  // referenceId of the first row, so the UI can `GROUP BY referenceId` to
  // collapse split watches ("paused on Monday, finished on Tuesday") into
  // one logical viewing without recursive walks. We only look back from
  // *unwatched* prior plays — once a chain reaches the watched threshold, the
  // next play is a rewatch and starts its own chain.
  let referenceId: string | null = null;
  if (session.sourceItemId) {
    const lookbackCutoff = new Date(stoppedAt.getTime() - RESUME_GROUPING_LOOKBACK_MS);
    const priorUnwatched = await prisma.playHistory.findFirst({
      where: {
        source: session.source,
        sourceItemId: session.sourceItemId,
        mediaServerUserId: session.mediaServerUserId,
        watched: false,
        startedAt: { gte: lookbackCutoff, lt: session.startedAt },
      },
      orderBy: { startedAt: "desc" },
      select: { id: true, referenceId: true },
    }).catch(() => null);
    if (priorUnwatched) {
      // Chain to the previous row's referenceId (already a chain root) or to
      // the row's own id (it's the root). Either way, every row in the chain
      // shares one referenceId value.
      referenceId = priorUnwatched.referenceId ?? priorUnwatched.id;
    }
  }

  const historyData = {
    source: session.source,
    startedAt: session.startedAt,
    stoppedAt,
    duration: durationS,
    playDuration: playDurationS,
    pausedDuration: pausedDurationS,
    watched,
    completed,
    mediaServerUserId: session.mediaServerUserId,
    tmdbId: session.tmdbId,
    mediaType: session.mediaType as MediaType | null,
    title: session.title,
    year: session.year,
    posterPath,
    seasonNumber: session.seasonNumber,
    episodeNumber: session.episodeNumber,
    episodeTitle: session.episodeTitle,
    sourceSessionId: uniqueSourceSessionId,
    sourceItemId: session.sourceItemId,
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

  // recordCompletedSession runs from three paths that can fire concurrently for the same
  // sessionKey: SSE 'stopped' notification, 5s poller stall detection, and webhook handlers.
  // Prisma's upsert is SELECT-then-INSERT (not atomic) — under that race the loser hits P2002
  // even though `update: {}` already means "first writer wins". Catching P2002 in JS works but
  // still leaves a Postgres ERROR and a `prisma:error` log per collision because the INSERT
  // reaches the DB before failing. createMany({ skipDuplicates: true }) compiles to
  // INSERT ... ON CONFLICT DO NOTHING, which resolves the race inside Postgres with no error
  // emitted. Single-row createMany is the idiomatic Prisma way to express this.
  await prisma.playHistory.createMany({
    data: [historyData],
    skipDuplicates: true,
  });

  // CAS on lastSeenAt: only delete if the row hasn't been touched since the
  // caller read it. Without this, a concurrent activeSession update or
  // re-create from sync/play-history could be silently deleted here when
  // recordCompletedSession was triggered by a stale Stop webhook.
  // deleteMany returns 0 if the lastSeenAt timestamp shifted; in that case
  // we leave the row alone (it's now part of a different playback session).
  await prisma.activeSession.deleteMany({
    where: { id: session.id, lastSeenAt: session.lastSeenAt },
  }).catch(() => {});

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
    await emitActiveSessionsSnapshot();
  }
}

// Build an activity:sessions SSE payload from current ActiveSession rows and emit it.
// Used after SSE-driven finalize (plex-events) to push an immediate now-playing update,
// and reused by the 5s poll route so the wire format stays in one place.
export async function emitActiveSessionsSnapshot(): Promise<void> {
  const allSessions = await prisma.activeSession.findMany({
    // Secondary key `id` (immutable PK) breaks startedAt ties deterministically.
    // Sessions that first appear in the same 5s poll share an identical
    // startedAt (the poll stamps one `now` across all creates), and with no
    // tiebreaker Postgres returns the tied rows in heap order — which the
    // per-poll UPDATEs reshuffle, making the now-playing cards swap places.
    orderBy: [{ startedAt: "desc" }, { id: "asc" }],
    select: {
      id: true,
      source: true,
      state: true,
      mediaServerUserId: true,
      serverUsername: true,
      title: true,
      tmdbId: true,
      mediaType: true,
      year: true,
      seasonNumber: true,
      episodeNumber: true,
      episodeTitle: true,
      progressPercent: true,
      progressMs: true,
      durationMs: true,
      platform: true,
      player: true,
      device: true,
      ipAddress: true,
      startedAt: true,
      playMethod: true,
      videoCodec: true,
      audioCodec: true,
      resolution: true,
      bitrate: true,
      videoDecision: true,
      audioDecision: true,
      container: true,
      location: true,
      bandwidth: true,
      secure: true,
      relayed: true,
      introStartMs: true,
      introEndMs: true,
      creditsStartMs: true,
      creditsEndMs: true,
    },
  });

  const sessionPosterMap: Record<number, string | null> = {};
  const tmdbIds = [...new Set(allSessions.map((s) => s.tmdbId).filter((id): id is number => id != null))];
  if (tmdbIds.length > 0) {
    const cacheKeys = tmdbIds.flatMap((id) => [`movie:${id}:details`, `tv:${id}:details`]);
    const cacheRows = await prisma.tmdbCache.findMany({
      where: { key: { in: cacheKeys } },
      select: { key: true, data: true },
    });
    for (const row of cacheRows) {
      try {
        const parsed = JSON.parse(row.data) as { posterPath?: string | null };
        if (parsed.posterPath) {
          const id = parseInt(row.key.split(":")[1] ?? "", 10);
          if (Number.isFinite(id) && id > 0 && !sessionPosterMap[id]) {
            sessionPosterMap[id] = posterUrl(parsed.posterPath, "w342");
          }
        }
      } catch { }
    }
  }

  emitSSE({
    type: "activity:sessions",
    sessions: allSessions.map((s) => ({
      id: s.id,
      source: s.source,
      state: s.state,
      mediaServerUserId: s.mediaServerUserId,
      serverUsername: s.serverUsername,
      title: s.title,
      tmdbId: s.tmdbId,
      mediaType: s.mediaType,
      year: s.year,
      seasonNumber: s.seasonNumber,
      episodeNumber: s.episodeNumber,
      episodeTitle: s.episodeTitle,
      progressPercent: s.progressPercent,
      progressMs: Number(s.progressMs),
      durationMs: Number(s.durationMs),
      platform: s.platform,
      player: s.player,
      device: s.device,
      ipAddress: s.ipAddress,
      startedAt: s.startedAt.toISOString(),
      playMethod: s.playMethod,
      videoCodec: s.videoCodec,
      audioCodec: s.audioCodec,
      resolution: s.resolution,
      bitrate: s.bitrate,
      videoDecision: s.videoDecision,
      audioDecision: s.audioDecision,
      container: s.container,
      location: s.location,
      bandwidth: s.bandwidth,
      secure: s.secure,
      relayed: s.relayed,
      introStartMs: s.introStartMs,
      introEndMs: s.introEndMs,
      creditsStartMs: s.creditsStartMs,
      creditsEndMs: s.creditsEndMs,
      posterUrl: s.tmdbId ? sessionPosterMap[s.tmdbId] ?? null : null,
    })),
  });
}

// In-memory once-guard, memoized as a promise so CONCURRENT boot callers (the
// SSE bootstrap and the 5s poller can race on the first tick) all await the
// SAME updateMany instead of a boolean letting the second caller proceed
// against un-re-anchored rows before the write commits. Resets on process
// restart — which is exactly when we want to re-anchor again.
let reanchorPromise: Promise<void> | null = null;

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
export async function reanchorActiveSessionsOnBoot(): Promise<void> {
  const inFlight = (reanchorPromise ??= prisma.activeSession
    .updateMany({ data: { lastSeenAt: new Date() } })
    .then(() => undefined));
  try {
    await inFlight;
  } catch (err) {
    // Only clear our own promise — a later caller may have already memoized a retry.
    if (reanchorPromise === inFlight) reanchorPromise = null;
    console.warn("[play-history] boot re-anchor of ActiveSession.lastSeenAt failed:", err);
  }
}

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
  // Parallelized with allSettled so one failure doesn't abort the rest, and previously-silent
  // failures now surface as a single warn.
  const results = await Promise.allSettled(
    // Skip per-session SSE; cron callers fire a single activity:history-updated
    // at the loop boundary so connected clients don't refetch N times per run.
    stale.map((session) => recordCompletedSession(session, { skipSSE: true })),
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

// Delete PlayHistory rows older than the configured retention window (no-op when
// retention is unset/0). Returns the number of rows deleted.
export async function purgeOldHistory(): Promise<number> {
  const val = (await loadSettings()).playHistoryRetentionDays;
  const days = val ? parseInt(val, 10) : 0;
  if (!days || days <= 0) return 0;

  const cutoff = new Date(Date.now() - days * 24 * 60 * 60 * 1000);
  const result = await prisma.playHistory.deleteMany({
    where: { startedAt: { lt: cutoff } },
  });
  return result.count;
}

// Aggregate the full per-user stats bundle (totals, recent plays, top media,
// daily/heatmap series, codec/resolution/device breakdowns) for one MediaServerUser.
export async function getUserPlayStats(mediaServerUserId: string) {
  const ninetyDaysAgo = new Date(Date.now() - 90 * 24 * 60 * 60 * 1000);
  const oneYearAgo = new Date(Date.now() - 365 * 24 * 60 * 60 * 1000);

  const [
    totalPlays,
    totalWatchTime,
    recentPlays,
    topMedia,
    playsByDay,
    platformBreakdown,
    activityCalendar,
    avgSessionDurationRaw,
    transcodeRatioRaw,
    resolutionBreakdownRaw,
    userHeatmapRaw,
    deviceListRaw,
  ] = await Promise.all([
    // "plays" surfaces filter watched=true (sessions that crossed the configured threshold).
    // Raw counts are reserved for technical/resource analytics (codec, transcode, bitrate, avg session).
    prisma.playHistory.count({ where: { mediaServerUserId, watched: true } }),
    prisma.$queryRawUnsafe<{ hours: number | null }[]>(
      `SELECT (COALESCE(SUM("playDuration"), 0) / 3600.0)::float8 AS hours FROM "PlayHistory" WHERE "mediaServerUserId" = $1`,
      mediaServerUserId,
    ),
    prisma.playHistory.findMany({
      where: { mediaServerUserId },
      orderBy: { startedAt: "desc" },
      take: 50,
    }),
    // Group by tmdbId (cross-source dedupe — Plex + Jellyfin entries for the
    // same show collapse) with title fallback for unmapped rows. See bug #7
    // notes: previously the GROUP BY also keyed on title, so the same show
    // appeared twice when one source resolved tmdbId and the other didn't.
    prisma.$queryRawUnsafe<{ title: string; tmdbId: number | null; mediaType: string | null; posterPath: string | null; count: bigint }[]>(
      `SELECT MAX("title") AS title, "tmdbId", MAX("mediaType"::text) AS "mediaType", MAX("posterPath") AS "posterPath", COUNT(*)::bigint AS count
       FROM "PlayHistory" WHERE "mediaServerUserId" = $1 AND "watched" = true
       GROUP BY "tmdbId", CASE WHEN "tmdbId" IS NULL THEN LOWER("title") ELSE NULL END
       ORDER BY count DESC LIMIT 10`,
      mediaServerUserId,
    ),
    prisma.$queryRawUnsafe<{ day: string; count: bigint; hours: number }[]>(
      `SELECT to_char(date_trunc('day', "startedAt"), 'YYYY-MM-DD') AS day,
              COUNT(*) FILTER (WHERE "watched" = true)::bigint AS count,
              (COALESCE(SUM("playDuration"), 0) / 3600.0)::float8 AS hours
       FROM "PlayHistory"
       WHERE "mediaServerUserId" = $1 AND "startedAt" >= $2
       GROUP BY day ORDER BY day`,
      mediaServerUserId,
      ninetyDaysAgo,
    ),
    prisma.$queryRawUnsafe<{ platform: string | null; count: bigint }[]>(
      `SELECT "platform", COUNT(*)::bigint AS count
       FROM "PlayHistory" WHERE "mediaServerUserId" = $1 AND "watched" = true
       GROUP BY "platform" ORDER BY count DESC`,
      mediaServerUserId,
    ),
    prisma.$queryRawUnsafe<{ day: string; count: bigint }[]>(
      `SELECT to_char(date_trunc('day', "startedAt"), 'YYYY-MM-DD') AS day,
              COUNT(*)::bigint AS count
       FROM "PlayHistory"
       WHERE "mediaServerUserId" = $1 AND "watched" = true AND "startedAt" >= $2
       GROUP BY day ORDER BY day`,
      mediaServerUserId,
      oneYearAgo,
    ),
    prisma.$queryRawUnsafe<{ avg_secs: number | null }[]>(
      `SELECT AVG("playDuration")::float8 AS avg_secs FROM "PlayHistory" WHERE "mediaServerUserId" = $1`,
      mediaServerUserId,
    ),
    prisma.$queryRawUnsafe<{ method: string | null; count: bigint }[]>(
      `SELECT "playMethod" AS method, COUNT(*)::bigint AS count
       FROM "PlayHistory" WHERE "mediaServerUserId" = $1
       GROUP BY "playMethod" ORDER BY count DESC`,
      mediaServerUserId,
    ),
    prisma.$queryRawUnsafe<{ resolution: string | null; count: bigint }[]>(
      `SELECT ${RESOLUTION_BUCKET_SQL} AS resolution, COUNT(*)::bigint AS count
       FROM "PlayHistory"
       WHERE "mediaServerUserId" = $1 AND "resolution" IS NOT NULL
       GROUP BY resolution ORDER BY count DESC LIMIT 8`,
      mediaServerUserId,
    ),
    prisma.$queryRawUnsafe<{ dow: number; hour: number; count: bigint }[]>(
      `SELECT EXTRACT(DOW FROM "startedAt")::int AS dow,
              EXTRACT(HOUR FROM "startedAt")::int AS hour,
              COUNT(*)::bigint AS count
       FROM "PlayHistory" WHERE "mediaServerUserId" = $1 AND "watched" = true
       GROUP BY dow, hour ORDER BY dow, hour`,
      mediaServerUserId,
    ),
    prisma.$queryRawUnsafe<{ device: string | null; count: bigint }[]>(
      `SELECT "device", COUNT(*)::bigint AS count
       FROM "PlayHistory"
       WHERE "mediaServerUserId" = $1 AND "watched" = true AND "device" IS NOT NULL
       GROUP BY "device" ORDER BY count DESC LIMIT 6`,
      mediaServerUserId,
    ),
  ]);

  return {
    totalPlays,
    totalWatchTimeHours: Math.round(Number(totalWatchTime[0]?.hours ?? 0) * 10) / 10,
    recentPlays,
    topMedia: topMedia.map((r) => ({ title: r.title, tmdbId: r.tmdbId, mediaType: r.mediaType, posterPath: r.posterPath, count: Number(r.count) })),
    playsByDay: padDailySeries(
      playsByDay.map((r) => ({ day: r.day, count: Number(r.count), hours: Math.round(r.hours * 100) / 100 })),
      90,
      (day) => ({ day, count: 0, hours: 0 }),
    ),
    platformBreakdown: platformBreakdown.map((r) => ({ platform: r.platform ?? "Unknown", count: Number(r.count) })),
    activityCalendar: activityCalendar.map((r) => ({ day: r.day, count: Number(r.count) })),
    avgSessionDuration: Math.round(Number(avgSessionDurationRaw[0]?.avg_secs ?? 0)),
    transcodeRatio: transcodeRatioRaw.map((r) => ({ method: r.method ?? "Unknown", count: Number(r.count) })),
    resolutionBreakdown: resolutionBreakdownRaw.map((r) => ({ resolution: r.resolution!, count: Number(r.count) })),
    userHeatmap: userHeatmapRaw.map((r) => ({ dow: r.dow, hour: r.hour, count: Number(r.count) })),
    deviceList: deviceListRaw.map((r) => ({ device: r.device!, count: Number(r.count) })),
  };
}

// Aggregate the per-title stats bundle (totals, unique/top viewers, completion,
// recent plays, daily series, transcode/resolution breakdowns) for one tmdbId.
export async function getMediaPlayStats(tmdbId: number, mediaType?: MediaType) {
  const ninetyDaysAgo = new Date(Date.now() - 90 * 24 * 60 * 60 * 1000);

  // TMDB namespaces movie and TV IDs separately, so the same numeric id can be
  // both a film and a series. When the caller knows which one it wants, scope
  // every aggregate to that mediaType so a movie+show id collision can't blend
  // two unrelated titles' stats. The "$2 mediaType" predicate is a no-op clause
  // when mediaType is undefined.
  const mt = mediaType ?? null;
  // The comparison side MUST cast $2 to the "MediaType" enum: the `$2::text IS
  // NULL` null-check types the parameter as text, and Postgres has no
  // enum = text operator (42883 on every call, even with a valid value). A NULL
  // param casts to NULL::"MediaType" harmlessly; non-null values are always
  // 'MOVIE'/'TV' (typed MediaType upstream), so the cast can't throw.
  const mtClause = `($2::text IS NULL OR "mediaType" = $2::"MediaType")`;
  const mtClauseP = `($2::text IS NULL OR p."mediaType" = $2::"MediaType")`;
  const where = mediaType ? { tmdbId, mediaType } : { tmdbId };
  const whereWatched = mediaType ? { tmdbId, mediaType, watched: true } : { tmdbId, watched: true };

  const [
    totalPlays,
    uniqueViewers,
    avgCompletion,
    topViewers,
    recentPlays,
    mediaInfo,
    playsByDayRaw,
    transcodeRatioRaw,
    resolutionBreakdownRaw,
  ] = await Promise.all([
    prisma.playHistory.count({ where: whereWatched }),
    prisma.$queryRawUnsafe<{ count: bigint }[]>(
      `SELECT COUNT(DISTINCT "mediaServerUserId")::bigint AS count FROM "PlayHistory" WHERE "tmdbId" = $1 AND ${mtClause} AND "watched" = true`,
      tmdbId,
      mt,
    ),
    prisma.$queryRawUnsafe<{ avg_pct: number | null }[]>(
      `SELECT AVG(
         CASE WHEN "duration" > 0 THEN ("playDuration"::float / "duration") * 100 ELSE 0 END
       )::float8 AS avg_pct
       FROM "PlayHistory" WHERE "tmdbId" = $1 AND ${mtClause}`,
      tmdbId,
      mt,
    ),
    prisma.$queryRawUnsafe<{ id: string; username: string; source: string; count: bigint; hours: number }[]>(
      `SELECT m."id", m."username", m."source", COUNT(*)::bigint AS count,
              (COALESCE(SUM(p."playDuration"), 0) / 3600.0)::float8 AS hours
       FROM "PlayHistory" p JOIN "MediaServerUser" m ON m."id" = p."mediaServerUserId"
       WHERE p."tmdbId" = $1 AND ${mtClauseP} AND p."watched" = true
       GROUP BY m."id", m."username", m."source"
       ORDER BY count DESC LIMIT 20`,
      tmdbId,
      mt,
    ),
    prisma.playHistory.findMany({
      where,
      orderBy: { startedAt: "desc" },
      take: 50,
      include: {
        mediaServerUser: {
          select: { username: true, source: true },
        },
      },
    }),
    prisma.playHistory.findFirst({
      where,
      orderBy: { startedAt: "desc" },
      select: { title: true, mediaType: true, year: true },
    }),
    prisma.$queryRawUnsafe<{ day: string; count: bigint }[]>(
      `SELECT to_char(date_trunc('day', "startedAt"), 'YYYY-MM-DD') AS day,
              COUNT(*)::bigint AS count
       FROM "PlayHistory"
       WHERE "tmdbId" = $1 AND ${mtClause} AND "watched" = true AND "startedAt" >= $3
       GROUP BY day ORDER BY day`,
      tmdbId,
      mt,
      ninetyDaysAgo,
    ),
    prisma.$queryRawUnsafe<{ method: string | null; count: bigint }[]>(
      `SELECT "playMethod" AS method, COUNT(*)::bigint AS count
       FROM "PlayHistory" WHERE "tmdbId" = $1 AND ${mtClause}
       GROUP BY "playMethod" ORDER BY count DESC`,
      tmdbId,
      mt,
    ),
    prisma.$queryRawUnsafe<{ resolution: string | null; count: bigint }[]>(
      `SELECT ${RESOLUTION_BUCKET_SQL} AS resolution, COUNT(*)::bigint AS count
       FROM "PlayHistory"
       WHERE "tmdbId" = $1 AND ${mtClause} AND "resolution" IS NOT NULL
       GROUP BY resolution ORDER BY count DESC`,
      tmdbId,
      mt,
    ),
  ]);

  let resolvedMedia: { title: string | null; mediaType: MediaType | null; year: string | null } = {
    title: mediaInfo?.title ?? null,
    mediaType: mediaInfo?.mediaType ?? null,
    year: mediaInfo?.year ?? null,
  };
  if (!mediaInfo) {
    const libWhere = mediaType ? { tmdbId, mediaType } : { tmdbId };
    const [plexFallback, jellyfinFallback] = await Promise.all([
      prisma.plexLibraryItem.findFirst({ where: libWhere, select: { title: true, mediaType: true, year: true } }),
      prisma.jellyfinLibraryItem.findFirst({ where: libWhere, select: { title: true, mediaType: true, year: true } }),
    ]);
    const fallback = plexFallback ?? jellyfinFallback;
    if (fallback) resolvedMedia = fallback;
  }

  return {
    totalPlays,
    uniqueViewers: Number(uniqueViewers[0]?.count ?? 0),
    avgCompletion: Math.round(Number(avgCompletion[0]?.avg_pct ?? 0)),
    topViewers: topViewers.map((r) => ({
      id: r.id,
      username: r.username,
      source: r.source,
      count: Number(r.count),
      hours: Math.round(Number(r.hours) * 10) / 10,
    })),
    recentPlays,
    title: resolvedMedia.title ?? `TMDB ${tmdbId}`,
    mediaType: resolvedMedia.mediaType,
    year: resolvedMedia.year,
    playsByDay: playsByDayRaw.map((r) => ({ day: r.day, count: Number(r.count) })),
    transcodeRatio: transcodeRatioRaw.map((r) => ({ method: r.method ?? "Unknown", count: Number(r.count) })),
    resolutionBreakdown: resolutionBreakdownRaw.map((r) => ({ resolution: r.resolution!, count: Number(r.count) })),
  };
}

// One-row-per-MediaServerUser leaderboard for the admin users list: plays, watch
// hours, last-active, favourite platform, and direct-play vs transcode split.
export async function getAllUsersStats() {
  const rows = await prisma.$queryRaw<
    {
      id: string;
      username: string;
      source: string;
      thumbUrl: string | null;
      createdAt: Date;
      plays: bigint;
      hours: number | null;
      lastActive: Date | null;
      favPlatform: string | null;
      direct: bigint;
      transcodes: bigint;
    }[]
  >`
    SELECT
      m."id",
      m."username",
      m."source",
      m."thumbUrl",
      m."createdAt",
      COUNT(p."id") FILTER (WHERE p."watched" = true)::bigint AS plays,
      (COALESCE(SUM(p."playDuration"), 0) / 3600.0)::float8 AS hours,
      MAX(p."startedAt") AS "lastActive",
      (SELECT p2."platform"
       FROM "PlayHistory" p2
       WHERE p2."mediaServerUserId" = m."id" AND p2."platform" IS NOT NULL AND p2."watched" = true
       GROUP BY p2."platform"
       ORDER BY COUNT(*) DESC
       LIMIT 1) AS "favPlatform",
      COUNT(p."id") FILTER (WHERE p."playMethod" = 'DirectPlay')::bigint AS direct,
      COUNT(p."id") FILTER (WHERE p."playMethod" = 'Transcode')::bigint AS transcodes
    FROM "MediaServerUser" m
    LEFT JOIN "PlayHistory" p ON p."mediaServerUserId" = m."id"
    GROUP BY m."id", m."username", m."source", m."thumbUrl", m."createdAt"
    ORDER BY plays DESC
  `;

  return rows.map((r) => {
    const plays = Number(r.plays);
    const direct = Number(r.direct);
    const transcodes = Number(r.transcodes);
    const totalWithMethod = direct + transcodes;
    return {
      id: r.id,
      username: r.username,
      source: r.source,
      thumbUrl: r.thumbUrl,
      createdAt: r.createdAt,
      plays,
      hours: Math.round(Number(r.hours ?? 0) * 10) / 10,
      lastActive: r.lastActive,
      favPlatform: r.favPlatform,
      directPct: totalWithMethod > 0 ? Math.round((direct / totalWithMethod) * 100) : null,
      transcodePct: totalWithMethod > 0 ? Math.round((transcodes / totalWithMethod) * 100) : null,
    };
  });
}

export type PopularSort = "plays" | "viewers" | "trending";

export const POPULAR_PER_PAGE = 40;

type PopularItem = {
  tmdbId: number;
  mediaType: "MOVIE" | "TV";
  title: string;
  year: string | null;
  plays: number;
  allTimePlays: number;
  viewers: number;
  episodes: number;
  totalHours: number;
};

type PopularResult = {
  items: PopularItem[];
  totalItems: number;
  totalPages: number;
  page: number;
};

const POPULAR_CACHE_TTL_MS = 5 * 60 * 1000;
// A most-played list never legitimately needs more than this many pages; clamping
// bounds both the raw-SQL OFFSET depth and the number of distinct per-page cache keys.
const MAX_POPULAR_PAGE = 100;
// Hard ceiling on distinct cached (mediaType, sort, page, limit) combinations so the
// map can't grow without bound (belt-and-suspenders alongside the page/limit clamps).
const MAX_POPULAR_CACHE_ENTRIES = 2_000;
const popularCache = new Map<string, { data: PopularResult; expiresAt: number }>();

// Popularity counts *completed arcs*, not raw sessions. An "arc" is a run of consecutive
// sessions on the same (user, tmdbId, season, episode) that hasn't been broken by either
// a `completed=true` finish (a rewatch boundary) or a gap longer than playHistoryArcGapDays.
// For TV the unit is per-episode; show-level "plays" sum across episodes.
// totalHours and episodes are computed from raw sessions so partial sittings still contribute.
export async function getMostPopularOnServer(
  opts: { mediaType?: "MOVIE" | "TV"; sort?: PopularSort; page?: number; limit?: number } = {},
): Promise<PopularResult> {
  const { mediaType, sort = "plays" } = opts;
  // Clamp page/limit at the SOURCE so every caller is bounded — the /popular server
  // page passes `page` straight through unclamped, which would let one user page
  // arbitrarily deep, forcing a fresh full-table window aggregation per distinct page
  // (defeating the 5-minute cache) and growing popularCache without limit.
  const page = Math.min(Math.max(1, Math.floor(opts.page ?? 1) || 1), MAX_POPULAR_PAGE);
  const limit = Math.min(Math.max(1, Math.floor(opts.limit ?? POPULAR_PER_PAGE) || POPULAR_PER_PAGE), POPULAR_PER_PAGE);

  const cacheKey = JSON.stringify({ mediaType, sort, page, limit });
  const cached = popularCache.get(cacheKey);
  if (cached && cached.expiresAt > Date.now()) return cached.data;

  const [completionPct, arcGapDays] = await Promise.all([
    getCompletionThreshold(),
    getArcGapDays(),
  ]);
  const completionRatio = completionPct / 100;
  const arcGapSeconds = arcGapDays * 24 * 60 * 60;

  const params: unknown[] = [];

  const baseConditions: string[] = ['"tmdbId" IS NOT NULL'];
  if (mediaType) {
    params.push(mediaType);
    baseConditions.push(`"mediaType"::text = $${params.length}`);
  }
  const baseWhere = baseConditions.join(" AND ");

  params.push(arcGapSeconds);
  const arcGapIdx = params.length;

  params.push(completionRatio);
  const completionIdx = params.length;

  let trendingIdx: number | null = null;
  if (sort === "trending") {
    params.push(new Date(Date.now() - 30 * 24 * 60 * 60 * 1000));
    trendingIdx = params.length;
  }

  const trendArcFilter = trendingIdx ? `FILTER (WHERE arc_started_at >= $${trendingIdx})` : "";
  const trendRawFilter = trendingIdx ? `FILTER (WHERE "startedAt" >= $${trendingIdx})` : "";
  // Episodes badge counts only episodes that have at least one completed arc, so a half-watched
  // pilot no longer pads the "5 eps" count. Pulled from completed_arcs (ca.*), filtered to TV.
  const episodesArcFilter = trendingIdx
    ? `FILTER (WHERE ca."mediaType"::text = 'TV' AND ca."seasonNumber" IS NOT NULL AND ca."episodeNumber" IS NOT NULL AND ca.arc_started_at >= $${trendingIdx})`
    : `FILTER (WHERE ca."mediaType"::text = 'TV' AND ca."seasonNumber" IS NOT NULL AND ca."episodeNumber" IS NOT NULL)`;
  const havingSql = trendingIdx ? `HAVING COUNT(*) ${trendArcFilter} > 0` : "";

  const orderBy =
    sort === "viewers" ? "viewers DESC, plays DESC" : "plays DESC, viewers DESC";

  params.push(limit);
  const limitIdx = params.length;
  params.push((page - 1) * limit);
  const offsetIdx = params.length;

  const sql = `
    WITH base AS (
      SELECT "mediaServerUserId", "tmdbId", "mediaType",
             "seasonNumber", "episodeNumber",
             "startedAt", "playDuration", "duration", "completed"
      FROM "PlayHistory"
      WHERE ${baseWhere}
    ),
    arc_flags AS (
      SELECT *,
        CASE
          WHEN LAG("startedAt") OVER w IS NULL
            OR EXTRACT(EPOCH FROM ("startedAt" - LAG("startedAt") OVER w)) >= $${arcGapIdx}
            OR LAG("completed") OVER w = true
          THEN 1 ELSE 0
        END AS arc_start
      FROM base
      WINDOW w AS (
        PARTITION BY "mediaServerUserId", "tmdbId", "mediaType",
                     COALESCE("seasonNumber", -1), COALESCE("episodeNumber", -1)
        ORDER BY "startedAt"
      )
    ),
    arc_ids AS (
      SELECT *,
        SUM(arc_start) OVER (
          PARTITION BY "mediaServerUserId", "tmdbId", "mediaType",
                       COALESCE("seasonNumber", -1), COALESCE("episodeNumber", -1)
          ORDER BY "startedAt"
          ROWS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW
        ) AS arc_id
      FROM arc_flags
    ),
    arcs AS (
      SELECT "tmdbId", "mediaType", "mediaServerUserId",
             "seasonNumber", "episodeNumber", arc_id,
             SUM("playDuration") AS arc_play,
             MAX("duration") AS arc_dur,
             MIN("startedAt") AS arc_started_at
      FROM arc_ids
      GROUP BY "tmdbId", "mediaType", "mediaServerUserId",
               "seasonNumber", "episodeNumber", arc_id
    ),
    completed_arcs AS (
      SELECT *
      FROM arcs
      WHERE arc_dur > 0 AND (arc_play::float / arc_dur) >= $${completionIdx}
    ),
    session_aggregates AS (
      SELECT "tmdbId", "mediaType"::text AS "mediaType",
             MAX("title") AS title,
             MAX("year") AS year,
             (COALESCE(SUM("playDuration") ${trendRawFilter}, 0) / 3600.0)::float8 AS "totalHours"
      FROM "PlayHistory"
      WHERE ${baseWhere}
      GROUP BY "tmdbId", "mediaType"
    ),
    popular AS (
      SELECT ca."tmdbId", ca."mediaType"::text AS "mediaType",
             sa.title, sa.year, sa."totalHours",
             (COUNT(DISTINCT (ca."seasonNumber", ca."episodeNumber")) ${episodesArcFilter})::bigint AS episodes,
             (COUNT(*) ${trendArcFilter})::bigint AS plays,
             COUNT(*)::bigint AS "allTimePlays",
             (COUNT(DISTINCT ca."mediaServerUserId") ${trendArcFilter})::bigint AS viewers
      FROM completed_arcs ca
      JOIN session_aggregates sa
        ON sa."tmdbId" = ca."tmdbId" AND sa."mediaType" = ca."mediaType"::text
      GROUP BY ca."tmdbId", ca."mediaType", sa.title, sa.year, sa."totalHours"
      ${havingSql}
    )
    SELECT *,
           (COUNT(*) OVER ())::bigint AS total_items
    FROM popular
    ORDER BY ${orderBy}
    LIMIT $${limitIdx} OFFSET $${offsetIdx}
  `;

  const rows = await prisma.$queryRawUnsafe<
    {
      tmdbId: number;
      mediaType: string;
      title: string;
      year: string | null;
      plays: bigint;
      allTimePlays: bigint;
      viewers: bigint;
      episodes: bigint;
      totalHours: number;
      total_items: bigint;
    }[]
  >(sql, ...params);

  const totalItems = rows.length > 0 ? Number(rows[0].total_items) : 0;

  const result: PopularResult = {
    items: rows.map((r) => ({
      tmdbId: r.tmdbId,
      mediaType: r.mediaType as "MOVIE" | "TV",
      title: r.title,
      year: r.year,
      plays: Number(r.plays),
      allTimePlays: Number(r.allTimePlays),
      viewers: Number(r.viewers),
      episodes: Number(r.episodes ?? 0),
      totalHours: Math.round(Number(r.totalHours) * 10) / 10,
    })),
    totalItems,
    totalPages: Math.max(1, Math.ceil(totalItems / limit)),
    page,
  };

  // Evict the oldest entry when at capacity so the map can't grow unbounded from
  // distinct cache keys (the page/limit clamps already cap the key space; this is a
  // hard backstop). Map preserves insertion order, so the first key is the oldest.
  if (popularCache.size >= MAX_POPULAR_CACHE_ENTRIES && !popularCache.has(cacheKey)) {
    const oldest = popularCache.keys().next().value;
    if (oldest !== undefined) popularCache.delete(oldest);
  }
  popularCache.set(cacheKey, { data: result, expiresAt: Date.now() + POPULAR_CACHE_TTL_MS });
  return result;
}

export async function getMostRewatched(filters: PlayHistoryStatsFilters = {}, limit = 10) {
  const cacheKey = getCacheKey("rewatched", { ...filters, limit });
  const cached = getCached<Awaited<ReturnType<typeof getMostRewatchedUncached>>>(cacheKey);
  if (cached) return cached;

  const result = await getMostRewatchedUncached(filters, limit);
  setCached(cacheKey, result, REWATCHED_TTL);
  return result;
}

// Canonical resolution bucketing. Plex/Jellyfin report the same resolution in
// inconsistent forms ("720" vs "720p", "1080" vs "1080p", "4k" vs "2160"), so a
// raw GROUP BY on "resolution" splits one resolution across several rows. Reuse
// this CASE everywhere we surface resolution so the buckets always collapse.
const RESOLUTION_BUCKET_SQL = `CASE
  WHEN "resolution" IS NULL OR "resolution" = '' THEN 'Unknown'
  WHEN LOWER("resolution") LIKE '4k%' OR LOWER("resolution") LIKE '2160%' THEN '4K'
  WHEN LOWER("resolution") LIKE '1080%' THEN '1080p'
  WHEN LOWER("resolution") LIKE '720%' THEN '720p'
  WHEN LOWER("resolution") LIKE '576%'
    OR LOWER("resolution") LIKE '540%'
    OR LOWER("resolution") LIKE '480%'
    OR LOWER("resolution") = 'sd' THEN 'SD'
  ELSE 'Other'
END`;

async function getMostRewatchedUncached(filters: PlayHistoryStatsFilters = {}, limit = 10) {
  const { where, params } = buildStatsFilters(filters);
  // Push then read length so a future param insertion in buildStatsFilters can't shift the limit's $-index.
  // Same shape as the bug fixed in commit 803cd11 — sibling builders (buildStatsFilters itself) already do this.
  params.push(limit);
  const limitIdx = params.length;

  const rows = await prisma.$queryRawUnsafe<
    { tmdbId: number; mediaType: string; title: string; posterPath: string | null; plays: bigint; viewers: bigint }[]
  >(
    // Carry the stored posterPath (like getTopWatchedUncached) so the rewatched
    // rows render real cover art instead of a placeholder — no TmdbCache round-trip.
    `SELECT "tmdbId", "mediaType"::text, MAX("title") AS title,
            MAX("posterPath") AS "posterPath",
            COUNT(*)::bigint AS plays,
            COUNT(DISTINCT "mediaServerUserId")::bigint AS viewers
     FROM "PlayHistory"
     WHERE ${where} AND "tmdbId" IS NOT NULL AND "watched" = true
     GROUP BY "tmdbId", "mediaType"
     HAVING COUNT(*) > 1
     ORDER BY plays DESC
     LIMIT $${limitIdx}`,
    ...params,
  );

  return rows.map((r) => ({
    tmdbId: r.tmdbId,
    mediaType: r.mediaType,
    title: r.title,
    posterPath: r.posterPath,
    plays: Number(r.plays),
    viewers: Number(r.viewers),
  }));
}

// Top-watched titles split per media type. Unlike getMostRewatchedUncached
// this has NO `HAVING COUNT(*) > 1` rewatch filter — a movie watched once
// still ranks — and partitions by mediaType so movies can't be starved out
// of a global top-N by TV shows (whose tmdbId aggregates every episode).
// Carries the stored posterPath so callers get real cover art without a
// TmdbCache round-trip.
async function getTopWatchedUncached(filters: PlayHistoryStatsFilters = {}, limitPerType = 8) {
  const { where, params } = buildStatsFilters(filters);
  // Push then read length so a future param insertion can't shift the $-index (cf. 803cd11).
  params.push(limitPerType);
  const limitIdx = params.length;

  const rows = await prisma.$queryRawUnsafe<
    { tmdbId: number; mediaType: string; title: string; posterPath: string | null; plays: bigint; viewers: bigint }[]
  >(
    `WITH agg AS (
       SELECT "tmdbId", "mediaType"::text AS "mediaType", MAX("title") AS title,
              MAX("posterPath") AS "posterPath",
              COUNT(*)::bigint AS plays,
              COUNT(DISTINCT "mediaServerUserId")::bigint AS viewers
       FROM "PlayHistory"
       WHERE ${where} AND "tmdbId" IS NOT NULL AND "watched" = true
       GROUP BY "tmdbId", "mediaType"
     ), ranked AS (
       SELECT *, ROW_NUMBER() OVER (PARTITION BY "mediaType" ORDER BY plays DESC, viewers DESC) AS rn
       FROM agg
     )
     SELECT "tmdbId", "mediaType", title, "posterPath", plays, viewers
     FROM ranked WHERE rn <= $${limitIdx}
     ORDER BY plays DESC`,
    ...params,
  );

  return rows.map((r) => ({
    tmdbId: r.tmdbId,
    mediaType: r.mediaType,
    title: r.title,
    posterPath: r.posterPath,
    plays: Number(r.plays),
    viewers: Number(r.viewers),
  }));
}

export interface PlayHistoryStatsFilters {
  days?: number;
  source?: string;
  mediaType?: string;
}

// Parameters start at $1 here — callers that append further params must continue from params.length+1, not re-start at $1
/**
 * Single source of truth for the play-history `source` / `mediaType` filter
 * suffix and its parameter-index math.
 *
 * Three call sites used to hand-maintain copies of this clause + its `$N`
 * offset (buildStatsFilters, getActivityCalendarUncached, and the activity
 * page's raw queries). A divergence in the `$`-index between copies is the
 * exact 803cd11 bug class — keep this the only place it lives.
 *
 * `baseParams` are the params already bound *before* this suffix (e.g. a
 * startedAt cutoff); placeholder indices continue from `baseParams.length`,
 * so the returned `sql` is safe to append after `WHERE …$1 [AND …$2]`.
 * `tableAlias` namespaces the columns (e.g. "p" → `p."source"`) for JOINs.
 * `source` / `mediaType` are whitelist-validated; anything else is ignored.
 */
export function appendPlayHistoryFilter(
  baseParams: unknown[],
  opts: { source?: string; mediaType?: string; tableAlias?: string } = {},
): { sql: string; params: unknown[] } {
  const prefix = opts.tableAlias ? `${opts.tableAlias}.` : "";
  const clauses: string[] = [];
  const params: unknown[] = [...baseParams];

  if (opts.source === "plex" || opts.source === "jellyfin") {
    params.push(opts.source);
    clauses.push(`${prefix}"source" = $${params.length}`);
  }

  if (opts.mediaType === "MOVIE" || opts.mediaType === "TV") {
    params.push(opts.mediaType);
    clauses.push(`${prefix}"mediaType"::text = $${params.length}`);
  }

  return {
    sql: clauses.length > 0 ? ` AND ${clauses.join(" AND ")}` : "",
    params,
  };
}

function buildStatsFilters(filters: PlayHistoryStatsFilters, tableAlias = "") {
  const prefix = tableAlias ? `${tableAlias}.` : "";
  const cutoff = new Date(Date.now() - (filters.days ?? 30) * 24 * 60 * 60 * 1000);
  const { sql, params } = appendPlayHistoryFilter([cutoff], {
    source: filters.source,
    mediaType: filters.mediaType,
    tableAlias,
  });
  return { where: `${prefix}"startedAt" >= $1${sql}`, params };
}

export type PlayHistoryStatsResult = {
  totalPlays: number;
  totalWatchTimeHours: number;
  playsByDay: { day: string; count: number }[];
  topUsers: { id: string; username: string; source: string; count: number }[];
  topMedia: { title: string; tmdbId: number | null; mediaType: string | null; count: number }[];
  transcodeRatio: { method: string; count: number }[];
  playsByPlatform: { platform: string; count: number }[];
  playsByHour: { hour: number; count: number }[];
  mediaTypeBreakdown: { type: string; count: number }[];
  watchTimeByDay: { day: string; hours: number }[];
  heatmap: { dow: number; hour: number; count: number }[];
  completionRate: number;
  completionBuckets: { bucket: string; count: number }[];
  avgBitrateMbps: number;
  totalBandwidthGB: number;
  bandwidthByDay: { day: string; gb: number }[];

  uniqueViewers: number;
  uniqueTitles: number;
  avgSessionMinutes: number;
  longestSessionMinutes: number;
  pauseRatio: number;
  peakConcurrent: number;

  uniqueViewersByDay: { day: string; count: number }[];
  playsByDow: { dow: number; count: number }[];

  resolutionBreakdown: { bucket: string; count: number }[];
  videoCodecBreakdown: { codec: string; count: number }[];
  audioCodecBreakdown: { codec: string; count: number }[];
  containerBreakdown: { container: string; count: number }[];
  bitrateBuckets: { bucket: string; count: number }[];
  transcodeReasons: { reason: string; count: number }[];

  topDevices: { device: string; count: number }[];
  topPlayers: { player: string; count: number }[];
  sourceSplit: { source: string; count: number }[];

  decadeBreakdown: { decade: string; count: number }[];
  topRewatched: { tmdbId: number; mediaType: string; title: string; posterPath: string | null; plays: number; viewers: number }[];
  topWatched: { tmdbId: number; mediaType: string; title: string; posterPath: string | null; plays: number; viewers: number }[];
  topEpisodes: { tmdbId: number | null; title: string; season: number | null; episode: number | null; episodeTitle: string | null; count: number }[];

  prevPeriod: { totalPlays: number; totalWatchTimeHours: number; uniqueViewers: number };
};

export async function getPlayHistoryStats(
  filters: PlayHistoryStatsFilters = {},
): Promise<PlayHistoryStatsResult> {
  // NOTE: The many $queryRawUnsafe calls in this file (and the route handler)
  // for activity stats/heatmaps use either fully static SQL + bound $1 params,
  // or dynamic fragments built only from whitelisted enum values + parseInt +
  // bound parameters. No user-controlled strings reach SQL structure or identifiers.
  // Keep this discipline on any future edits. See also the route's groupedQuery.
  const cacheKey = getCacheKey("stats", filters as Record<string, unknown>);
  const cached = getCached<PlayHistoryStatsResult>(cacheKey);
  if (cached) return cached;

  const result = await getPlayHistoryStatsUncached(filters);
  setCached(cacheKey, result, STATS_TTL);
  return result;
}

async function getPlayHistoryStatsUncached(filters: PlayHistoryStatsFilters = {}) {
  const { where, params } = buildStatsFilters(filters);
  const { where: joinWhere, params: joinParams } = buildStatsFilters(filters, "p");
  // "plays" surfaces use wwhere (filter watched=true); analytics surfaces (completion rate, codecs,
  // bitrate, bandwidth, peak concurrent) use the raw `where` so the denominator stays complete.
  const wwhere = `${where} AND "watched" = true`;
  const joinWWhere = `${joinWhere} AND p."watched" = true`;

  const days = filters.days ?? 30;
  const prevStart = new Date(Date.now() - days * 2 * 24 * 60 * 60 * 1000);
  const prevEnd = new Date(Date.now() - days * 24 * 60 * 60 * 1000);
  const prevConditions: string[] = [`"startedAt" >= $1 AND "startedAt" < $2`];
  const prevParams: unknown[] = [prevStart, prevEnd];
  if (filters.source && ["plex", "jellyfin"].includes(filters.source)) {
    prevParams.push(filters.source);
    prevConditions.push(`"source" = $${prevParams.length}`);
  }
  if (filters.mediaType && ["MOVIE", "TV"].includes(filters.mediaType)) {
    prevParams.push(filters.mediaType);
    prevConditions.push(`"mediaType"::text = $${prevParams.length}`);
  }
  const prevWhere = prevConditions.join(" AND ");

  // Arc-grouped completion: three sittings of one movie should count as one completion, not
  // "one watched + two incomplete". Same arc definition as getMostPopularOnServer — consecutive
  // sessions on the same (user, tmdbId, season, episode) split by playHistoryArcGapDays or by a
  // prior `completed=true` row (rewatch boundary). The arc CTE needs one extra param (arcGap)
  // on top of `where`'s params; the rate query needs a second (completionRatio), but the
  // histogram uses fixed bucket thresholds so it must NOT receive completionRatio — Postgres
  // rejects prepared statements with unused binds ("bind message supplies N parameters, but
  // prepared statement requires M"). Keep arcHistogramParams and arcRateParams separate.
  const [completionPct, arcGapDays] = await Promise.all([
    getCompletionThreshold(),
    getArcGapDays(),
  ]);
  const arcHistogramParams = [...params, arcGapDays * 24 * 60 * 60];
  const arcRateParams = [...arcHistogramParams, completionPct / 100];
  const arcGapIdx = params.length + 1;
  const completionIdx = params.length + 2;
  const arcCte = `WITH base AS (
       SELECT "mediaServerUserId", "tmdbId", "mediaType",
              "seasonNumber", "episodeNumber",
              "startedAt", "playDuration", "duration", "completed"
       FROM "PlayHistory" WHERE ${where}
     ),
     arc_flags AS (
       SELECT *,
         CASE
           WHEN LAG("startedAt") OVER w IS NULL
             OR EXTRACT(EPOCH FROM ("startedAt" - LAG("startedAt") OVER w)) >= $${arcGapIdx}
             OR LAG("completed") OVER w = true
           THEN 1 ELSE 0
         END AS arc_start
       FROM base
       WINDOW w AS (
         PARTITION BY "mediaServerUserId", "tmdbId", "mediaType",
                      COALESCE("seasonNumber", -1), COALESCE("episodeNumber", -1)
         ORDER BY "startedAt"
       )
     ),
     arc_ids AS (
       SELECT *,
         SUM(arc_start) OVER (
           PARTITION BY "mediaServerUserId", "tmdbId", "mediaType",
                        COALESCE("seasonNumber", -1), COALESCE("episodeNumber", -1)
           ORDER BY "startedAt"
           ROWS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW
         ) AS arc_id
       FROM arc_flags
     ),
     arcs AS (
       SELECT SUM("playDuration") AS arc_play,
              MAX("duration") AS arc_dur
       FROM arc_ids
       GROUP BY "mediaServerUserId", "tmdbId", "mediaType",
                COALESCE("seasonNumber", -1), COALESCE("episodeNumber", -1), arc_id
     )`;

  const [
    totalPlays,
    totalWatchTime,
    playsByDay,
    topUsers,
    topMedia,
    transcodeRatio,
    playsByPlatform,
    playsByHour,
    mediaTypeBreakdown,
    watchTimeByDay,
    heatmap,
    completionStats,
    completionBuckets,
    bitrateStats,
    bandwidthByDayRaw,
    summaryExtras,
    uniqueViewersByDay,
    playsByDow,
    resolutionBreakdown,
    videoCodecBreakdown,
    audioCodecBreakdown,
    containerBreakdown,
    bitrateBuckets,
    transcodeReasons,
    topDevices,
    topPlayers,
    sourceSplit,
    decadeBreakdown,
    topEpisodes,
    peakConcurrentRaw,
    prevPeriodStats,
    topRewatchedRaw,
    topWatchedRaw,
  ] = await Promise.all([
    prisma.$queryRawUnsafe<{ count: bigint }[]>(
      `SELECT COUNT(*)::bigint AS count FROM "PlayHistory" WHERE ${wwhere}`,
      ...params,
    ),
    prisma.$queryRawUnsafe<{ hours: number | null }[]>(
      `SELECT (COALESCE(SUM("playDuration"), 0) / 3600.0)::float8 AS hours FROM "PlayHistory" WHERE ${where}`,
      ...params,
    ),
    prisma.$queryRawUnsafe<{ day: string; count: bigint }[]>(
      `SELECT to_char(date_trunc('day', "startedAt"), 'YYYY-MM-DD') AS day, COUNT(*)::bigint AS count
       FROM "PlayHistory" WHERE ${wwhere}
       GROUP BY day ORDER BY day`,
      ...params,
    ),
    prisma.$queryRawUnsafe<{ id: string; username: string; source: string; count: bigint }[]>(
      `WITH user_counts AS (
         SELECT m."id", m."username", m."source", COUNT(*)::bigint AS count
         FROM "PlayHistory" p JOIN "MediaServerUser" m ON m."id" = p."mediaServerUserId"
         WHERE ${joinWWhere}
         GROUP BY m."id", m."username", m."source"
       ), ranked AS (
         SELECT *, ROW_NUMBER() OVER (PARTITION BY "source" ORDER BY "count" DESC) AS rn
         FROM user_counts
       )
       SELECT "id", "username", "source", "count"
       FROM ranked
       WHERE rn <= 10
       ORDER BY "count" DESC`,
      ...joinParams,
    ),
    // See per-user equivalent earlier in this file — same dedupe strategy.
    prisma.$queryRawUnsafe<{ title: string; tmdbId: number | null; mediaType: string | null; count: bigint }[]>(
      `SELECT MAX("title") AS title, "tmdbId", MAX("mediaType"::text) AS "mediaType", COUNT(*)::bigint AS count
       FROM "PlayHistory" WHERE ${wwhere}
       GROUP BY "tmdbId", CASE WHEN "tmdbId" IS NULL THEN LOWER("title") ELSE NULL END
       ORDER BY count DESC LIMIT 10`,
      ...params,
    ),
    prisma.$queryRawUnsafe<{ method: string | null; count: bigint }[]>(
      `SELECT "playMethod" AS method, COUNT(*)::bigint AS count
       FROM "PlayHistory" WHERE ${where}
       GROUP BY "playMethod" ORDER BY count DESC`,
      ...params,
    ),
    prisma.$queryRawUnsafe<{ platform: string | null; count: bigint }[]>(
      `SELECT "platform", COUNT(*)::bigint AS count
       FROM "PlayHistory" WHERE ${wwhere}
       GROUP BY "platform" ORDER BY count DESC LIMIT 10`,
      ...params,
    ),
    prisma.$queryRawUnsafe<{ hour: number; count: bigint }[]>(
      `SELECT EXTRACT(HOUR FROM "startedAt")::int AS hour, COUNT(*)::bigint AS count
       FROM "PlayHistory" WHERE ${wwhere}
       GROUP BY hour ORDER BY hour`,
      ...params,
    ),
    prisma.$queryRawUnsafe<{ type: string; count: bigint }[]>(
      `SELECT "mediaType"::text AS type, COUNT(*)::bigint AS count
       FROM "PlayHistory" WHERE ${wwhere} AND "mediaType" IS NOT NULL
       GROUP BY "mediaType" ORDER BY count DESC`,
      ...params,
    ),
    prisma.$queryRawUnsafe<{ day: string; hours: number }[]>(
      `SELECT to_char(date_trunc('day', "startedAt"), 'YYYY-MM-DD') AS day,
              (COALESCE(SUM("playDuration"), 0) / 3600.0)::float8 AS hours
       FROM "PlayHistory" WHERE ${where}
       GROUP BY day ORDER BY day`,
      ...params,
    ),
    prisma.$queryRawUnsafe<{ dow: number; hour: number; count: bigint }[]>(
      `SELECT EXTRACT(DOW FROM "startedAt")::int AS dow,
              EXTRACT(HOUR FROM "startedAt")::int AS hour,
              COUNT(*)::bigint AS count
       FROM "PlayHistory" WHERE ${wwhere}
       GROUP BY dow, hour ORDER BY dow, hour`,
      ...params,
    ),
    prisma.$queryRawUnsafe<{ watched: bigint; total: bigint }[]>(
      `${arcCte}
       SELECT COUNT(*) FILTER (WHERE arc_dur > 0 AND (arc_play::float / arc_dur) >= $${completionIdx})::bigint AS watched,
              COUNT(*) FILTER (WHERE arc_dur > 0)::bigint AS total
       FROM arcs`,
      ...arcRateParams,
    ),
    prisma.$queryRawUnsafe<{ bucket: string; count: bigint }[]>(
      `${arcCte}
       SELECT CASE
         WHEN (arc_play::float / arc_dur) < 0.25 THEN '0-25%'
         WHEN (arc_play::float / arc_dur) < 0.50 THEN '25-50%'
         WHEN (arc_play::float / arc_dur) < 0.75 THEN '50-75%'
         ELSE '75-100%'
       END AS bucket, COUNT(*)::bigint AS count
       FROM arcs WHERE arc_dur > 0
       GROUP BY bucket ORDER BY bucket`,
      ...arcHistogramParams,
    ),

    prisma.$queryRawUnsafe<{ avg_mbps: number | null; total_gb: number | null }[]>(
      `SELECT AVG(CASE WHEN "bitrate" > 100000 THEN "bitrate" / 1000.0 ELSE "bitrate" END / 1000.0)::float8 AS avg_mbps,
              (SUM(
                (CASE WHEN "bitrate" > 100000 THEN "bitrate" / 1000.0 ELSE "bitrate" END)::float8
                * "playDuration"::float8
              ) / 8.0 / 1024.0 / 1024.0)::float8 AS total_gb
       FROM "PlayHistory" WHERE ${where} AND "bitrate" IS NOT NULL AND "bitrate" > 0`,
      ...params,
    ),
    prisma.$queryRawUnsafe<{ day: string; gb: number }[]>(
      `SELECT to_char(date_trunc('day', "startedAt"), 'YYYY-MM-DD') AS day,
              (SUM(
                (CASE WHEN "bitrate" > 100000 THEN "bitrate" / 1000.0 ELSE "bitrate" END)::float8
                * "playDuration"::float8
              ) / 8.0 / 1024.0 / 1024.0)::float8 AS gb
       FROM "PlayHistory"
       WHERE ${where} AND "bitrate" IS NOT NULL AND "bitrate" > 0
       GROUP BY day ORDER BY day`,
      ...params,
    ),
    prisma.$queryRawUnsafe<{
      unique_viewers: bigint;
      unique_titles: bigint;
      avg_session_s: number | null;
      longest_session_s: number | null;
      pause_ratio: number | null;
    }[]>(
      // unique_viewers/unique_titles are plays-semantic (filter watched). avg/longest/pause are
      // session analytics; keep across all sessions for honest "how long do people sit through this".
      `SELECT COUNT(DISTINCT "mediaServerUserId") FILTER (WHERE "watched" = true)::bigint AS unique_viewers,
              COUNT(DISTINCT "tmdbId") FILTER (WHERE "tmdbId" IS NOT NULL AND "watched" = true)::bigint AS unique_titles,
              COALESCE(AVG(NULLIF("playDuration", 0)), 0)::float8 AS avg_session_s,
              COALESCE(MAX("playDuration"), 0)::int AS longest_session_s,
              (COALESCE(SUM("pausedDuration"), 0)::float8
                / NULLIF(SUM("playDuration"), 0)::float8)::float8 AS pause_ratio
       FROM "PlayHistory" WHERE ${where}`,
      ...params,
    ),
    prisma.$queryRawUnsafe<{ day: string; count: bigint }[]>(
      `SELECT to_char(date_trunc('day', "startedAt"), 'YYYY-MM-DD') AS day,
              COUNT(DISTINCT "mediaServerUserId")::bigint AS count
       FROM "PlayHistory" WHERE ${wwhere}
       GROUP BY day ORDER BY day`,
      ...params,
    ),
    prisma.$queryRawUnsafe<{ dow: number; count: bigint }[]>(
      `SELECT EXTRACT(DOW FROM "startedAt")::int AS dow, COUNT(*)::bigint AS count
       FROM "PlayHistory" WHERE ${wwhere}
       GROUP BY dow ORDER BY dow`,
      ...params,
    ),
    prisma.$queryRawUnsafe<{ bucket: string; count: bigint }[]>(
      `SELECT ${RESOLUTION_BUCKET_SQL} AS bucket, COUNT(*)::bigint AS count
       FROM "PlayHistory" WHERE ${where}
       GROUP BY bucket ORDER BY count DESC`,
      ...params,
    ),
    prisma.$queryRawUnsafe<{ codec: string; count: bigint }[]>(
      `SELECT COALESCE(NULLIF(UPPER("videoCodec"), ''), 'Unknown') AS codec,
              COUNT(*)::bigint AS count
       FROM "PlayHistory" WHERE ${where}
       GROUP BY codec ORDER BY count DESC LIMIT 8`,
      ...params,
    ),
    prisma.$queryRawUnsafe<{ codec: string; count: bigint }[]>(
      `SELECT COALESCE(NULLIF(UPPER("audioCodec"), ''), 'Unknown') AS codec,
              COUNT(*)::bigint AS count
       FROM "PlayHistory" WHERE ${where}
       GROUP BY codec ORDER BY count DESC LIMIT 8`,
      ...params,
    ),
    prisma.$queryRawUnsafe<{ container: string; count: bigint }[]>(
      `SELECT COALESCE(NULLIF(LOWER("container"), ''), 'unknown') AS container,
              COUNT(*)::bigint AS count
       FROM "PlayHistory" WHERE ${where}
       GROUP BY container ORDER BY count DESC LIMIT 8`,
      ...params,
    ),
    prisma.$queryRawUnsafe<{ bucket: string; count: bigint }[]>(
      `SELECT CASE
         WHEN "bitrate" IS NULL OR "bitrate" <= 0 THEN 'Unknown'
         WHEN (CASE WHEN "bitrate" > 100000 THEN "bitrate"/1000000.0 ELSE "bitrate"/1000.0 END) < 2 THEN '<2 Mbps'
         WHEN (CASE WHEN "bitrate" > 100000 THEN "bitrate"/1000000.0 ELSE "bitrate"/1000.0 END) < 5 THEN '2-5 Mbps'
         WHEN (CASE WHEN "bitrate" > 100000 THEN "bitrate"/1000000.0 ELSE "bitrate"/1000.0 END) < 10 THEN '5-10 Mbps'
         WHEN (CASE WHEN "bitrate" > 100000 THEN "bitrate"/1000000.0 ELSE "bitrate"/1000.0 END) < 20 THEN '10-20 Mbps'
         WHEN (CASE WHEN "bitrate" > 100000 THEN "bitrate"/1000000.0 ELSE "bitrate"/1000.0 END) < 50 THEN '20-50 Mbps'
         ELSE '50+ Mbps'
       END AS bucket, COUNT(*)::bigint AS count
       FROM "PlayHistory" WHERE ${where}
       GROUP BY bucket ORDER BY count DESC`,
      ...params,
    ),
    prisma.$queryRawUnsafe<{ reason: string; count: bigint }[]>(
      // Group by the captured transcodeReason (Plex-derived / Jellyfin
      // TranscodeReasons). Multi-reason sessions keep their comma-joined
      // label as one bucket so counts still sum to exactly the transcode
      // session total — the % math in the UI stays correct. Pre-capture
      // rows have a null reason and fall into 'Unknown'.
      `SELECT COALESCE(NULLIF("transcodeReason", ''), 'Unknown') AS reason,
              COUNT(*)::bigint AS count
       FROM "PlayHistory"
       WHERE ${where} AND "playMethod" = 'Transcode'
       GROUP BY reason ORDER BY count DESC LIMIT 8`,
      ...params,
    ),
    prisma.$queryRawUnsafe<{ device: string; count: bigint }[]>(
      `SELECT COALESCE(NULLIF("device", ''), 'Unknown') AS device,
              COUNT(*)::bigint AS count
       FROM "PlayHistory" WHERE ${wwhere}
       GROUP BY device ORDER BY count DESC LIMIT 10`,
      ...params,
    ),
    prisma.$queryRawUnsafe<{ player: string; count: bigint }[]>(
      `SELECT COALESCE(NULLIF("player", ''), 'Unknown') AS player,
              COUNT(*)::bigint AS count
       FROM "PlayHistory" WHERE ${wwhere}
       GROUP BY player ORDER BY count DESC LIMIT 10`,
      ...params,
    ),
    prisma.$queryRawUnsafe<{ source: string; count: bigint }[]>(
      `SELECT "source", COUNT(*)::bigint AS count
       FROM "PlayHistory" WHERE ${wwhere}
       GROUP BY "source" ORDER BY count DESC`,
      ...params,
    ),
    prisma.$queryRawUnsafe<{ decade: string; count: bigint }[]>(
      `SELECT CASE
         WHEN "year" IS NULL OR "year" = '' THEN 'Unknown'
         WHEN "year" ~ '^[0-9]{4}' THEN (SUBSTRING("year", 1, 3) || '0s')
         ELSE 'Unknown'
       END AS decade, COUNT(*)::bigint AS count
       FROM "PlayHistory" WHERE ${wwhere}
       GROUP BY decade ORDER BY decade`,
      ...params,
    ),
    prisma.$queryRawUnsafe<{
      tmdbId: number | null;
      title: string;
      season: number | null;
      episode: number | null;
      episodeTitle: string | null;
      count: bigint;
    }[]>(
      `SELECT "tmdbId", "title",
              "seasonNumber" AS season, "episodeNumber" AS episode,
              "episodeTitle", COUNT(*)::bigint AS count
       FROM "PlayHistory"
       WHERE ${wwhere} AND "mediaType"::text = 'TV'
         AND "seasonNumber" IS NOT NULL AND "episodeNumber" IS NOT NULL
       GROUP BY "tmdbId", "title", "seasonNumber", "episodeNumber", "episodeTitle"
       ORDER BY count DESC LIMIT 10`,
      ...params,
    ),
    prisma.$queryRawUnsafe<{ peak: number | null }[]>(
      `SELECT COALESCE(MAX(concurrent), 0)::int AS peak FROM (
         SELECT SUM(delta) OVER (ORDER BY t, delta DESC) AS concurrent
         FROM (
           SELECT "startedAt" AS t, 1 AS delta FROM "PlayHistory" WHERE ${where}
           UNION ALL
           SELECT "stoppedAt" AS t, -1 AS delta FROM "PlayHistory" WHERE ${where}
         ) events
       ) sweeps`,
      ...params,
    ),
    prisma.$queryRawUnsafe<{
      plays: bigint;
      hours: number | null;
      viewers: bigint;
    }[]>(
      // Mirror current-period stance: plays/viewers filter watched, hours stays raw.
      `SELECT COUNT(*) FILTER (WHERE "watched" = true)::bigint AS plays,
              (COALESCE(SUM("playDuration"), 0) / 3600.0)::float8 AS hours,
              COUNT(DISTINCT "mediaServerUserId") FILTER (WHERE "watched" = true)::bigint AS viewers
       FROM "PlayHistory" WHERE ${prevWhere}`,
      ...prevParams,
    ),
    getMostRewatchedUncached(filters, 10),
    getTopWatchedUncached(filters, 8),
  ]);

  const watchedCount = Number(completionStats[0]?.watched ?? 0);
  const totalCount = Number(completionStats[0]?.total ?? 0);
  const extras = summaryExtras[0];
  const avgSessionMinutes = extras ? Math.round((Number(extras.avg_session_s ?? 0) / 60) * 10) / 10 : 0;
  const longestSessionMinutes = extras ? Math.round(Number(extras.longest_session_s ?? 0) / 60) : 0;
  const pauseRatio = extras ? Math.round(Number(extras.pause_ratio ?? 0) * 1000) / 1000 : 0;
  const peakConcurrent = Number(peakConcurrentRaw[0]?.peak ?? 0);
  const prev = prevPeriodStats[0];

  return {
    totalPlays: Number(totalPlays[0]?.count ?? 0),
    totalWatchTimeHours: Math.round(Number(totalWatchTime[0]?.hours ?? 0) * 10) / 10,
    playsByDay: playsByDay.map((r) => ({ day: r.day, count: Number(r.count) })),
    topUsers: topUsers.map((r) => ({ id: r.id, username: r.username, source: r.source, count: Number(r.count) })),
    topMedia: topMedia.map((r) => ({ title: r.title, tmdbId: r.tmdbId, mediaType: r.mediaType, count: Number(r.count) })),
    transcodeRatio: transcodeRatio.map((r) => ({ method: r.method ?? "Unknown", count: Number(r.count) })),
    playsByPlatform: playsByPlatform.map((r) => ({ platform: r.platform ?? "Unknown", count: Number(r.count) })),
    playsByHour: playsByHour.map((r) => ({ hour: r.hour, count: Number(r.count) })),
    mediaTypeBreakdown: mediaTypeBreakdown.map((r) => ({ type: r.type, count: Number(r.count) })),
    watchTimeByDay: watchTimeByDay.map((r) => ({ day: r.day, hours: Math.round(r.hours * 100) / 100 })),
    heatmap: heatmap.map((r) => ({ dow: r.dow, hour: r.hour, count: Number(r.count) })),
    completionRate: totalCount > 0 ? Math.round((watchedCount / totalCount) * 100) : 0,
    completionBuckets: completionBuckets.map((r) => ({ bucket: r.bucket, count: Number(r.count) })),
    avgBitrateMbps: Math.round(Number(bitrateStats[0]?.avg_mbps ?? 0) * 10) / 10,
    totalBandwidthGB: Math.round(Number(bitrateStats[0]?.total_gb ?? 0) * 10) / 10,
    bandwidthByDay: bandwidthByDayRaw.map((r) => ({ day: r.day, gb: Math.round(r.gb * 100) / 100 })),
    uniqueViewers: Number(extras?.unique_viewers ?? 0),
    uniqueTitles: Number(extras?.unique_titles ?? 0),
    avgSessionMinutes,
    longestSessionMinutes,
    pauseRatio,
    peakConcurrent,
    uniqueViewersByDay: uniqueViewersByDay.map((r) => ({ day: r.day, count: Number(r.count) })),
    playsByDow: playsByDow.map((r) => ({ dow: r.dow, count: Number(r.count) })),
    resolutionBreakdown: resolutionBreakdown.map((r) => ({ bucket: r.bucket, count: Number(r.count) })),
    videoCodecBreakdown: videoCodecBreakdown.map((r) => ({ codec: r.codec, count: Number(r.count) })),
    audioCodecBreakdown: audioCodecBreakdown.map((r) => ({ codec: r.codec, count: Number(r.count) })),
    containerBreakdown: containerBreakdown.map((r) => ({ container: r.container, count: Number(r.count) })),
    bitrateBuckets: bitrateBuckets.map((r) => ({ bucket: r.bucket, count: Number(r.count) })),
    transcodeReasons: transcodeReasons.map((r) => ({ reason: r.reason, count: Number(r.count) })),
    topDevices: topDevices.map((r) => ({ device: r.device, count: Number(r.count) })),
    topPlayers: topPlayers.map((r) => ({ player: r.player, count: Number(r.count) })),
    sourceSplit: sourceSplit.map((r) => ({ source: r.source, count: Number(r.count) })),
    decadeBreakdown: decadeBreakdown.map((r) => ({ decade: r.decade, count: Number(r.count) })),
    topRewatched: topRewatchedRaw,
    topWatched: topWatchedRaw,
    topEpisodes: topEpisodes.map((r) => ({
      tmdbId: r.tmdbId,
      title: r.title,
      season: r.season,
      episode: r.episode,
      episodeTitle: r.episodeTitle,
      count: Number(r.count),
    })),
    prevPeriod: {
      totalPlays: Number(prev?.plays ?? 0),
      totalWatchTimeHours: Math.round(Number(prev?.hours ?? 0) * 10) / 10,
      uniqueViewers: Number(prev?.viewers ?? 0),
    },
  };
}

export async function getActivityCalendar(
  source?: string,
  mediaType?: string,
): Promise<{ day: string; count: number }[]> {
  const cacheKey = getCacheKey("calendar", { source, mediaType });
  const cached = getCached<{ day: string; count: number }[]>(cacheKey);
  if (cached) return cached;

  const result = await getActivityCalendarUncached(source, mediaType);
  setCached(cacheKey, result, CALENDAR_TTL);
  return result;
}

async function getActivityCalendarUncached(
  source?: string,
  mediaType?: string,
): Promise<{ day: string; count: number }[]> {
  // No params bound before the suffix here (the CURRENT_DATE window uses no
  // placeholder), so filter params start at $1 — see appendPlayHistoryFilter.
  const { sql: filterSql, params: filterParams } = appendPlayHistoryFilter([], {
    source,
    mediaType,
  });

  const result = await prisma.$queryRawUnsafe<{ day: string; count: bigint }[]>(
    // startedAt is a tz-naive UTC timestamp and is bucketed by its UTC day, so the
    // window edge must be a UTC date too. CURRENT_DATE evaluates in the Postgres
    // session timezone — on a non-UTC DB that drifts a day off the UTC buckets and
    // the UTC window the client (activity-calendar.tsx) renders. Pin it to UTC.
    `SELECT DATE("startedAt")::text AS day, COUNT(*)::bigint AS count
     FROM "PlayHistory"
     WHERE "startedAt" >= (now() AT TIME ZONE 'UTC')::date - INTERVAL '364 days' AND "watched" = true${filterSql} -- 365 calendar days inclusive of today
     GROUP BY DATE("startedAt")
     ORDER BY day ASC`,
    ...filterParams,
  );

  return result.map((r) => ({ day: r.day, count: Number(r.count) }));
}

// Per-cell drill-down behind the click popover on the activity heatmaps
// (activity-calendar.tsx day cells + HourHeatmap dow/hour cells). All counts
// filter watched=true so the popover's "total plays" matches the count the
// cell was coloured by (both heatmaps colour from watched=true aggregates).
export interface HeatmapCellQuery {
  mode: "day" | "hour";
  day?: string; // YYYY-MM-DD (UTC) — mode="day"
  dow?: number; // Postgres DOW 0=Sun..6=Sat — mode="hour"
  hour?: number; // 0-23 — mode="hour"
  userId?: string; // mediaServerUserId — user-scoped pages
  source?: string; // "plex" | "jellyfin"
  mediaType?: string; // "MOVIE" | "TV"
  days?: number; // time window for mode="hour" on the admin (non-user) page
}

export interface HeatmapCellDetail {
  totalPlays: number;
  watchHours: number;
  avgSessionMinutes: number;
  completedCount: number;
  completedPct: number;
  methods: { directPlay: number; directStream: number; transcode: number; other: number };
  topTranscodeReasons: { reason: string; count: number }[];
  source: { plex: number; jellyfin: number };
  mediaType: { movie: number; tv: number; other: number };
  avgBitrateMbps: number;
  dataTransferredGb: number;
  topResolutions: { resolution: string; count: number }[];
  network: { lan: number; wan: number; relay: number };
  topTitles: { title: string; tmdbId: number | null; count: number }[];
  // Top viewers for the bucket (up to 3). Empty on user-scoped pages (they would
  // always be the page's own user — redundant).
  topUsers: { id: string; username: string; count: number }[];
}

export async function getHeatmapCellDetail(q: HeatmapCellQuery): Promise<HeatmapCellDetail> {
  const cacheKey = `heatmap-cell:${JSON.stringify(q)}`;
  const cached = getCached<HeatmapCellDetail>(cacheKey);
  if (cached) return cached;

  // Build the WHERE incrementally so the $-index always tracks params.length —
  // same discipline as appendPlayHistoryFilter (the 803cd11 bug class).
  const conditions: string[] = [`"watched" = true`];
  const params: unknown[] = [];
  const bind = (v: unknown): string => {
    params.push(v);
    return `$${params.length}`;
  };

  if (q.mode === "day") {
    conditions.push(`DATE("startedAt") = ${bind(q.day)}::date`);
  } else {
    // Match the source heatmaps' scoping: admin grid is bounded by the `days`
    // window (getPlayHistoryStats); the per-user grid is all-history. Only apply
    // the window when not user-scoped so the popover total matches the cell.
    if (!q.userId && q.days) {
      conditions.push(
        `"startedAt" >= ${bind(new Date(Date.now() - q.days * 24 * 60 * 60 * 1000))}`,
      );
    }
    conditions.push(`EXTRACT(DOW FROM "startedAt")::int = ${bind(q.dow)}`);
    conditions.push(`EXTRACT(HOUR FROM "startedAt")::int = ${bind(q.hour)}`);
  }
  if (q.userId) conditions.push(`"mediaServerUserId" = ${bind(q.userId)}`);
  if (q.source === "plex" || q.source === "jellyfin") {
    conditions.push(`"source" = ${bind(q.source)}`);
  }
  if (q.mediaType === "MOVIE" || q.mediaType === "TV") {
    conditions.push(`"mediaType"::text = ${bind(q.mediaType)}`);
  }
  const where = conditions.join(" AND ");

  // bitrate is normalized like the rest of the stats layer: Jellyfin reports bps
  // (>100000), Plex kbps — divide the former by 1000 to get kbps before the
  // Mbps / GB math (mirrors the total_gb query in getPlayHistoryStatsUncached).
  const normBitrate = `(CASE WHEN "bitrate" > 100000 THEN "bitrate" / 1000.0 ELSE "bitrate" END)`;

  const [agg, reasons, resolutions, titles, topUserRows] = await Promise.all([
    prisma.$queryRawUnsafe<
      {
        total: bigint;
        watch_hours: number;
        avg_minutes: number;
        completed: bigint;
        direct_play: bigint;
        direct_stream: bigint;
        transcode: bigint;
        method_other: bigint;
        src_plex: bigint;
        src_jellyfin: bigint;
        mt_movie: bigint;
        mt_tv: bigint;
        mt_other: bigint;
        net_lan: bigint;
        net_wan: bigint;
        net_relay: bigint;
        avg_mbps: number | null;
        total_gb: number | null;
      }[]
    >(
      `SELECT
         COUNT(*)::bigint AS total,
         (COALESCE(SUM("playDuration"), 0) / 3600.0)::float8 AS watch_hours,
         (COALESCE(AVG("playDuration"), 0) / 60.0)::float8 AS avg_minutes,
         COUNT(*) FILTER (WHERE "completed" = true)::bigint AS completed,
         COUNT(*) FILTER (WHERE "playMethod" = 'DirectPlay')::bigint AS direct_play,
         COUNT(*) FILTER (WHERE "playMethod" = 'DirectStream')::bigint AS direct_stream,
         COUNT(*) FILTER (WHERE "playMethod" = 'Transcode')::bigint AS transcode,
         COUNT(*) FILTER (WHERE "playMethod" IS NULL OR "playMethod" NOT IN ('DirectPlay','DirectStream','Transcode'))::bigint AS method_other,
         COUNT(*) FILTER (WHERE "source" = 'plex')::bigint AS src_plex,
         COUNT(*) FILTER (WHERE "source" = 'jellyfin')::bigint AS src_jellyfin,
         COUNT(*) FILTER (WHERE "mediaType"::text = 'MOVIE')::bigint AS mt_movie,
         COUNT(*) FILTER (WHERE "mediaType"::text = 'TV')::bigint AS mt_tv,
         COUNT(*) FILTER (WHERE "mediaType" IS NULL)::bigint AS mt_other,
         COUNT(*) FILTER (WHERE "location" = 'lan')::bigint AS net_lan,
         COUNT(*) FILTER (WHERE "location" = 'wan')::bigint AS net_wan,
         COUNT(*) FILTER (WHERE "location" = 'relay' OR "relayed" = true)::bigint AS net_relay,
         (AVG(${normBitrate} / 1000.0) FILTER (WHERE "bitrate" > 0))::float8 AS avg_mbps,
         (COALESCE(SUM((${normBitrate})::float8 * "playDuration"::float8) FILTER (WHERE "bitrate" > 0), 0) / 8.0 / 1024.0 / 1024.0)::float8 AS total_gb
       FROM "PlayHistory" WHERE ${where}`,
      ...params,
    ),
    prisma.$queryRawUnsafe<{ reason: string; count: bigint }[]>(
      `SELECT "transcodeReason" AS reason, COUNT(*)::bigint AS count
       FROM "PlayHistory" WHERE ${where} AND "transcodeReason" IS NOT NULL AND "transcodeReason" <> ''
       GROUP BY "transcodeReason" ORDER BY count DESC LIMIT 4`,
      ...params,
    ),
    // Bucket via the canonical CASE so "720"/"720p" and "1080"/"1080p" collapse
    // into one row each (raw GROUP BY split them — the formatting bug). Exclude
    // the 'Unknown' bucket so an absent resolution doesn't show as a fake row.
    prisma.$queryRawUnsafe<{ resolution: string; count: bigint }[]>(
      `SELECT ${RESOLUTION_BUCKET_SQL} AS resolution, COUNT(*)::bigint AS count
       FROM "PlayHistory" WHERE ${where} AND "resolution" IS NOT NULL AND "resolution" <> ''
       GROUP BY resolution ORDER BY count DESC LIMIT 4`,
      ...params,
    ),
    // Most-played titles in the bucket — same tmdbId/title dedup as the stats
    // topMedia query (null tmdbId falls back to lowercased title).
    prisma.$queryRawUnsafe<{ title: string; tmdbId: number | null; count: bigint }[]>(
      `SELECT MAX("title") AS title, "tmdbId", COUNT(*)::bigint AS count
       FROM "PlayHistory" WHERE ${where} AND "title" IS NOT NULL AND "title" <> ''
       GROUP BY "tmdbId", CASE WHEN "tmdbId" IS NULL THEN LOWER("title") ELSE NULL END
       ORDER BY count DESC LIMIT 4`,
      ...params,
    ),
    // Top viewer — skipped on user-scoped pages (always the page's own user).
    // Filter inside a CTE (bare column names, no alias collisions) then join
    // MediaServerUser outside; PlayHistory and MediaServerUser both have a
    // "source" column so a direct join on the filtered set would be ambiguous.
    q.userId
      ? Promise.resolve([] as { id: string; username: string; count: bigint }[])
      : prisma.$queryRawUnsafe<{ id: string; username: string; count: bigint }[]>(
          `WITH f AS (
             SELECT "mediaServerUserId", COUNT(*)::bigint AS count
             FROM "PlayHistory" WHERE ${where}
             GROUP BY "mediaServerUserId"
           )
           SELECT m."id" AS id, m."username" AS username, f."count" AS count
           FROM f JOIN "MediaServerUser" m ON m."id" = f."mediaServerUserId"
           ORDER BY f."count" DESC LIMIT 3`,
          ...params,
        ),
  ]);

  const r = agg[0];
  const total = Number(r?.total ?? 0);
  const completedCount = Number(r?.completed ?? 0);
  const detail: HeatmapCellDetail = {
    totalPlays: total,
    watchHours: Math.round(Number(r?.watch_hours ?? 0) * 10) / 10,
    avgSessionMinutes: Math.round(Number(r?.avg_minutes ?? 0)),
    completedCount,
    completedPct: total > 0 ? Math.round((completedCount / total) * 100) : 0,
    methods: {
      directPlay: Number(r?.direct_play ?? 0),
      directStream: Number(r?.direct_stream ?? 0),
      transcode: Number(r?.transcode ?? 0),
      other: Number(r?.method_other ?? 0),
    },
    topTranscodeReasons: reasons.map((x) => ({ reason: x.reason, count: Number(x.count) })),
    source: {
      plex: Number(r?.src_plex ?? 0),
      jellyfin: Number(r?.src_jellyfin ?? 0),
    },
    mediaType: {
      movie: Number(r?.mt_movie ?? 0),
      tv: Number(r?.mt_tv ?? 0),
      other: Number(r?.mt_other ?? 0),
    },
    avgBitrateMbps: Math.round(Number(r?.avg_mbps ?? 0) * 10) / 10,
    dataTransferredGb: Math.round(Number(r?.total_gb ?? 0) * 100) / 100,
    topResolutions: resolutions.map((x) => ({ resolution: x.resolution, count: Number(x.count) })),
    network: {
      lan: Number(r?.net_lan ?? 0),
      wan: Number(r?.net_wan ?? 0),
      relay: Number(r?.net_relay ?? 0),
    },
    topTitles: titles.map((x) => ({ title: x.title, tmdbId: x.tmdbId, count: Number(x.count) })),
    topUsers: topUserRows.map((u) => ({
      id: u.id,
      username: u.username,
      count: Number(u.count),
    })),
  };

  setCached(cacheKey, detail, STATS_TTL);
  return detail;
}

// Transcode-pressure leaderboard for the activity overview: who/what forces the
// most server-side transcodes in the period. Transcodes are the expensive path
// (CPU + bandwidth), so a ranked list helps an admin spot the heavy hitters.
export interface TranscodeOffenders {
  topUsers: { username: string; source: string; count: number }[];
  topTitles: { title: string; tmdbId: number | null; mediaType: string | null; count: number }[];
}

export async function getTranscodeOffenders(
  filters: PlayHistoryStatsFilters = {},
  limit = 6,
): Promise<TranscodeOffenders> {
  const cacheKey = `transcode-offenders:${JSON.stringify({ ...filters, limit })}`;
  const cached = getCached<TranscodeOffenders>(cacheKey);
  if (cached) return cached;

  const { where, params } = buildStatsFilters(filters);
  const twhere = `${where} AND "playMethod" = 'Transcode'`;
  const limitIdx = params.length + 1;

  const [users, titles] = await Promise.all([
    // Filter in a CTE (bare names) then join MediaServerUser — PlayHistory and
    // MediaServerUser both expose "source", so a direct join would be ambiguous.
    prisma.$queryRawUnsafe<{ username: string; source: string; count: bigint }[]>(
      `WITH f AS (
         SELECT "mediaServerUserId", COUNT(*)::bigint AS count
         FROM "PlayHistory" WHERE ${twhere}
         GROUP BY "mediaServerUserId"
       )
       SELECT m."username" AS username, m."source" AS source, f."count" AS count
       FROM f JOIN "MediaServerUser" m ON m."id" = f."mediaServerUserId"
       ORDER BY f."count" DESC LIMIT $${limitIdx}`,
      ...params,
      limit,
    ),
    prisma.$queryRawUnsafe<{ title: string; tmdbId: number | null; mediaType: string | null; count: bigint }[]>(
      `SELECT MAX("title") AS title, "tmdbId", MAX("mediaType"::text) AS "mediaType", COUNT(*)::bigint AS count
       FROM "PlayHistory" WHERE ${twhere} AND "title" IS NOT NULL AND "title" <> ''
       GROUP BY "tmdbId", CASE WHEN "tmdbId" IS NULL THEN LOWER("title") ELSE NULL END
       ORDER BY count DESC LIMIT $${limitIdx}`,
      ...params,
      limit,
    ),
  ]);

  const result: TranscodeOffenders = {
    topUsers: users.map((u) => ({ username: u.username, source: u.source, count: Number(u.count) })),
    topTitles: titles.map((t) => ({
      title: t.title,
      tmdbId: t.tmdbId,
      mediaType: t.mediaType,
      count: Number(t.count),
    })),
  };
  setCached(cacheKey, result, STATS_TTL);
  return result;
}

function getCacheKey(prefix: string, params: Record<string, unknown>): string {
  const parts = [prefix];
  if (params.days) parts.push(String(params.days));
  if (params.source) parts.push(String(params.source));
  if (params.mediaType) parts.push(String(params.mediaType));
  if (params.limit) parts.push(String(params.limit));
  return parts.join(":");
}

function getCached<T>(key: string): T | null {
  const entry = activityCache.get(key);
  if (!entry) return null;
  if (entry.expiresAt <= Date.now()) {
    activityCache.delete(key);
    return null;
  }
  return entry.data as T;
}

// Bound the cache: heatmap-cell keys embed arbitrary userId/day/dow/hour combos,
// so distinct keys are effectively unbounded and getCached only evicts a key when
// it is re-accessed after expiry. Cap the map so a long-lived process can't grow it
// without bound — sweep expired entries first, then evict oldest-inserted (Map keeps
// insertion order) until under the cap.
const ACTIVITY_CACHE_MAX = 500;

function setCached<T>(key: string, data: T, ttlMs: number): void {
  if (activityCache.size >= ACTIVITY_CACHE_MAX && !activityCache.has(key)) {
    const now = Date.now();
    for (const [k, v] of activityCache) {
      if (v.expiresAt <= now) activityCache.delete(k);
    }
    while (activityCache.size >= ACTIVITY_CACHE_MAX) {
      const oldest = activityCache.keys().next().value;
      if (oldest === undefined) break;
      activityCache.delete(oldest);
    }
  }
  activityCache.set(key, { data, expiresAt: Date.now() + ttlMs });
}

export function clearActivityCache(): void {
  activityCache.clear();
  // popularCache lives in the same module with its own 5-min TTL but is fed by the same
  // PlayHistory rows. Without flushing it here a freshly-finalized session can take up to
  // 5 minutes to surface on /popular, and deletions take 5 minutes to drop a title out.
  popularCache.clear();
}

// Pre-populate the activity stats/calendar/rewatched caches for the common time
// windows so the first admin page load after a cache flush is warm. Cron-driven.
export async function warmActivityCache(): Promise<{ warmed: number }> {
  let warmed = 0;

  for (const days of [1, 7, 14, 30, 90]) {
    await getPlayHistoryStats({ days });
    warmed++;
  }

  await getActivityCalendar();
  warmed++;

  for (const days of [7, 14, 30]) {
    await getMostRewatched({ days }, 10);
    warmed++;
  }

  return { warmed };
}
