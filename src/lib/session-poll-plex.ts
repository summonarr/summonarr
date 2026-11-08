// The Plex pass of the 5s play-history poller (POST /api/sync/play-history):
// one server's /status/sessions snapshot → ActiveSession rows, stall and
// item-change finalizes, and the absence sweep. Shared pieces are in
// session-poll-shared.ts.
import { prisma } from "@/lib/prisma";
import type { ActiveSession } from "@/generated/prisma";
import { computePlaytimeIncrement, resolveShowTmdbId } from "@/lib/play-history";
import { extractTmdbIdFromGuids, getPlexMarkers, getPlexSessions, getPlexUser } from "@/lib/plex";
import type { PlexSessionData } from "@/lib/plex-sessions";
import { indexPlexRowsByKey } from "@/lib/plex-dedupe";
import { type MediaInstanceKey, activeSessionId, parseActiveSessionId } from "@/lib/media-instances";
import { mapLimit } from "@/lib/concurrency";
import {
  PLEX_STALL_THRESHOLD_MS,
  clearFinalizedNotInCurrentSnapshot,
  isFinalizedPlexGhost,
  markPlexSessionFinalized,
  pruneRecentlyFinalized,
  setPlexReachable,
} from "@/lib/plex-events";
import {
  continuingUpdateFields,
  finalizeAbsentSessions,
  forceFinalizeSession,
  isJitterBackstep,
  lookupSessionPosters,
  mediaTypeOfItem,
  playheadMovedFrom,
  posterOf,
  progressPercentOf,
  resolveMediaServerUserCached,
  stripShowPrefix,
  tickResult,
  writeEachSession,
  type SessionWriteOutcome,
  type SyncResult,
} from "@/lib/session-poll-shared";

// DLNA clients open phantom sessions just from *browsing* the library — the
// session appears in /status/sessions for one tick with platform="DLNA" and
// then disappears. Tautulli sleeps 1s and re-fetches to filter them
// (activity_handler.py:97-101). We achieve the same with a one-poll grace:
// the first time a brand-new DLNA session shows up, we tag it pending and
// skip creating an ActiveSession row; if it re-appears on the next poll
// (~5s later), it's a real playback and we create. Entries are dropped when
// the session stops appearing in the snapshot. Held in-memory: a process
// restart drops the gate, but the worst case is one extra phantom row that
// the 60s absence grace will reap.
const pendingDlnaSessions = new Set<string>();

// The admin Plex user id (rewrites the owner's local "1" and flags
// MediaServerUser.isServerAdmin) effectively never changes for a given token, yet the
// poller runs every 5s. Memoize it per-token with a long TTL so a healthy poll doesn't
// hit plex.tv ~17k×/day. A Map (not a single slot): with N configured Plex instances
// the per-tick calls alternate tokens, and a one-slot cache would miss on every call
// and hammer plex.tv.
// Stale-on-error: past the TTL the id is refreshed, but a failed refresh keeps serving
// the last id learned. Returning null instead filed every owner play that started and
// ended inside a plex.tv outage under the phantom "1" identity, which the subject
// resolver can never link to the owner (guardrail 34). A failure is held for
// PLEX_ADMIN_ID_RETRY_MS so a hung plex.tv doesn't add its 15s timeout to every tick.
// A token no longer polled (rotated away) is forgotten after PLEX_ADMIN_ID_FORGET_MS.
const PLEX_ADMIN_ID_TTL_MS = 60 * 60 * 1000;
const PLEX_ADMIN_ID_RETRY_MS = 60 * 1000;
const PLEX_ADMIN_ID_FORGET_MS = 24 * 60 * 60 * 1000;
const plexAdminIdCache = new Map<string, { id: string | null; refreshAt: number; usedAt: number }>();
async function getCachedPlexAdminId(token: string): Promise<string | null> {
  const now = Date.now();
  for (const [cachedToken, entry] of plexAdminIdCache) {
    if (now - entry.usedAt > PLEX_ADMIN_ID_FORGET_MS) plexAdminIdCache.delete(cachedToken);
  }
  const hit = plexAdminIdCache.get(token);
  if (hit) {
    hit.usedAt = now;
    if (hit.refreshAt > now) return hit.id;
  }
  const fetched = await getPlexUser(token)
    .then((u) => u.id)
    .catch(() => null);
  const id = fetched ?? hit?.id ?? null;
  plexAdminIdCache.set(token, {
    id,
    refreshAt: now + (fetched != null ? PLEX_ADMIN_ID_TTL_MS : PLEX_ADMIN_ID_RETRY_MS),
    usedAt: now,
  });
  return id;
}

