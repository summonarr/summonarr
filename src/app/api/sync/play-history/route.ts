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
import { emitSSE } from "@/lib/sse-emitter";
import { isCronAuthorized, withCronRunRecording } from "@/lib/cron-auth";
import {
  PLEX_STALL_THRESHOLD_MS,
  clearFinalizedNotInCurrentSnapshot,
  isPlexSessionRecentlyFinalized,
  markPlexSessionFinalized,
  pruneRecentlyFinalized,
  reconcilePlexEventStream,
  setPlexReachable,
} from "@/lib/plex-events";

type SyncResult = { started: number; updated: number; ended: number };

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

async function syncPlexSessions(serverUrl: string, token: string): Promise<SyncResult> {
  // getPlexSessions is the authoritative local-reachability probe — it runs
  // every poll. Report the result so the UI's reachability badge reflects
  // whether Summonarr can actually reach the Plex server (not plex.tv remote
  // access). Fire-and-forget; the persist is deduped + only writes on change.
  let sessions;
  try {
    sessions = await getPlexSessions(serverUrl, token);
  } catch (err) {
    void setPlexReachable(false);
    throw err;
  }
  void setPlexReachable(true);
  const now = new Date();
  const nowMs = now.getTime();
  pruneRecentlyFinalized(nowMs);

  // Release ledger entries Plex has stopped reporting before the create-gate
  // checks it. The ledger exists to suppress re-creation while Plex keeps a
  // ghost in /status/sessions; once Plex drops the key, a new play reusing it
  // (rare, but possible after a Plex server restart) shouldn't be blocked.
  const allReportedKeys = new Set<string>();
  for (const s of sessions) {
    if (s.sessionKey) allReportedKeys.add(s.sessionKey);
  }
  clearFinalizedNotInCurrentSnapshot(allReportedKeys);

  // Filter sessions with required identifiers up front so prefetch sets are accurate.
  // Skip sessions Plex is still reporting after we've already finalized them via
  // SSE stop, stall detection, or the stale loop — they'd otherwise be re-created
  // on every poll.
  const valid = sessions.filter(
    (s) => s.sessionKey && s.accountId && !isPlexSessionRecentlyFinalized(`plex:${s.sessionKey}`),
  );
  if (valid.length === 0) {
    // Still need the cleanup sweep below to finalize any stale rows.
  }

  // Resolve the admin's Plex user id once per run so we can mark
  // MediaServerUser.isServerAdmin for the server-owner row (Plex sessions
  // don't carry an admin flag; the owner is whoever owns the admin token).
  // Best-effort: if the call fails, isServerAdmin stays unset on this run.
  const plexAdminId = await getPlexUser(token)
    .then((u) => u.id)
    .catch(() => null);

  const seenSessionKeys = new Set<string>();
  for (const s of valid) seenSessionKeys.add(s.sessionKey);

  // Bulk prefetch: existing ActiveSession rows for these IDs in a single query.
  const sessionIds = valid.map((s) => `plex:${s.sessionKey}`);
  const existingRows = sessionIds.length > 0
    ? await prisma.activeSession.findMany({ where: { id: { in: sessionIds } } })
    : [];
  const existingMap = new Map(existingRows.map((r) => [r.id, r]));

  // Bulk prefetch: PlexLibraryItem fallbacks for movies whose TMDB id isn't in Guid.
  const ratingKeysNeedingLookup = valid
    .filter((s) => s.type !== "episode" && extractTmdbIdFromGuids(s.Guid) == null && !!s.ratingKey)
    .map((s) => s.ratingKey);
  const libRows = ratingKeysNeedingLookup.length > 0
    ? await prisma.plexLibraryItem.findMany({
        where: { plexRatingKey: { in: ratingKeysNeedingLookup } },
        select: { plexRatingKey: true, tmdbId: true, mediaType: true },
      })
    : [];
  const libMap = new Map(libRows.map((r) => [r.plexRatingKey, r]));

  // Resolve media server users in parallel — each upserts independently.
  // isServerAdmin = accountId matches the admin token's plex user id. When
  // plexAdminId couldn't be fetched, leave the flag undefined so the upsert
  // doesn't blindly flip an existing true→false.
  const userIds = await Promise.all(
    valid.map((s) =>
      resolveMediaServerUser({
        source: "plex",
        sourceUserId: s.accountId,
        username: s.accountName,
        thumbUrl: s.accountThumb || null,
        ...(plexAdminId !== null ? { isServerAdmin: s.accountId === plexAdminId } : {}),
      }),
    ),
  );

  // Resolve TMDB ids per session (TV episodes hit DB, movies are mostly in-memory).
  const resolved = await Promise.all(
    valid.map(async (s, i) => {
      const sessionId = `plex:${s.sessionKey}`;
      let tmdbId: number | null = null;
      let mediaType: string | null = s.type === "episode" ? "TV" : s.type === "movie" ? "MOVIE" : null;

      if (s.type === "episode") {
        // For episodes, resolve the TMDB ID from the show (grandparent), not the episode item itself
        tmdbId = await resolveShowTmdbId("plex", s.grandparentRatingKey);
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

  // Drop DLNA gate entries Plex is no longer reporting — the phantom is
  // gone and the slot shouldn't keep a future *real* session waiting.
  const seenInThisPoll = new Set(valid.map((s) => `plex:${s.sessionKey}`));
  for (const pending of pendingDlnaSessions) {
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
          episodeTitle: s.type === "episode" ? (s.title.split(" — ")[1] ?? null) : null,
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

  const activePlexSessions = await prisma.activeSession.findMany({
    where: { source: "plex" },
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

async function syncJellyfinSessions(baseUrl: string, apiKey: string): Promise<SyncResult> {
  const sessions = await getJellyfinSessions(baseUrl, apiKey);
  const now = new Date();

  const valid = sessions.filter((s) => s.playSessionId && s.userId);

  const seenSessionKeys = new Set<string>();
  for (const s of valid) seenSessionKeys.add(s.playSessionId);

  // Resolve media server users in parallel so we have msUserId before the existing-row prefetch
  // (the (source, mediaServerUserId, sourceItemId) fallback lookup needs it).
  const userIds = await Promise.all(
    valid.map((s) =>
      resolveMediaServerUser({
        source: "jellyfin",
        sourceUserId: s.userId,
        username: s.userName,
      }),
    ),
  );

  // Bulk prefetch: existing ActiveSession rows. Three lookup keys per session — primary id,
  // alternate id (when sessionId !== playSessionId), and the (msUserId, sourceItemId) fallback
  // that handles webhook-vs-polling PlaySessionId drift.
  const primaryIds = valid.map((s) => `jellyfin:${s.playSessionId}`);
  const altIds = valid
    .filter((s) => s.sessionId && s.sessionId !== s.playSessionId)
    .map((s) => `jellyfin:${s.sessionId}`);
  const allIds = [...new Set([...primaryIds, ...altIds])];
  const idRows = allIds.length > 0
    ? await prisma.activeSession.findMany({ where: { id: { in: allIds } } })
    : [];
  const idRowMap = new Map(idRows.map((r) => [r.id, r]));

  // Fallback rows: only fetch for sessions that didn't match the primary or alternate id.
  const fallbackPairs = valid
    .map((s, i) => {
      const sessionId = `jellyfin:${s.playSessionId}`;
      const altSessionId = s.sessionId && s.sessionId !== s.playSessionId ? `jellyfin:${s.sessionId}` : null;
      if (idRowMap.has(sessionId) || (altSessionId && idRowMap.has(altSessionId))) return null;
      return { msUserId: userIds[i], itemId: s.itemId };
    })
    .filter((p): p is { msUserId: string; itemId: string } => !!p && !!p.itemId);
  const fallbackRows = fallbackPairs.length > 0
    ? await prisma.activeSession.findMany({
        where: {
          source: "jellyfin",
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
        tmdbId = await resolveShowTmdbId("jellyfin", s.seriesId);
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
      const sessionId = `jellyfin:${s.playSessionId}`;
      const altSessionId = s.sessionId && s.sessionId !== s.playSessionId ? `jellyfin:${s.sessionId}` : null;
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
      const existing =
        idRowMap.get(sessionId) ??
        (altSessionId ? idRowMap.get(altSessionId) : undefined) ??
        fallbackMap.get(`${msUserId}:${s.itemId ?? ""}`);

      if (existing) {
        // computePlaytimeIncrement gates on the PRIOR state (existing.state). The
        // hand-rolled version below used to gate on s.state — the new state — so a
        // session that was paused all interval and started playing in the final ms
        // got the full wall-clock interval credited. Plex uses the helper at line 178;
        // align Jellyfin to it for consistency and correctness.
        const increment = computePlaytimeIncrement(existing, now);
        // CAS on (id, lastSeenAt): mirrors the Plex branch (line 244). If the
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

      // See the Plex create above: single-row createMany({skipDuplicates}) so
      // overlapping poll ticks can't reject each other on a duplicate insert.
      await prisma.activeSession.createMany({
        data: [{
          id: sessionId,
          source: "jellyfin",
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
          episodeTitle: s.itemType === "Episode" ? (s.title.split(" — ").slice(1).join(" — ") || null) : null,
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
    where: { source: "jellyfin" },
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

const SYNC_SETTING_KEYS = ["plexServerUrl", "plexAdminToken", "jellyfinUrl", "jellyfinApiKey"] as const;

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

    const [plexEnabled, jellyfinEnabled, settingRows] = await Promise.all([
      isSourceEnabled("plex"),
      isSourceEnabled("jellyfin"),
      prisma.setting.findMany({
        where: { key: { in: SYNC_SETTING_KEYS as unknown as string[] } },
        select: { key: true, value: true },
      }),
    ]);

    const settingMap = new Map(settingRows.map((r) => [r.key, r.value]));
    const plexServerUrl = settingMap.get("plexServerUrl")?.replace(/\/$/, "") ?? null;
    const plexAdminToken = settingMap.get("plexAdminToken") ?? null;
    const jellyfinUrl = settingMap.get("jellyfinUrl")?.replace(/\/$/, "") ?? null;
    const jellyfinApiKey = settingMap.get("jellyfinApiKey") ?? null;

    const syncPromises: Promise<void>[] = [];

    if (plexEnabled && plexServerUrl && plexAdminToken) {
      syncPromises.push(
        syncPlexSessions(plexServerUrl, plexAdminToken)
          .then((r) => { results.plex = r; })
          .catch((err) => {
            const msg = err instanceof Error ? err.message : String(err);
            console.warn("[play-history] Plex session sync failed:", msg);
            results.plex = { error: msg };
          })
      );
    }

    if (jellyfinEnabled && jellyfinUrl && jellyfinApiKey) {
      syncPromises.push(
        syncJellyfinSessions(jellyfinUrl, jellyfinApiKey)
          .then((r) => { results.jellyfin = r; })
          .catch((err) => {
            const msg = err instanceof Error ? err.message : String(err);
            console.warn("[play-history] Jellyfin session sync failed:", msg);
            results.jellyfin = { error: msg };
          })
      );
    }

    await Promise.all(syncPromises);

    // Single batched activity:history-updated after both source loops complete.
    // recordCompletedSession is called with skipSSE inside each loop to avoid
    // N+1 events. Emit only when at least one session actually ended.
    // Parens are load-bearing: `+` binds tighter than `??`, so without them
    // `a?.x ?? 0 + b?.y ?? 0` parses as `a?.x ?? (0 + (b?.y ?? 0))` and a
    // defined `plex.ended = 0` would short-circuit, silently dropping Jellyfin's count.
    const totalEnded =
      ((results.plex as { ended?: number } | undefined)?.ended ?? 0) +
      ((results.jellyfin as { ended?: number } | undefined)?.ended ?? 0);
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

  return NextResponse.json(results);
}
