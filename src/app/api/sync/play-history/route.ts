import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { checkRateLimit, getClientIp } from "@/lib/rate-limit";
import {
  isPlayHistoryEnabled,
  isSourceEnabled,
  resolveMediaServerUser,
  recordCompletedSession,
  cleanupStaleSessions,
  purgeOldHistory,
  resolveShowTmdbId,
  computePlaytimeIncrement,
  applyFinalTick,
  emitActiveSessionsSnapshot,
  reanchorActiveSessionsOnBoot,
  SESSION_ABSENCE_GRACE_MS,
} from "@/lib/play-history";
import { getPlexSessions, extractTmdbIdFromGuids, getPlexUser, getPlexMarkers } from "@/lib/plex";
import { getJellyfinSessions } from "@/lib/jellyfin";
import { getJellyfinConfig } from "@/lib/jellyfin-config";
import { getPlexConfig } from "@/lib/plex-config";
import { type MediaInstanceKey, activeSessionId, mediaInstanceLabel, parseActiveSessionId } from "@/lib/media-instances";
import { getMediaInstances, getSyncableMediaInstances } from "@/lib/media-instance-registry";
import { mapLimit } from "@/lib/concurrency";
import { emitSSE } from "@/lib/sse-emitter";
import { isCronAuthorized, withCronRunRecording } from "@/lib/cron-auth";
import {
  PLEX_STALL_THRESHOLD_MS,
  clearFinalizedNotInCurrentSnapshot,
  isPlexSessionRecentlyFinalized,
  markPlexSessionFinalized,
  pruneRecentlyFinalized,
  reconcilePlexEventStream,
  stopAllPlexEventStreams,
  setPlexReachable,
} from "@/lib/plex-events";

type SyncResult = { started: number; updated: number; ended: number };

// Both session helpers compose an episode's display title as
// `${show} — ${episode}` (plex.ts / jellyfin.ts). Recover the episode half by
// removing that exact prefix, NOT by splitting on the separator: the show name
// can contain " — " too, and splitting left its tail glued to the episode name.
// Falls back to the composed title when the prefix isn't there (nothing to strip).
const TITLE_SEP = " — ";
function stripShowPrefix(composed: string, show: string | null | undefined): string | null {
  if (show && composed.startsWith(show + TITLE_SEP)) {
    return composed.slice(show.length + TITLE_SEP.length) || null;
  }
  const idx = composed.indexOf(TITLE_SEP);
  return idx === -1 ? null : composed.slice(idx + TITLE_SEP.length) || null;
}

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

// The 5s poller's /status/sessions snapshot lags the real-time SSE writer
// (applyLiveStateUpdate in plex-events.ts), which pushes progressMs ahead. When
// the poller then writes its slightly-older snapshot it would move progressMs
// *backward* by a few seconds, making the now-playing progress bar bounce every
// poll. Treat a small backward step (within this window) as stale-snapshot
// jitter and keep the fresher stored value; a larger backward jump is a genuine
// seek-back and is written through. ~2 poll intervals of slack. Only the poller
// clamps — SSE is the authoritative real-time source and always writes raw.
const PROGRESS_JITTER_TOLERANCE_MS = 10_000;

// The admin Plex user id (used only to flag MediaServerUser.isServerAdmin) effectively
// never changes for a given token, yet the poller runs every 5s. Memoize it per-token
// with a long TTL so a healthy poll doesn't hit plex.tv ~17k×/day. A Map (not a single
// slot): with N configured Plex instances the per-tick calls alternate tokens, and a
// one-slot cache would miss on every call and hammer plex.tv. Stale entries are pruned
// opportunistically on each call — a handful of instances, no LRU needed. Best-effort:
// a failed lookup returns null and is not cached, so the next poll retries.
const PLEX_ADMIN_ID_TTL_MS = 60 * 60 * 1000;
const plexAdminIdCache = new Map<string, { id: string; expiresAt: number }>();
async function getCachedPlexAdminId(token: string): Promise<string | null> {
  const now = Date.now();
  for (const [cachedToken, entry] of plexAdminIdCache) {
    if (entry.expiresAt <= now) plexAdminIdCache.delete(cachedToken);
  }
  const hit = plexAdminIdCache.get(token);
  if (hit) return hit.id;
  const id = await getPlexUser(token)
    .then((u) => u.id)
    .catch(() => null);
  if (id != null) {
    plexAdminIdCache.set(token, { id, expiresAt: now + PLEX_ADMIN_ID_TTL_MS });
  }
  return id;
}