/** What a tick does with a session that already has a row. */
export type PlexContinuation =
  // The client auto-played the next item under the same sessionKey.
  | { kind: "item-changed" }
  // A ghost: Plex still reports it playing, but the playhead hasn't moved for the threshold.
  | { kind: "stalled" }
  // An ordinary update: the progress to store, and whether the stall anchor moves.
  | { kind: "update"; nextProgressMs: number; refreshAnchor: boolean };

/**
 * The continuing-session rules, pure (guardrail 20).
 *
 * A ratingKey change without a stop event is auto-play of the next episode (the
 * most common Plex client behavior): the same sessionKey, another item. Without
 * a finalize the previous episode's watch silently merges into the next one's
 * PlayHistory row. Tautulli handles it the same way (activity_handler.py:331-335).
 *
 * Liveness is "the playhead MOVED since the last stored value", not "this
 * snapshot is strictly greater than it". progressMs is written by two racing
 * writers — this lagging 5s poller and the real-time SSE handler — and SSE
 * pushes it ahead of /status/sessions, so a strict `>` reads false on a healthy
 * stream whenever SSE wrote last, which (a) suppresses the anchor refresh and
 * (b) satisfies the stall condition, so the poller stall-finalizes a
 * still-playing stream. A genuine ghost (client quit, Plex keeps reporting it)
 * has a FROZEN viewOffset, so the inequality is false there and the stall still
 * fires as intended. A small backward step is clamped out (the fresher stored
 * value is kept), so it can never converge and is NOT movement — counting it
 * would refresh the anchor every tick forever; a genuine seek-back (> tolerance)
 * is written through and IS movement.
 *
 * A resume from a non-playing state skips the stall check and refreshes the
 * anchor: after a pause longer than the threshold, the first playing tick sees
 * an unmoved playhead and an old anchor — indistinguishable from a ghost.
 */
export function planPlexContinuation(
  existing: Pick<ActiveSession, "sourceItemId" | "progressMs" | "state" | "progressUpdatedAt">,
  s: Pick<PlexSessionData, "ratingKey" | "viewOffset" | "state">,
  nowMs: number,
): PlexContinuation {
  if (existing.sourceItemId && s.ratingKey && existing.sourceItemId !== s.ratingKey) return { kind: "item-changed" };
  const priorProgressMs = Number(existing.progressMs);
  const moved = playheadMovedFrom(priorProgressMs, s.viewOffset);
  const resumedToPlaying = existing.state !== "playing" && s.state === "playing";
  const stalled =
    s.state === "playing"
    && existing.state === "playing"
    && !moved
    && nowMs - existing.progressUpdatedAt.getTime() >= PLEX_STALL_THRESHOLD_MS;
  if (stalled) return { kind: "stalled" };
  return {
    kind: "update",
    nextProgressMs: isJitterBackstep(priorProgressMs, s.viewOffset) ? priorProgressMs : s.viewOffset,
    refreshAnchor: moved || resumedToPlaying,
  };
}

/**
 * The address to record: off-LAN, the server-observed public address —
 * Player.address is the client's SELF-reported value and for WAN sessions
 * routinely a private/loopback address. Relayed sessions report 127.0.0.1 in
 * remotePublicAddress (the local relay endpoint), worth less than the
 * self-report, so loopback falls back.
 */
export function plexSessionAddress(s: Pick<PlexSessionData, "location" | "remotePublicAddress" | "address">): string | null {
  const publicAddress = s.location !== "lan" && s.remotePublicAddress && s.remotePublicAddress !== "127.0.0.1" && s.remotePublicAddress !== "::1"
    ? s.remotePublicAddress
    : null;
  return publicAddress ?? s.address ?? null;
}

