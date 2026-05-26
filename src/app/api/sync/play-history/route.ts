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
  MAX_PLAYTIME_DELTA_MS,
} from "@/lib/play-history";
import { getPlexSessions, extractTmdbIdFromGuids, getPlexUser } from "@/lib/plex";
import { getJellyfinSessions } from "@/lib/jellyfin";
import { emitSSE } from "@/lib/sse-emitter";
import { posterUrl } from "@/lib/tmdb-types";
import { isCronAuthorized, withCronRunRecording } from "@/lib/cron-auth";

type SyncResult = { started: number; updated: number; ended: number };

// Plex sometimes keeps a quit session in /status/sessions for up to 30 min
// (mobile/TV clients that close without a clean Stop). When the playhead has
// not advanced for this long while state still reports "playing", treat it as
// a quit and finalize early.
const PLEX_STALL_THRESHOLD_MS = 60_000;

// In-memory ledger of Plex sessions finalized via the stall path or the stale
// loop. Keyed by ActiveSession.id ("plex:<sessionKey>"). Lets the next polls
// skip re-creating the row while Plex's /status/sessions still includes the
// ghost. Persists across polls inside the same Node process (single
// long-lived server per guardrail 17); a restart loses the ledger but Plex
// has usually dropped the session by then, and the stall detector re-fires
// otherwise.
const recentlyFinalizedPlexSessions = new Map<string, number>();
const RECENTLY_FINALIZED_TTL_MS = 60 * 60 * 1000;

function pruneRecentlyFinalized(nowMs: number): void {
  for (const [id, finalizedAt] of recentlyFinalizedPlexSessions) {
    if (nowMs - finalizedAt > RECENTLY_FINALIZED_TTL_MS) {
      recentlyFinalizedPlexSessions.delete(id);
    }
  }
}

async function syncPlexSessions(serverUrl: string, token: string): Promise<SyncResult> {
  const sessions = await getPlexSessions(serverUrl, token);
  const now = new Date();
  const nowMs = now.getTime();
  pruneRecentlyFinalized(nowMs);

  // Filter sessions with required identifiers up front so prefetch sets are accurate.
  // Skip sessions Plex is still reporting after we've already finalized them via
  // stall detection or the stale loop — they'd otherwise be re-created on every poll.
  const valid = sessions.filter(
    (s) => s.sessionKey && s.accountId && !recentlyFinalizedPlexSessions.has(`plex:${s.sessionKey}`),
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

  // Run per-session writes in parallel.
  const writeResults = await Promise.all(
    resolved.map(async ({ s, sessionId, msUserId, tmdbId, mediaType }): Promise<"started" | "updated" | "ended"> => {
      const progressPercent = s.duration > 0 ? (s.viewOffset / s.duration) * 100 : 0;
      const posterPath = tmdbId != null && mediaType ? posterMap.get(`${tmdbId}:${mediaType}`) ?? null : null;

      const existing = existingMap.get(sessionId);
      if (existing) {
        const advanced = s.viewOffset > Number(existing.progressMs);
        const stalled =
          s.state === "playing"
          && !advanced
          && nowMs - existing.progressUpdatedAt.getTime() >= PLEX_STALL_THRESHOLD_MS;

        if (stalled) {
          // Ghost session: Plex still reports it but the playhead has been frozen for
          // PLEX_STALL_THRESHOLD_MS while state="playing". Finalize now and gate
          // re-create so subsequent polls don't resurrect it.
          recentlyFinalizedPlexSessions.set(sessionId, nowMs);
          try {
            await recordCompletedSession(
              applyFinalTick(existing, now, { stoppedAt: now }),
              { skipSSE: true },
            );
          } catch (err) {
            console.warn(`[play-history] stall-finalize failed for ${sessionId}:`, err);
          }
          return "ended";
        }

        const increment = computePlaytimeIncrement(existing, now);
        await prisma.activeSession.update({
          where: { id: sessionId },
          data: {
            lastSeenAt: now,
            state: s.state,
            progressPercent,
            progressMs: BigInt(s.viewOffset),
            ...(advanced ? { progressUpdatedAt: now } : {}),
            playMethod: s.playMethod,
            resolution: s.resolution,
            transcodeReason: s.transcodeReason ?? null,
            ...(increment > BigInt(0) ? { playtimeMs: { increment } } : {}),
            ...(tmdbId != null ? { tmdbId, mediaType } : {}),
            ...(posterPath ? { posterPath } : {}),
          },
        });
        return "updated";
      }
      await prisma.activeSession.create({
        data: {
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
        },
      });
      return "started";
    }),
  );

  const started = writeResults.filter((r) => r === "started").length;
  const updated = writeResults.filter((r) => r === "updated").length;
  const stallEnded = writeResults.filter((r) => r === "ended").length;

  const activePlexSessions = await prisma.activeSession.findMany({
    where: { source: "plex" },
  });

  const stale = activePlexSessions.filter((session) => !seenSessionKeys.has(session.sessionKey));
  const finalized = await Promise.all(
    stale.map((session) => {
      // Gate re-create against a racey Plex /status/sessions reappearance,
      // same as the stall path above.
      recentlyFinalizedPlexSessions.set(session.id, nowMs);
      // skipSSE: caller (syncPlayHistory POST) emits a single batched
      // activity:history-updated after the full sync run completes, so we
      // don't trigger N refetches per cron tick.
      return recordCompletedSession(applyFinalTick(session, now, { stoppedAt: now }), { skipSSE: true })
        .then(() => true)
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
        const wallDelta = now.getTime() - existing.lastSeenAt.getTime();
        const posDelta = positionMs - Number(existing.progressMs);
        const increment = (posDelta > 0 || s.state === "playing")
          ? BigInt(Math.min(MAX_PLAYTIME_DELTA_MS, Math.max(0, wallDelta)))
          : BigInt(0);
        await prisma.activeSession.update({
          where: { id: existing.id },
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

      await prisma.activeSession.create({
        data: {
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
          episodeTitle: s.itemType === "Episode" ? (s.title.split(" — ")[1] ?? null) : null,
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
        },
      });
      return "started";
    }),
  );

  const started = writeResults.filter((r) => r === "started").length;
  const updated = writeResults.filter((r) => r === "updated").length;

  const activeJfSessions = await prisma.activeSession.findMany({
    where: { source: "jellyfin" },
  });

  const stale = activeJfSessions.filter((session) => !seenSessionKeys.has(session.sessionKey));
  const finalized = await Promise.all(
    stale.map((session) =>
      // skipSSE: see Plex branch above; one batched SSE per cron run.
      recordCompletedSession(applyFinalTick(session, now, { stoppedAt: now }), { skipSSE: true })
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

  const results: Record<string, unknown> = {};

  try {
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
    const totalEnded = (results.plex as { ended?: number } | undefined)?.ended ?? 0
      + ((results.jellyfin as { ended?: number } | undefined)?.ended ?? 0);
    if (totalEnded > 0) {
      emitSSE({ type: "activity:history-updated" });
    }

    const allSessions = await prisma.activeSession.findMany({
      orderBy: { startedAt: "desc" },
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
            if (Number.isFinite(id) && id > 0 && !sessionPosterMap[id]) sessionPosterMap[id] = posterUrl(parsed.posterPath, "w342");
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
        posterUrl: s.tmdbId ? sessionPosterMap[s.tmdbId] ?? null : null,
      })),
    });

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