async function syncPlexSessions(instance: MediaInstanceKey, serverUrl: string, token: string): Promise<SyncResult> {
  // getPlexSessions is the authoritative local-reachability probe — it runs
  // every poll. Report the result so the UI's reachability badge reflects
  // whether Summonarr can actually reach the Plex server (not plex.tv remote
  // access). Fire-and-forget; the persist is deduped + only writes on change.
  // Reported PER INSTANCE: setPlexReachable addresses that instance's manager,
  // which writes its own plexSettingKey(instance, "ServerReachable"). Previously
  // this was gated to the default because the Setting/badge were single-server,
  // which meant a named server's outage never surfaced anywhere.
  let sessions;
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
  // on every poll.
  const valid = sessions.filter(
    (s) => s.sessionKey && s.accountId && !isPlexSessionRecentlyFinalized(activeSessionId("plex", instance, s.sessionKey)),
  );
  if (valid.length === 0) {
    // Still need the cleanup sweep below to finalize any stale rows.
  }

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
  const existingMap = new Map(existingRows.map((r) => [r.id, r]));

  // Bulk prefetch: PlexLibraryItem fallbacks for movies whose TMDB id isn't in Guid.
  // serverInstance-scoped: ratingKeys are small server-local integers, so two
  // Plex servers legitimately reuse the same key for different titles — an
  // unscoped lookup could attribute this instance's watch to another server's title.
  const ratingKeysNeedingLookup = valid
    .filter((s) => s.type !== "episode" && extractTmdbIdFromGuids(s.Guid) == null && !!s.ratingKey)
    .map((s) => s.ratingKey);
  const libRows = ratingKeysNeedingLookup.length > 0
    ? await prisma.plexLibraryItem.findMany({
        where: { plexRatingKey: { in: ratingKeysNeedingLookup }, serverInstance: instance },
        select: { plexRatingKey: true, tmdbId: true, mediaType: true },
      })
    : [];
  const libMap = new Map(libRows.map((r) => [r.plexRatingKey, r]));

  // Resolve media server users in parallel — each upserts independently.
  // isServerAdmin = accountId matches the admin token's plex user id. When
  // plexAdminId couldn't be fetched, leave the flag undefined so the upsert
  // doesn't blindly flip an existing true→false.
  // Bound concurrency (guardrail 31): each resolveMediaServerUser holds its own
  // $transaction and the pool is max:5, so an unbounded Promise.all over N sessions —
  // running concurrently with the Jellyfin pass — saturates the pool every tick. Cap
  // below the pool size.
  const userIds = await mapLimit(valid, 4, (s) =>
    resolveMediaServerUser({
      source: "plex",
      serverInstance: instance,
      sourceUserId: s.accountId,
      username: s.accountName,
      thumbUrl: s.accountThumb || null,
      ...(plexAdminId !== null ? { isServerAdmin: s.accountId === plexAdminId } : {}),
    }),
  );

  // Resolve TMDB ids per session (TV episodes hit DB, movies are mostly in-memory).
  const resolved = await Promise.all(
    valid.map(async (s, i) => {
      const sessionId = activeSessionId("plex", instance, s.sessionKey);
      let tmdbId: number | null = null;
      let mediaType: string | null = s.type === "episode" ? "TV" : s.type === "movie" ? "MOVIE" : null;

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

  // Bulk prefetch posters for every distinct (tmdbId, mediaType) pair we resolved.
  const posterPairs = Array.from(
    new Map(
      resolved
        .filter((r): r is typeof r & { tmdbId: number; mediaType: string } => r.tmdbId != null && !!r.mediaType)
        .map((r) => [`${r.tmdbId}:${r.mediaType}`, { tmdbId: r.tmdbId, mediaType: r.mediaType as "MOVIE" | "TV" }]),
    ).values(),
  );
  const posterRows = posterPairs.length > 0
    ? await prisma.tmdbMediaCore.findMany({
        where: { OR: posterPairs.map((p) => ({ tmdbId: p.tmdbId, mediaType: p.mediaType })) },
        select: { tmdbId: true, mediaType: true, posterPath: true },
      }).catch(() => [])
    : [];
  const posterMap = new Map(posterRows.map((r) => [`${r.tmdbId}:${r.mediaType}`, r.posterPath]));

  // Drop DLNA gate entries THIS instance's Plex is no longer reporting — the
  // phantom is gone and the slot shouldn't keep a future *real* session
  // waiting. Same per-instance filter as clearFinalizedNotInCurrentSnapshot:
  // seenInThisPoll only holds THIS instance's ids, so an unfiltered sweep
  // would delete every OTHER instance's pending entries each tick and a real
  // DLNA playback on a named instance could never pass its two-snapshot grace.
  const seenInThisPoll = new Set(valid.map((s) => activeSessionId("plex", instance, s.sessionKey)));
  for (const pending of pendingDlnaSessions) {
    const parsed = parseActiveSessionId(pending);
    if (parsed.source !== "plex" || parsed.serverInstance !== instance) continue;
    if (!seenInThisPoll.has(pending)) pendingDlnaSessions.delete(pending);
  }

  // Run per-session writes in parallel.
  const writeResults = await Promise.all(
    resolved.map(async ({ s, sessionId, msUserId, tmdbId, mediaType }): Promise<"started" | "updated" | "ended" | "skipped"> => {
      const progressPercent = s.duration > 0 ? (s.viewOffset / s.duration) * 100 : 0;
      const posterPath = tmdbId != null && mediaType ? posterMap.get(`${tmdbId}:${mediaType}`) ?? null : null;

      const existing = existingMap.get(sessionId);
      if (existing) {
        // rating_key change without a stop event: auto-play next episode (the
        // most common Plex client behavior) keeps the same sessionKey but
        // swaps the underlying ratingKey. Without this, the previous
        // episode's watch silently merges into the next episode's PlayHistory
        // row at finalize. Tautulli handles it the same way
        // (activity_handler.py:331-335): force-stop the previous, recreate.
        if (existing.sourceItemId && s.ratingKey && existing.sourceItemId !== s.ratingKey) {
          try {
            await recordCompletedSession(
              applyFinalTick(existing, now),
              { skipSSE: true, stoppedAt: now },
            );
          } catch (err) {
            console.warn(`[play-history] ratingKey-change finalize failed for ${sessionId}:`, err);
          }
          // Fall through to create branch below. existing is now finalized
          // and its ActiveSession row deleted by recordCompletedSession.
        } else {
          // Liveness must be "the playhead MOVED since the last stored value,"
          // not "this snapshot is strictly greater than it." progressMs is
          // written by two racing writers — this lagging 5s poller and the
          // real-time SSE handler (applyLiveStateUpdate). SSE pushes progressMs
          // ahead of /status/sessions, so a strict `s.viewOffset > progressMs`
          // check reads false on a healthy stream whenever SSE wrote last,
          // which (a) suppresses the progressUpdatedAt refresh below and (b)
          // satisfies !playheadMoved in the stall condition — so the anchor
          // ages past 60s and the poller stall-finalizes a still-playing
          // stream. A genuine ghost (client quit, Plex keeps reporting it)
          // has a FROZEN viewOffset, so `!==` is false there and the stall
          // still fires at 60s as intended. Use inequality, not greater-than.
          const priorProgressMs = Number(existing.progressMs);
          const playheadMoved = s.viewOffset !== priorProgressMs;
          // True resume from a non-playing state. Without this branch, a
          // pause longer than PLEX_STALL_THRESHOLD_MS (60s) ends with
          // progressUpdatedAt stuck at the moment the user paused. The first
          // poll after resume sees state="playing", !playheadMoved (viewOffset
          // hasn't moved yet, we haven't completed one playing tick), and
          // now - progressUpdatedAt >> 60s — indistinguishable from a real
          // ghost. Stall would fire, session finalized as a short watch,
          // ledger-locked, card never comes back. Skip the stall check when
          // the prior observed state was not "playing", and refresh
          // progressUpdatedAt so the next tick measures from the resume.
          const resumedToPlaying = existing.state !== "playing" && s.state === "playing";
          const stalled =
            s.state === "playing"
            && existing.state === "playing"
            && !playheadMoved
            && nowMs - existing.progressUpdatedAt.getTime() >= PLEX_STALL_THRESHOLD_MS;

          if (stalled) {
            // Ghost session: Plex still reports it but the playhead has been frozen for
            // PLEX_STALL_THRESHOLD_MS while state="playing". Finalize now and gate
            // re-create so subsequent polls don't resurrect it. SSE feed normally
            // catches this faster; this is the fallback when SSE is down or the
            // client never sent a state="stopped" notification.
            try {
              await recordCompletedSession(
                applyFinalTick(existing, now),
                { skipSSE: true, stoppedAt: now },
              );
              // Ledger AFTER the write (GR27): a failed record must not ledger-lock
              // the sessionKey for an hour with no history row — let the next poll
              // re-observe the stall and retry the finalize.
              markPlexSessionFinalized(sessionId, nowMs);
            } catch (err) {
              console.warn(`[play-history] stall-finalize failed for ${sessionId}:`, err);
            }
            return "ended";
          }

          const increment = computePlaytimeIncrement(existing, now);
          // Clamp out stale-snapshot backward jitter (see PROGRESS_JITTER_
          // TOLERANCE_MS): keep the fresher stored value on a small backward
          // step, write through a genuine seek-back. playheadMoved above stays
          // on the raw snapshot so liveness/stall detection is unaffected.
          const isJitterBackstep =
            s.viewOffset < priorProgressMs
            && priorProgressMs - s.viewOffset <= PROGRESS_JITTER_TOLERANCE_MS;
          const nextProgressMs = isJitterBackstep ? priorProgressMs : s.viewOffset;
          const nextProgressPercent = s.duration > 0 ? (nextProgressMs / s.duration) * 100 : 0;
          // CAS on (id, lastSeenAt): if SSE or another path deleted/updated the
          // row between our prefetch and this write, updateMany returns 0 and we
          // silently skip instead of throwing P2025 and aborting the whole
          // Promise.all batch. The next poll re-reads state and resumes.
          await prisma.activeSession.updateMany({
            where: { id: sessionId, lastSeenAt: existing.lastSeenAt },
            data: {
              lastSeenAt: now,
              state: s.state,
              progressPercent: nextProgressPercent,
              progressMs: BigInt(nextProgressMs),
              ...(playheadMoved || resumedToPlaying ? { progressUpdatedAt: now } : {}),
              playMethod: s.playMethod,
              resolution: s.resolution,
              transcodeReason: s.transcodeReason ?? null,
              ...(increment > BigInt(0) ? { playtimeMs: { increment } } : {}),
              ...(tmdbId != null ? { tmdbId, mediaType } : {}),
              ...(posterPath ? { posterPath } : {}),
              location: s.location ?? null,
              bandwidth: s.bandwidth ?? null,
              secure: s.secure ?? null,
              relayed: s.relayed ?? null,
            },
          });
          return "updated";
        }
      }

      // DLNA phantom filter: require two consecutive snapshots before
      // creating a new DLNA session. See pendingDlnaSessions comment above.
      if (s.platform === "DLNA") {
        if (!pendingDlnaSessions.has(sessionId)) {
          pendingDlnaSessions.add(sessionId);
          return "skipped";
        }
        pendingDlnaSessions.delete(sessionId);
      }

      // Single-row createMany({skipDuplicates}) → INSERT ... ON CONFLICT DO NOTHING:
      // two overlapping poll ticks can both reach here for a brand-new sessionKey;
      // a bare create() would throw P2002 on the loser, rejecting the tick's
      // Promise.all and skipping its stale-session finalize sweep. (Mirrors the
      // dedup already used by recordCompletedSession in play-history.ts.)
      await prisma.activeSession.createMany({
        data: [{
          id: sessionId,
          source: "plex",
          serverInstance: instance,
          sessionKey: s.sessionKey,
          startedAt: now,
          lastSeenAt: now,
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
          // Strip that exact prefix rather than splitting: `slice(1).join(" — ")`
          // survived an EPISODE name containing " — " but not a SHOW name
          // containing one ("Foo — Bar" + "Pilot" stored "Bar — Pilot"), and this
          // is write-once here and copied verbatim into PlayHistory.
          episodeTitle: s.type === "episode" ? stripShowPrefix(s.title, s.grandparentTitle) : null,
          sourceItemId: s.ratingKey,
          posterPath,
          progressPercent,
          progressMs: BigInt(s.viewOffset),
          durationMs: BigInt(s.duration),
          platform: s.platform ?? null,
          player: s.player ?? null,
          device: s.device ?? null,
          ipAddress: s.address ?? null,
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

      // Best-effort: fetch intro/credits markers in the background and stamp
      // them on the row we just created. Fire-and-forget — markers don't need
      // to block session creation, and a failed fetch (Plex not Plex-Pass,
      // metadata not yet analyzed, network blip) just leaves the columns null.
      // The columns stay frozen for the lifetime of the session; finalize
      // reads them off ActiveSession without a second metadata fetch.
      if (s.ratingKey) {
        void getPlexMarkers(serverUrl, token, s.ratingKey).then(async (markers) => {
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
    }),
  );

  const started = writeResults.filter((r) => r === "started").length;
  const updated = writeResults.filter((r) => r === "updated").length;
  const stallEnded = writeResults.filter((r) => r === "ended").length;

  // serverInstance-scoped: two instances legitimately reuse the same raw
  // sessionKey, and seenSessionKeys only holds THIS server's keys — an
  // unscoped read would let instance A's pass absence-finalize instance B's
  // perfectly live rows (mirrors the Jellyfin sweep's scoping below).
  const activePlexSessions = await prisma.activeSession.findMany({
    where: { source: "plex", serverInstance: instance },
  });

  // Grace window: only finalize sessions that have been missing from
  // /status/sessions for SESSION_ABSENCE_GRACE_MS. A single dropped poll (Plex
  // hiccup, paused client briefly dropped from the snapshot) shouldn't write a
  // PlayHistory row and ledger-lock the sessionKey. Real stops linger up to
  // 60s as "Now Playing" before finalize, but the SSE feed catches them in
  // real-time as long as it's connected; this is the fallback when SSE is down.
  const stale = activePlexSessions.filter(
    (session) =>
      !seenSessionKeys.has(session.sessionKey)
      && nowMs - session.lastSeenAt.getTime() >= SESSION_ABSENCE_GRACE_MS,
  );
  const finalized = await Promise.all(
    stale.map((session) => {
      // skipSSE: caller (syncPlayHistory POST) emits a single batched
      // activity:history-updated after the full sync run completes, so we
      // don't trigger N refetches per cron tick.
      return recordCompletedSession(applyFinalTick(session, now), { skipSSE: true, stoppedAt: now })
        .then(() => {
          // Ledger AFTER the write commits (GR27): gate re-create against a racey
          // Plex reappearance only once the PlayHistory row exists, so a failed
          // write doesn't ledger-lock the sessionKey with no row for an hour.
          markPlexSessionFinalized(session.id, nowMs);
          return true;
        })
        .catch(() => false);
    }),
  );
  const ended = finalized.filter(Boolean).length + stallEnded;

  return { started, updated, ended };
}

async function syncJellyfinSessions(instance: MediaInstanceKey, baseUrl: string, apiKey: string): Promise<SyncResult> {
  const sessions = await getJellyfinSessions(baseUrl, apiKey);
  const now = new Date();

  const valid = sessions.filter((s) => s.playSessionId && s.userId);

  const seenSessionKeys = new Set<string>();
  for (const s of valid) seenSessionKeys.add(s.playSessionId);

  // Resolve media server users so we have msUserId before the existing-row prefetch
  // (the (source, mediaServerUserId, sourceItemId) fallback lookup needs it). Bound
  // concurrency (guardrail 31): each call holds its own $transaction against the max:5
  // pool, and this runs concurrently with the Plex pass — cap below 5.
  const userIds = await mapLimit(valid, 4, (s) =>
    resolveMediaServerUser({
      source: "jellyfin",
      serverInstance: instance,
      sourceUserId: s.userId,
      username: s.userName,
    }),
  );

  // Bulk prefetch: existing ActiveSession rows. Three lookup keys per session — primary id,
  // alternate id (when sessionId !== playSessionId), and the (msUserId, sourceItemId) fallback
  // that handles webhook-vs-polling PlaySessionId drift.
  const primaryIds = valid.map((s) => activeSessionId("jellyfin", instance, s.playSessionId));
  const altIds = valid
    .filter((s) => s.sessionId && s.sessionId !== s.playSessionId)
    .map((s) => activeSessionId("jellyfin", instance, s.sessionId));
  const allIds = [...new Set([...primaryIds, ...altIds])];
  // A row's `id` is frozen at create ("jellyfin:<playSessionId-then>", or
  // "jellyfin:<instance>:<playSessionId-then>" for a named instance) but the
  // update branch REWRITES its `sessionKey` to the current playSessionId. After
  // that the two disagree, so an id-only lookup misses the row — and since
  // ActiveSession is @@unique([source, serverInstance, sessionKey]), the create
  // branch's createMany({skipDuplicates}) then silently swallowed the conflict
  // (ON CONFLICT DO NOTHING, no target) and returned "started" for a row that
  // was never inserted. The next episode got no ActiveSession at all, was never
  // finalized, and — the poller being the sole Jellyfin writer (guardrail 19) —
  // that watch was unrecoverable, while the stale row kept the now-playing card
  // pinned until cleanupStaleSessions reaped it 30 minutes later. Match on the
  // live sessionKey too so the itemId-change finalize below runs instead.
  const allKeys = [...new Set(valid.flatMap((s) => [s.playSessionId, s.sessionId].filter((k): k is string => !!k)))];
  const idRows = allIds.length > 0 || allKeys.length > 0
    ? await prisma.activeSession.findMany({
        where: {
          // sessionKey is only unique WITH (source, serverInstance) — two
          // instances can report the same raw playSessionId, so the
          // serverInstance filter must apply to BOTH the id and sessionKey
          // branches or a same-key row on a different instance could leak in.
          source: "jellyfin",
          serverInstance: instance,
          OR: [{ id: { in: allIds } }, { sessionKey: { in: allKeys } }],
        },
      })
    : [];
  const idRowMap = new Map(idRows.map((r) => [r.id, r]));
  const keyRowMap = new Map(idRows.map((r) => [r.sessionKey, r]));
  // Every row already owned by id OR by live sessionKey — the fallback must not
  // hand any of them to a different session (see the notIn note below).
  const claimedIds = idRows.map((r) => r.id);

  // Fallback rows: only fetch for sessions that didn't match the primary or alternate id.
  const fallbackPairs = valid
    .map((s, i) => {
      const sessionId = activeSessionId("jellyfin", instance, s.playSessionId);
      const altSessionId = s.sessionId && s.sessionId !== s.playSessionId ? activeSessionId("jellyfin", instance, s.sessionId) : null;
      if (idRowMap.has(sessionId) || (altSessionId && idRowMap.has(altSessionId))) return null;
      if (keyRowMap.has(s.playSessionId) || (s.sessionId && keyRowMap.has(s.sessionId))) return null;
      return { msUserId: userIds[i], itemId: s.itemId };
    })
    .filter((p): p is { msUserId: string; itemId: string } => !!p && !!p.itemId);
  // notIn allIds: never hand a row that ANOTHER session in this same snapshot already owns
  // by id to the fallback. Same account + same item on a second device (living-room TV and
  // tablet) otherwise resolves the tablet's new PlaySessionId onto the TV's live row, which
  // rewrites that row instead of creating one — so the second stream never gets an
  // ActiveSession, is never finalized, and (poller being the sole Jellyfin writer, guardrail
  // 19) its watch is unrecoverable. serverInstance scoped too (belt-and-suspenders — mediaServerUserId
  // already pins to one instance's MediaServerUser row transitively, since resolveMediaServerUser
  // never resolves across instances).
  const fallbackRows = fallbackPairs.length > 0
    ? await prisma.activeSession.findMany({
        where: {
          source: "jellyfin",
          serverInstance: instance,
          id: { notIn: claimedIds.length > 0 ? claimedIds : allIds },
          OR: fallbackPairs.map((p) => ({ mediaServerUserId: p.msUserId, sourceItemId: p.itemId })),
        },
      })
    : [];
  const fallbackMap = new Map(fallbackRows.map((r) => [`${r.mediaServerUserId}:${r.sourceItemId ?? ""}`, r]));

  // Bulk prefetch JellyfinLibraryItem for movies whose TMDB id isn't in providerIds.
  const itemIdsNeedingLookup = valid
    .filter((s) => {
      if (s.itemType === "Episode") return false;
      const tmdbRaw = s.providerIds?.Tmdb ?? s.providerIds?.tmdb;
      const parsed = tmdbRaw ? parseInt(tmdbRaw, 10) : NaN;
      return !Number.isFinite(parsed) && !!s.itemId;
    })
    .map((s) => s.itemId);
  const libRows = itemIdsNeedingLookup.length > 0
    ? await prisma.jellyfinLibraryItem.findMany({
        where: { jellyfinItemId: { in: itemIdsNeedingLookup } },
        select: { jellyfinItemId: true, tmdbId: true, mediaType: true },
      })
    : [];
  const libMap = new Map(libRows.map((r) => [r.jellyfinItemId, r]));

  // Resolve TMDB ids per session (TV episodes hit DB via resolveShowTmdbId).
  const resolved = await Promise.all(
    valid.map(async (s, i) => {
      let tmdbId: number | null = null;
      let mediaType: string | null = s.itemType === "Episode" ? "TV" : s.itemType === "Movie" ? "MOVIE" : null;

      if (s.itemType === "Episode") {
        tmdbId = await resolveShowTmdbId("jellyfin", s.seriesId, instance);
      } else {
        const tmdbRaw = s.providerIds?.Tmdb ?? s.providerIds?.tmdb;
        const parsed = tmdbRaw ? parseInt(tmdbRaw, 10) : NaN;
        tmdbId = Number.isFinite(parsed) ? parsed : null;
        if (tmdbId == null && s.itemId) {
          const lib = libMap.get(s.itemId);
          if (lib) {
            tmdbId = lib.tmdbId;
            mediaType = mediaType ?? lib.mediaType;
          }
        }
      }

      return { s, msUserId: userIds[i], tmdbId, mediaType };
    }),
  );

  const posterPairs = Array.from(
    new Map(
      resolved
        .filter((r): r is typeof r & { tmdbId: number; mediaType: string } => r.tmdbId != null && !!r.mediaType)
        .map((r) => [`${r.tmdbId}:${r.mediaType}`, { tmdbId: r.tmdbId, mediaType: r.mediaType as "MOVIE" | "TV" }]),
    ).values(),
  );
  const posterRows = posterPairs.length > 0
    ? await prisma.tmdbMediaCore.findMany({
        where: { OR: posterPairs.map((p) => ({ tmdbId: p.tmdbId, mediaType: p.mediaType })) },
        select: { tmdbId: true, mediaType: true, posterPath: true },
      }).catch(() => [])
    : [];
  const posterMap = new Map(posterRows.map((r) => [`${r.tmdbId}:${r.mediaType}`, r.posterPath]));

  const writeResults = await Promise.all(
    resolved.map(async ({ s, msUserId, tmdbId, mediaType }): Promise<"started" | "updated"> => {
      const sessionId = activeSessionId("jellyfin", instance, s.playSessionId);
      const altSessionId = s.sessionId && s.sessionId !== s.playSessionId ? activeSessionId("jellyfin", instance, s.sessionId) : null;
      const positionMs = Math.floor(s.positionTicks / 10_000);
      const durationMs = Math.floor(s.durationTicks / 10_000);
      const progressPercent = durationMs > 0 ? (positionMs / durationMs) * 100 : 0;
      const resolvedTmdbId = tmdbId && !isNaN(tmdbId) ? tmdbId : null;
      const jfPosterPath = resolvedTmdbId != null && mediaType
        ? posterMap.get(`${resolvedTmdbId}:${mediaType}`) ?? null
        : null;

      // The webhook creates sessions keyed by payload.PlaySessionId, which may not match the
      // Sessions API's PlaySessionId or s.Id for the same playback. Fall back to (userId, itemId)
      // so we update the existing webhook row instead of creating a duplicate. After a match,
      // rewrite the row's sessionKey to the API's playSessionId so subsequent polls find it directly
      // and finalization tracking (seenSessionKeys.has(sessionKey)) stays consistent.
      // The fallback row is single-use: two brand-new streams of the same item by the same
      // account in one tick would otherwise both adopt the one prior row, and the loser
      // would never create its own — losing that watch entirely. The lookup below runs in
      // the synchronous prefix of each mapped callback, so the delete is seen by the next
      // callback before it looks up.
      const idMatch =
        idRowMap.get(sessionId) ??
        (altSessionId ? idRowMap.get(altSessionId) : undefined) ??
        keyRowMap.get(s.playSessionId) ??
        (s.sessionId ? keyRowMap.get(s.sessionId) : undefined);
      const fallbackKey = `${msUserId}:${s.itemId ?? ""}`;
      const fallbackRow = idMatch ? undefined : fallbackMap.get(fallbackKey);
      if (fallbackRow) fallbackMap.delete(fallbackKey);
      const existing = idMatch ?? fallbackRow;

      if (existing) {
        // Auto-play next episode: a Jellyfin client advancing to the next item can
        // reuse the same PlaySessionId while swapping the itemId. The update path below
        // never rewrites title/sourceItemId/episode metadata/durationMs (write-once at
        // create), so without finalizing here the prior item's watch silently merges
        // into the next episode's PlayHistory row. Mirror the Plex ratingKey-change
        // branch (line 223): force-finalize the previous item, then fall through to
        // create a fresh row for the new one.
        if (existing.sourceItemId && s.itemId && existing.sourceItemId !== s.itemId) {
          try {
            await recordCompletedSession(applyFinalTick(existing, now), { skipSSE: true, stoppedAt: now });
          } catch (err) {
            console.warn(`[play-history] itemId-change finalize failed for ${sessionId}:`, err);
          }
          // Fall through to the create branch below — existing is now finalized.
        } else {
          // computePlaytimeIncrement gates on the PRIOR state (existing.state). The
          // hand-rolled version below used to gate on s.state — the new state — so a
          // session that was paused all interval and started playing in the final ms
          // got the full wall-clock interval credited. Plex uses the helper in its
          // branch above; align Jellyfin to it for consistency and correctness.
          const increment = computePlaytimeIncrement(existing, now);
          // CAS on (id, lastSeenAt): mirrors the Plex branch's updateMany above. If the
          // row was deleted/rewritten between our prefetch and this write — an
          // overlapping tick (poll >5s), the same run's absence-finalize, or
          // cleanupStaleSessions — a plain `update` throws P2025 and rejects the
          // whole Promise.all batch, aborting every other session's write this
          // tick. updateMany returns 0 instead, so we silently skip and the next
          // poll re-reads state and resumes.
          await prisma.activeSession.updateMany({
            where: { id: existing.id, lastSeenAt: existing.lastSeenAt },
            data: {
              sessionKey: s.playSessionId,
              lastSeenAt: now,
              state: s.state,
              progressPercent,
              progressMs: BigInt(positionMs),
              playMethod: s.playMethod,
              resolution: s.resolution ?? null,
              transcodeReason: s.transcodeReason ?? null,
              ...(increment > BigInt(0) ? { playtimeMs: { increment } } : {}),
              ...(resolvedTmdbId ? { tmdbId: resolvedTmdbId, mediaType } : {}),
              ...(jfPosterPath ? { posterPath: jfPosterPath } : {}),
            },
          });
          return "updated";
        }
      }

      // See the Plex create above: single-row createMany({skipDuplicates}) so
      // overlapping poll ticks can't reject each other on a duplicate insert.
      await prisma.activeSession.createMany({
        data: [{
          id: sessionId,
          source: "jellyfin",
          serverInstance: instance,
          sessionKey: s.playSessionId,
          startedAt: now,
          lastSeenAt: now,
          state: s.state,
          mediaServerUserId: msUserId,
          serverUsername: s.userName,
          tmdbId: resolvedTmdbId,
          mediaType,

          title: s.itemType === "Episode" ? (s.seriesName ?? s.title) : s.title,
          year: s.year != null ? String(s.year) : null,
          seasonNumber: s.seasonNumber ?? null,
          episodeNumber: s.episodeNumber ?? null,
          episodeTitle: s.itemType === "Episode" ? stripShowPrefix(s.title, s.seriesName) : null,
          sourceItemId: s.itemId,
          posterPath: jfPosterPath,
          progressPercent,
          progressMs: BigInt(positionMs),
          durationMs: BigInt(durationMs),
          platform: s.client ?? null,
          player: s.client ?? null,
          device: s.deviceName ?? null,
          ipAddress: s.remoteEndPoint ?? null,
          playMethod: s.playMethod ?? null,
          videoCodec: s.videoCodec ?? null,
          audioCodec: s.audioCodec ?? null,
          resolution: s.resolution ?? null,
          bitrate: s.bitrate ?? null,
          container: s.container ?? null,
          transcodeReason: s.transcodeReason ?? null,
        }],
        skipDuplicates: true,
      });
      return "started";
    }),
  );

  const started = writeResults.filter((r) => r === "started").length;
  const updated = writeResults.filter((r) => r === "updated").length;

  const activeJfSessions = await prisma.activeSession.findMany({
    where: { source: "jellyfin", serverInstance: instance },
  });

  // Grace window: only finalize sessions missing from /Sessions for
  // SESSION_ABSENCE_GRACE_MS. Jellyfin clients can briefly clear NowPlayingItem
  // (the filter on getJellyfinSessions) during pause-related transitions —
  // browser tab background, app reload, network reconnect — without the user
  // actually stopping. Real stops are detected within ~60s as the trade-off.
  const nowMs = now.getTime();
  const stale = activeJfSessions.filter(
    (session) =>
      !seenSessionKeys.has(session.sessionKey)
      && nowMs - session.lastSeenAt.getTime() >= SESSION_ABSENCE_GRACE_MS,
  );
  const finalized = await Promise.all(
    stale.map((session) =>
      // skipSSE: see Plex branch above; one batched SSE per cron run.
      recordCompletedSession(applyFinalTick(session, now), { skipSSE: true, stoppedAt: now })
        .then(() => true)
        .catch((err) => {
          console.warn(`[play-history] Failed to finalize jellyfin session ${session.id}:`, err);
          return false;
        }),
    ),
  );
  const ended = finalized.filter(Boolean).length;

  return { started, updated, ended };
}

export async function POST(request: NextRequest) {
  if (!(await isCronAuthorized(request))) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }
  return withCronRunRecording("play-history-sync", () => syncPlayHistory(request));
}

async function syncPlayHistory(request: NextRequest) {
  if (!checkRateLimit(`sync-ph:${getClientIp(request.headers)}`, 30, 60_000)) {
    return NextResponse.json({ error: "Too many requests" }, { status: 429 });
  }

  if (!(await isPlayHistoryEnabled())) {
    // Tear the SSE streams down rather than just declining to poll. This early return is
    // BEFORE the reconcile below, so a stream opened while tracking was on stayed open
    // and kept writing PlayHistory + ActiveSession rows from Plex timeline events — the
    // admin turned tracking off and history kept accruing. Idempotent; the next enabled
    // tick re-creates the managers via the normal reconcile.
    stopAllPlexEventStreams();
    return NextResponse.json({ message: "Play history tracking is disabled" });
  }

  // Fire-and-forget: idempotently keep the Plex SSE connection in sync with
  // current Settings. If the URL/token didn't change and the connection is up,
  // this is a near-no-op; if settings were edited via the admin UI we pick up
  // the change within one poll tick.
  reconcilePlexEventStream().catch((err) => {
    console.warn("[plex-events] reconcile failed:", err);
  });

  const results: Record<string, unknown> = {};

  try {
    // Boot re-anchor (once per process, no-op afterwards): give every existing
    // ActiveSession a fresh absence-grace window measured from now, so a
    // restart's downtime doesn't make this run's stale sweep finalize a session
    // that's still playing. Covers Plex AND Jellyfin in one write; if the SSE
    // bootstrap already ran it, this is a no-op. Must run before the source
    // syncs read their ActiveSession rows below.
    await reanchorActiveSessionsOnBoot();

    const [plexEnabled, jellyfinEnabled] = await Promise.all([
      isSourceEnabled("plex"),
      isSourceEnabled("jellyfin"),
    ]);

    const syncPromises: Promise<void>[] = [];

    if (plexEnabled) {
      // Fixed single call widened to a loop over every configured Plex server
      // (multi-server support), mirroring the Jellyfin loop below with ONE
      // deliberate asymmetry: the instance list comes from getMediaInstances
      // (a single registry findUnique on `plexInstances`) + a per-instance
      // getPlexConfig read (two findUniques) + the skip-if-unconfigured
      // `continue` below — NOT getSyncableMediaInstances, whose
      // isMediaInstanceConfigured check issues a connection-keys findMany
      // byte-identical in shape to plex-events' own per-manager doReconcile
      // read. The route's test harness starves plex-events' reads BY SHAPE
      // (any findMany over plex connection keys) so reconcile never opens a
      // real SSE stream under test; the route's own config reads must
      // therefore stay findUnique-shaped. The `continue` reproduces
      // getSyncableMediaInstances' filter semantics exactly.
      const plexInstances = await getMediaInstances("plex");
      for (const instance of plexInstances) {
        const label = mediaInstanceLabel("plex", instance.slug);
        let cfg: { url: string | null; token: string | null };
        try {
          cfg = await getPlexConfig(instance.slug);
        } catch (err) {
          // Isolate a config-read failure to just this instance — see the
          // Jellyfin loop below for the full rationale.
          const msg = err instanceof Error ? err.message : String(err);
          console.warn(`[play-history] Plex config read failed for instance "${instance.slug}":`, msg);
          results[label] = { error: msg };
          continue;
        }
        if (!cfg.url || !cfg.token) continue; // unconfigured instance — the getSyncableMediaInstances-equivalent filter (see above)
        const serverUrl = cfg.url.replace(/\/$/, "");
        const token = cfg.token;
        syncPromises.push(
          syncPlexSessions(instance.slug, serverUrl, token)
            .then((r) => { results[label] = r; })
            .catch((err) => {
              const msg = err instanceof Error ? err.message : String(err);
              console.warn(`[play-history] Plex session sync failed for instance "${instance.slug}":`, msg);
              results[label] = { error: msg };
            })
        );
      }
    }

    if (jellyfinEnabled) {
      // Fixed single call widened to a loop over every configured, connection-
      // ready Jellyfin server (multi-server support). Sequential resolution of
      // each instance's config, but the actual session syncs still run
      // concurrently (same syncPromises array as the Plex pass above).
      const jellyfinInstances = await getSyncableMediaInstances("jellyfin");
      for (const instance of jellyfinInstances) {
        const label = mediaInstanceLabel("jellyfin", instance.slug);
        let cfg: { url: string | null; apiKey: string | null };
        try {
          cfg = await getJellyfinConfig(instance.slug);
        } catch (err) {
          // Isolate a config-read failure to just this instance, matching every
          // other failure mode below. An uncaught throw here would abort the
          // loop entirely and 500 the whole poll tick via the outer catch,
          // discarding Plex's and any earlier instances' already-queued results
          // over a transient blip on one instance's Settings read.
          const msg = err instanceof Error ? err.message : String(err);
          console.warn(`[play-history] Jellyfin config read failed for instance "${instance.slug}":`, msg);
          results[label] = { error: msg };
          continue;
        }
        if (!cfg.url || !cfg.apiKey) continue; // defensive; getSyncableMediaInstances already filters to configured ones
        const url = cfg.url.replace(/\/$/, "");
        const apiKey = cfg.apiKey;
        syncPromises.push(
          syncJellyfinSessions(instance.slug, url, apiKey)
            .then((r) => { results[label] = r; })
            .catch((err) => {
              const msg = err instanceof Error ? err.message : String(err);
              console.warn(`[play-history] Jellyfin session sync failed for instance "${instance.slug}":`, msg);
              results[label] = { error: msg };
            })
        );
      }
    }

    await Promise.all(syncPromises);

    // Single batched activity:history-updated after every source loop completes
    // (one entry per configured Plex and Jellyfin instance). recordCompletedSession
    // is called with skipSSE inside each loop to avoid N+1 events. Emit only when
    // at least one session actually ended. Summed generically over `results`'
    // current keys (plex, plex:<slug>, jellyfin, jellyfin:<slug>, …) rather than
    // two hardcoded fields, since both sources now contribute a variable number
    // of entries.
    const totalEnded = Object.values(results).reduce((sum: number, r) => {
      const ended = (r as { ended?: unknown } | null)?.ended;
      return sum + (typeof ended === "number" ? ended : 0);
    }, 0);
    if (totalEnded > 0) {
      emitSSE({ type: "activity:history-updated" });
    }

    await emitActiveSessionsSnapshot();

    await cleanupStaleSessions(30);

    const now = Date.now();

    // Atomic CAS: only the first caller within a 1-hour window performs the retention purge.
    // Regex-guard the CAST: a non-numeric value (e.g. left over from a manual edit) would otherwise
    // crash the route. Treat a non-numeric value as expired so the next run overwrites it.
    const retentionClaimed = await prisma.$executeRaw`
      INSERT INTO "Setting" (key, value, "updatedAt")
      VALUES ('lastRetentionCheckAt', ${String(now)}, NOW())
      ON CONFLICT (key) DO UPDATE
        SET value = EXCLUDED.value, "updatedAt" = NOW()
      WHERE "Setting".value !~ '^[0-9]+$'
         OR CAST("Setting".value AS BIGINT) + ${3600_000}::bigint <= ${now}::bigint
    `;
    if (retentionClaimed > 0) {
      const purged = await purgeOldHistory();
      if (purged > 0) results.purged = purged;
    }
  } catch (err) {
    console.error("[sync-play-history]", err);
    return NextResponse.json({ error: "Sync failed" }, { status: 500 });
  }

  // Surface degraded runs to withCronRunRecording via the X-Cron-Degraded header
  // (a failed source previously still recorded ok:true, hiding the outage from
  // the admin System tab). Status stays 200 — this route runs every 5s from the
  // entrypoint poller, and a non-2xx during a media-server outage would spam the
  // docker logs with a failure line per tick. Checked generically over `results`'
  // keys (plex, plex:<slug>, jellyfin, jellyfin:<slug>, …) — `results.purged` (a bare number,
  // set above on the retention-purge path) safely fails the object/error checks
  // below and is never mistaken for a degraded source.
  const degraded = Object.entries(results)
    .filter(([, r]) => typeof r === "object" && r !== null && (r as { error?: unknown }).error !== undefined)
    .map(([key]) => key);
  return NextResponse.json(
    results,
    degraded.length > 0 ? { headers: { "X-Cron-Degraded": degraded.join(",") } } : undefined,
  );
}