type ResolvedPlexSession = {
  s: PlexSessionData;
  sessionId: string;
  msUserId: string;
  tmdbId: number | null;
  mediaType: "MOVIE" | "TV" | null;
};

type PlexTick = {
  instance: MediaInstanceKey;
  serverUrl: string;
  token: string;
  now: Date;
  nowMs: number;
  // null while plex.tv couldn't say who owns the token this tick.
  plexAdminId: string | null;
  existing: ReadonlyMap<string, ActiveSession>;
  posters: ReadonlyMap<string, string | null>;
};

export async function syncPlexSessions(instance: MediaInstanceKey, serverUrl: string, token: string, reanchored: boolean): Promise<SyncResult> {
  // getPlexSessions is the authoritative local-reachability probe — it runs
  // every poll. Report the result so the UI's reachability badge reflects
  // whether Summonarr can actually reach the Plex server (not plex.tv remote
  // access). Fire-and-forget; the persist is deduped + only writes on change.
  // Reported PER INSTANCE: setPlexReachable writes that instance's own
  // plexSettingKey(instance, "ServerReachable"), so a named server's outage
  // shows up for that server instead of being hidden.
  let sessions: PlexSessionData[];
  try {
    sessions = await getPlexSessions(serverUrl, token);
  } catch (err) {
    void setPlexReachable(false, instance);
    throw err;
  }
  void setPlexReachable(true, instance);
  const now = new Date();
  const nowMs = now.getTime();
  pruneRecentlyFinalized(nowMs);

  // Release ledger entries THIS instance's Plex server has stopped reporting
  // before the create-gate checks it. The ledger exists to suppress re-creation
  // while Plex keeps a ghost in /status/sessions; once Plex drops the key, a new
  // play reusing it (rare, but possible after a Plex server restart) shouldn't
  // be blocked. The set holds this server's BARE sessionKeys — the helper only
  // touches ledger entries whose parsed id belongs to `instance`, so instance
  // A's (possibly empty) snapshot can never release instance B's entries.
  const allReportedKeys = new Set<string>();
  for (const s of sessions) {
    if (s.sessionKey) allReportedKeys.add(s.sessionKey);
  }
  clearFinalizedNotInCurrentSnapshot(instance, allReportedKeys);

  // Filter sessions with required identifiers up front so prefetch sets are accurate.
  // Skip sessions Plex is still reporting after we've already finalized them via
  // SSE stop, stall detection, or the stale loop — they'd otherwise be re-created
  // on every poll. Only while the playhead stays put, though: a ghost's is frozen,
  // and one that moves again is the play resuming under the same key, which gets
  // a new row (isFinalizedPlexGhost releases the ledger entry).
  const valid = sessions.filter(
    (s) => s.sessionKey && s.accountId
      && !isFinalizedPlexGhost(activeSessionId("plex", instance, s.sessionKey), s.viewOffset, playheadMovedFrom),
  );
  // Even when `valid` is empty we keep going: the cleanup sweep below still has
  // to finalize stale rows.

  // Resolve the admin's Plex user id once per run so we can mark
  // MediaServerUser.isServerAdmin for the server-owner row (Plex sessions
  // don't carry an admin flag; the owner is whoever owns the admin token).
  // Best-effort: if the call fails, isServerAdmin stays unset on this run.
  const plexAdminId = await getCachedPlexAdminId(token);

  const seenSessionKeys = new Set<string>();
  for (const s of valid) seenSessionKeys.add(s.sessionKey);

  // Bulk prefetch: existing ActiveSession rows for these IDs in a single query.
  // Ids are instance-qualified ("plex:<key>" default / "plex:<instance>:<key>"
  // named), so this read is instance-scoped by construction.
  const sessionIds = valid.map((s) => activeSessionId("plex", instance, s.sessionKey));
  const existingRows = sessionIds.length > 0
    ? await prisma.activeSession.findMany({ where: { id: { in: sessionIds } } })
    : [];

  const resolved = await resolvePlexSessions(valid, instance, plexAdminId);
  const posters = await lookupSessionPosters(resolved);
  releaseGoneDlnaSessions(instance, valid);

  const tick: PlexTick = {
    instance, serverUrl, token, now, nowMs, plexAdminId,
    existing: new Map(existingRows.map((r) => [r.id, r])),
    posters,
  };
  // Run per-session writes in parallel; one failing is skipped, not fatal.
  const outcomes = await writeEachSession(resolved, (r) => r.sessionId, (r) => writePlexSession(tick, r));

  // Grace window: only finalize sessions that have been missing from
  // /status/sessions for SESSION_ABSENCE_GRACE_MS. A single dropped poll (Plex
  // hiccup, paused client briefly dropped from the snapshot) shouldn't write a
  // PlayHistory row and ledger-lock the sessionKey. Real stops linger up to
  // 60s as "Now Playing" before finalize, but the SSE feed catches them in
  // real-time as long as it's connected; this is the fallback when SSE is down.
  // Nothing is selected when the boot re-anchor failed (guardrail 21).
  const sweptEnded = await finalizeAbsentSessions({
    source: "plex",
    instance,
    seen: seenSessionKeys,
    reanchored,
    nowMs,
    // Ledger AFTER the write commits (guardrail 27): gate re-create against a racey
    // Plex reappearance only once the PlayHistory row exists, so a failed
    // write doesn't ledger-lock the sessionKey with no row for an hour.
    afterFinalize: (session) => markPlexSessionFinalized(session.id, nowMs),
  });
  return tickResult(outcomes, sweptEnded);
}

// Each session's MediaServerUser and TMDB id.
async function resolvePlexSessions(
  valid: readonly PlexSessionData[],
  instance: MediaInstanceKey,
  plexAdminId: string | null,
): Promise<ResolvedPlexSession[]> {
  // Bulk prefetch: PlexLibraryItem fallbacks for movies whose TMDB id isn't in Guid.
  // serverInstance-scoped: ratingKeys are small server-local integers, so two
  // Plex servers legitimately reuse the same key for different titles — an
  // unscoped lookup could attribute this instance's watch to another server's title.
  const ratingKeysNeedingLookup = valid
    .filter((s) => s.type !== "episode" && extractTmdbIdFromGuids(s.Guid) == null && !!s.ratingKey)
    .map((s) => s.ratingKey);
  // ORed across both ratingKey columns (guardrail 37c): a movie in two sections
  // has two ratingKeys and only one is the stored plexRatingKey.
  const libRows = ratingKeysNeedingLookup.length > 0
    ? await prisma.plexLibraryItem.findMany({
        where: {
          serverInstance: instance,
          OR: [{ plexRatingKey: { in: ratingKeysNeedingLookup } }, { plexRatingKeys: { hasSome: ratingKeysNeedingLookup } }],
        },
        select: { plexRatingKey: true, plexRatingKeys: true, tmdbId: true, mediaType: true },
      })
    : [];
  // Keyed by EVERY key a row answers to, or widening the query only finds a row
  // the map then misses — and each key resolves to its ONE owner (canonical
  // holder, else lowest tmdbId: `indexPlexRowsByKey`), never to whichever row
  // findMany happened to return first, because the answer is persisted.
  const libMap = indexPlexRowsByKey(libRows);

  // Resolve media server users in parallel — each upserts independently.
  // isServerAdmin = accountId matches the admin token's plex user id. When
  // plexAdminId couldn't be fetched, leave the flag undefined so the upsert
  // doesn't blindly flip an existing true→false.
  // Bound concurrency (guardrail 31): each resolveMediaServerUser holds its own
  // $transaction and the pool is max:5, so an unbounded Promise.all over N sessions —
  // running concurrently with the Jellyfin pass — saturates the pool every tick. Cap
  // below the pool size.
  const userIds = await mapLimit([...valid], 4, (s) => {
    // PMS reports the SERVER OWNER's sessions with the LOCAL account id "1",
    // never their plex.tv global id — but User.plexUserId (what the subject-id
    // resolver matches) and every MediaServerUser row are keyed by global ids,
    // so without this the owner's watches are never auto-attributed and no Plex
    // row ever earns isServerAdmin (Tautulli special-cases id "1" for the same
    // reason). Rewrite it to the cached admin id; when plex.tv was unreachable
    // this tick plexAdminId is null, behavior is unchanged, and the next tick
    // heals.
    const isOwner = plexAdminId !== null && s.accountId === "1";
    return resolveMediaServerUserCached({
      source: "plex",
      serverInstance: instance,
      sourceUserId: isOwner ? plexAdminId : s.accountId,
      username: s.accountName,
      thumbUrl: s.accountThumb || null,
      ...(plexAdminId !== null ? { isServerAdmin: isOwner || s.accountId === plexAdminId } : {}),
    });
  });

  // Resolve TMDB ids per session (TV episodes hit DB, movies are mostly in-memory).
  return Promise.all(
    valid.map(async (s, i): Promise<ResolvedPlexSession> => {
      const sessionId = activeSessionId("plex", instance, s.sessionKey);
      let tmdbId: number | null = null;
      let mediaType = mediaTypeOfItem(s.type);
      if (s.type === "episode") {
        // For episodes, resolve the TMDB ID from the show (grandparent), not the episode item itself
        tmdbId = await resolveShowTmdbId("plex", s.grandparentRatingKey, instance);
      } else {
        tmdbId = extractTmdbIdFromGuids(s.Guid);
        if (tmdbId == null && s.ratingKey) {
          const lib = libMap.get(s.ratingKey);
          if (lib) {
            tmdbId = lib.tmdbId;
            mediaType = mediaType ?? lib.mediaType;
          }
        }
      }
      return { s, sessionId, msUserId: userIds[i], tmdbId, mediaType };
    }),
  );
}

// Drop DLNA gate entries THIS instance's Plex is no longer reporting — the
// phantom is gone and the slot shouldn't keep a future *real* session
// waiting. Same per-instance filter as clearFinalizedNotInCurrentSnapshot:
// the poll's ids only hold THIS instance's, so an unfiltered sweep would
// delete every OTHER instance's pending entries each tick and a real DLNA
// playback on a named instance could never pass its two-snapshot grace.
function releaseGoneDlnaSessions(instance: MediaInstanceKey, valid: readonly PlexSessionData[]): void {
  const seenInThisPoll = new Set(valid.map((s) => activeSessionId("plex", instance, s.sessionKey)));
  for (const pending of pendingDlnaSessions) {
    const parsed = parseActiveSessionId(pending);
    if (parsed.source !== "plex" || parsed.serverInstance !== instance) continue;
    if (!seenInThisPoll.has(pending)) pendingDlnaSessions.delete(pending);
  }
}

async function writePlexSession(tick: PlexTick, r: ResolvedPlexSession): Promise<SessionWriteOutcome> {
  const existing = tick.existing.get(r.sessionId);
  if (existing) {
    const plan = planPlexContinuation(existing, r.s, tick.nowMs);
    if (plan.kind === "stalled") return finalizeStalled(tick, r, existing);
    if (plan.kind === "update") return updateContinuing(tick, r, existing, plan);
    // item-changed: force-stop the previous item, then fall through to create
    // the new one (recordCompletedSession deletes the old row).
    // On failure the old row survives under this same id, so the create below
    // would be a no-op counted as "started", and the new item's markers would
    // land on the old row. The next tick sees the item change again and retries.
    if (!(await forceFinalizeSession(existing, tick.now, "ratingKey-change finalize", r.sessionId))) return "skipped";
  }

  // DLNA phantom filter: require two consecutive snapshots before creating a
  // new DLNA session (see pendingDlnaSessions).
  if (r.s.platform === "DLNA") {
    if (!pendingDlnaSessions.has(r.sessionId)) {
      pendingDlnaSessions.add(r.sessionId);
      return "skipped";
    }
    pendingDlnaSessions.delete(r.sessionId);
  }
  return createPlexSession(tick, r);
}

// Ghost session: Plex still reports it but the playhead has been frozen for
// PLEX_STALL_THRESHOLD_MS while state="playing". Finalize now and gate
// re-create so subsequent polls don't resurrect it. SSE normally catches this
// faster; this is the fallback when SSE is down or the client never sent a
// state="stopped" notification.
async function finalizeStalled(tick: PlexTick, r: ResolvedPlexSession, existing: ActiveSession): Promise<SessionWriteOutcome> {
  // A failure is not "ended": no history row was written, so the tick must not
  // count it into the ended total / fire activity:history-updated for a row
  // that isn't there (mirrors the absence sweep).
  if (!(await forceFinalizeSession(existing, tick.now, "stall-finalize", r.sessionId))) return "skipped";
  // Ledger AFTER the write (guardrail 27): a failed record must not ledger-lock
  // the sessionKey for an hour with no history row — the next poll re-observes
  // the stall and retries the finalize. The frozen playhead is the ghost's
  // baseline: a later tick that sees it move starts a new row.
  markPlexSessionFinalized(r.sessionId, tick.nowMs, r.s.viewOffset);
  return "ended";
}

async function updateContinuing(
  tick: PlexTick,
  r: ResolvedPlexSession,
  existing: ActiveSession,
  plan: Extract<PlexContinuation, { kind: "update" }>,
): Promise<SessionWriteOutcome> {
  const { s, msUserId, tmdbId, mediaType } = r;
  const increment = computePlaytimeIncrement(existing, tick.now);
  const posterPath = posterOf(tick.posters, tmdbId, mediaType);
  // CAS on (id, lastSeenAt): if SSE or another path deleted/updated the row
  // between our prefetch and this write, updateMany returns 0 and the session
  // is skipped (not counted as updated) instead of throwing P2025 and aborting
  // the batch. The next poll re-reads state and resumes.
  const written = await prisma.activeSession.updateMany({
    where: { id: r.sessionId, lastSeenAt: existing.lastSeenAt },
    data: {
      lastSeenAt: tick.now,
      state: s.state,
      // Re-bind the owner when this tick resolved a DIFFERENT identity than
      // the row was created under. A server-owner session that STARTS while
      // plex.tv is unreachable is created on a phantom sourceUserId="1" row
      // (plexAdminId was null, so the "1" rewrite could not fire); the next
      // tick resolves the owner to the global-id row, but without this the
      // create-time id stuck until finalize copied it into PlayHistory — a
      // watch the subject resolver (guardrail 34) could never link to the
      // owner's account. Only written on a mismatch so the CAS data stays
      // minimal for the common case. Never while plexAdminId is null: then
      // this tick resolved the owner to that same phantom "1" row, and
      // re-binding would move a correctly bound session onto it for the
      // whole plex.tv outage (and out of the owner's history at finalize).
      ...(tick.plexAdminId !== null && existing.mediaServerUserId !== msUserId ? { mediaServerUserId: msUserId } : {}),
      progressPercent: progressPercentOf(plan.nextProgressMs, s.duration),
      progressMs: BigInt(plan.nextProgressMs),
      ...(plan.refreshAnchor ? { progressUpdatedAt: tick.now } : {}),
      playMethod: s.playMethod,
      resolution: s.resolution,
      // Mid-stream transcode switches (client falls back / recovers) must
      // reach finalize — undefined leaves the stored value alone (matching
      // playMethod's semantics on a stream-less payload).
      videoDecision: s.videoDecision,
      audioDecision: s.audioDecision,
      transcodeReason: s.transcodeReason ?? null,
      // Includes the one-shot durationMs backfill: a first tick that raced
      // Plex's metadata can stamp 0, and it is filled once the real duration
      // appears so completion math isn't off forever.
      ...continuingUpdateFields({ existing, increment, durationMs: s.duration, tmdbId, mediaType, posterPath }),
      location: s.location ?? null,
      bandwidth: s.bandwidth ?? null,
      secure: s.secure ?? null,
      relayed: s.relayed ?? null,
    },
  });
  return written.count > 0 ? "updated" : "skipped";
}

async function createPlexSession(tick: PlexTick, r: ResolvedPlexSession): Promise<SessionWriteOutcome> {
  const { s, sessionId, msUserId, tmdbId, mediaType } = r;
  // Single-row createMany({skipDuplicates}) → INSERT ... ON CONFLICT DO NOTHING:
  // two overlapping poll ticks can both reach here for a brand-new sessionKey;
  // a bare create() would throw P2002 on the loser, rejecting the tick's
  // Promise.all and skipping its stale-session finalize sweep. The loser's
  // count is 0: the other tick started it, so this one counts nothing.
  const created = await prisma.activeSession.createMany({
    data: [{
      id: sessionId,
      source: "plex",
      serverInstance: tick.instance,
      sessionKey: s.sessionKey,
      startedAt: tick.now,
      lastSeenAt: tick.now,
      state: s.state,
      mediaServerUserId: msUserId,
      serverUsername: s.accountName,
      tmdbId,
      mediaType,

      title: s.type === "episode" ? (s.grandparentTitle ?? s.title) : s.title,
      year: s.year ?? null,
      seasonNumber: s.parentIndex ?? null,
      episodeNumber: s.index ?? null,
      // getPlexSessions composes an episode title as `${grandparentTitle} — ${title}`.
      // Strip that exact prefix rather than splitting: a SHOW name containing
      // " — " ("Foo — Bar" + "Pilot") would store "Bar — Pilot", and this is
      // write-once here and copied verbatim into PlayHistory.
      episodeTitle: s.type === "episode" ? stripShowPrefix(s.title, s.grandparentTitle) : null,
      sourceItemId: s.ratingKey,
      // The show's own key, kept so a play recorded before its show reached the
      // library cache (tmdbId null) can still be attributed later (guardrail 14d).
      sourceShowId: s.type === "episode" ? (s.grandparentRatingKey || null) : null,
      posterPath: posterOf(tick.posters, tmdbId, mediaType),
      progressPercent: progressPercentOf(s.viewOffset, s.duration),
      progressMs: BigInt(s.viewOffset),
      // Where in the file this SESSION began — a resume starts mid-file, so
      // finalize's playDuration fallback must subtract this from the
      // absolute playhead or a resumed session books the pre-resume runtime
      // as watch time.
      startProgressMs: BigInt(s.viewOffset),
      durationMs: BigInt(s.duration),
      platform: s.platform ?? null,
      player: s.player ?? null,
      device: s.device ?? null,
      ipAddress: plexSessionAddress(s),
      playMethod: s.playMethod ?? null,
      videoCodec: s.videoCodec ?? null,
      audioCodec: s.audioCodec ?? null,
      resolution: s.resolution ?? null,
      bitrate: s.bitrate ?? null,
      videoDecision: s.videoDecision ?? null,
      audioDecision: s.audioDecision ?? null,
      container: s.container ?? null,
      transcodeReason: s.transcodeReason ?? null,
      location: s.location ?? null,
      bandwidth: s.bandwidth ?? null,
      secure: s.secure ?? null,
      relayed: s.relayed ?? null,
    }],
    skipDuplicates: true,
  });
  if (created.count === 0) return "skipped";

  // Best-effort: fetch intro/credits markers in the background and stamp
  // them on the row we just created. Fire-and-forget — markers don't need
  // to block session creation, and a failed fetch (Plex not Plex-Pass,
  // metadata not yet analyzed, network blip) just leaves the columns null.
  // The columns stay frozen for the lifetime of the session; finalize
  // reads them off ActiveSession without a second metadata fetch.
  if (s.ratingKey) {
    void getPlexMarkers(tick.serverUrl, tick.token, s.ratingKey).then(async (markers) => {
      if (Object.keys(markers).length === 0) return;
      await prisma.activeSession.updateMany({
        where: { id: sessionId },
        data: {
          introStartMs: markers.introStartMs ?? null,
          introEndMs: markers.introEndMs ?? null,
          creditsStartMs: markers.creditsStartMs ?? null,
          creditsEndMs: markers.creditsEndMs ?? null,
        },
      }).catch(() => {});
    }).catch(() => {});
  }
  return "started";
}
