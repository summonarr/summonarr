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
import { getPlexSessions, extractTmdbIdFromGuids, type PlexSessionData } from "@/lib/plex";
import { getJellyfinSessions, type JellyfinSessionData } from "@/lib/jellyfin";
import { emitSSE } from "@/lib/sse-emitter";
import { posterUrl } from "@/lib/tmdb-types";
import { isCronAuthorized } from "@/lib/cron-auth";

async function syncPlexSessions(): Promise<{ started: number; updated: number; ended: number }> {
  const [serverUrlRow, tokenRow] = await Promise.all([
    prisma.setting.findUnique({ where: { key: "plexServerUrl" } }),
    prisma.setting.findUnique({ where: { key: "plexAdminToken" } }),
  ]);

  if (!serverUrlRow?.value || !tokenRow?.value) return { started: 0, updated: 0, ended: 0 };

  const serverUrl = serverUrlRow.value.replace(/\/$/, "");
  const sessions = await getPlexSessions(serverUrl, tokenRow.value);
  const now = new Date();
  let started = 0;
  let updated = 0;

  const seenSessionKeys = new Set<string>();

  for (const s of sessions) {
    if (!s.sessionKey || !s.accountId) continue;
    seenSessionKeys.add(s.sessionKey);

    const msUserId = await resolveMediaServerUser({
      source: "plex",
      sourceUserId: s.accountId,
      username: s.accountName,
      thumbUrl: s.accountThumb || null,
    });

    const sessionId = `plex:${s.sessionKey}`;
    let tmdbId: number | null = null;
    let mediaType: string | null = s.type === "episode" ? "TV" : s.type === "movie" ? "MOVIE" : null;

    if (s.type === "episode") {
      // For episodes, resolve the TMDB ID from the show (grandparent), not the episode item itself
      tmdbId = await resolveShowTmdbId("plex", s.grandparentRatingKey);
    } else {
      tmdbId = extractTmdbIdFromGuids(s.Guid);
      if (tmdbId == null && s.ratingKey) {
        const lib = await prisma.plexLibraryItem.findFirst({
          where: { plexRatingKey: s.ratingKey },
          select: { tmdbId: true, mediaType: true },
        });
        if (lib) {
          tmdbId = lib.tmdbId;
          mediaType = mediaType ?? lib.mediaType;
        }
      }
    }

    const progressPercent = s.duration > 0 ? (s.viewOffset / s.duration) * 100 : 0;

    let posterPath: string | null = null;
    if (tmdbId && mediaType) {
      const core = await prisma.tmdbMediaCore.findUnique({
        where: { tmdbId_mediaType: { tmdbId, mediaType: mediaType as "MOVIE" | "TV" } },
        select: { posterPath: true },
      }).catch(() => null);
      posterPath = core?.posterPath ?? null;
    }

    const existing = await prisma.activeSession.findUnique({ where: { id: sessionId } });
    if (existing) {
      const increment = computePlaytimeIncrement(existing, now);
      await prisma.activeSession.update({
        where: { id: sessionId },
        data: {
          lastSeenAt: now,
          state: s.state,
          progressPercent,
          progressMs: BigInt(s.viewOffset),
          playMethod: s.playMethod,
          resolution: s.resolution,
          ...(increment > BigInt(0) ? { playtimeMs: { increment } } : {}),
          ...(tmdbId != null ? { tmdbId, mediaType } : {}),
          ...(posterPath ? { posterPath } : {}),
        },
      });
      updated++;
    } else {
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
        },
      });
      started++;
    }
  }

  const activePlexSessions = await prisma.activeSession.findMany({
    where: { source: "plex" },
  });

  let ended = 0;
  for (const session of activePlexSessions) {
    if (!seenSessionKeys.has(session.sessionKey)) {
      try {
        await recordCompletedSession(applyFinalTick(session, now, { stoppedAt: now }));
        ended++;
      } catch {

      }
    }
  }

  return { started, updated, ended };
}

async function syncJellyfinSessions(): Promise<{ started: number; updated: number; ended: number }> {
  const [urlRow, keyRow] = await Promise.all([
    prisma.setting.findUnique({ where: { key: "jellyfinUrl" } }),
    prisma.setting.findUnique({ where: { key: "jellyfinApiKey" } }),
  ]);

  if (!urlRow?.value || !keyRow?.value) return { started: 0, updated: 0, ended: 0 };

  const baseUrl = urlRow.value.replace(/\/$/, "");
  const sessions = await getJellyfinSessions(baseUrl, keyRow.value);
  const now = new Date();
  let started = 0;
  let updated = 0;

  const seenSessionKeys = new Set<string>();

  for (const s of sessions) {
    if (!s.playSessionId || !s.userId) continue;
    seenSessionKeys.add(s.playSessionId);

    const msUserId = await resolveMediaServerUser({
      source: "jellyfin",
      sourceUserId: s.userId,
      username: s.userName,
    });

    const sessionId = `jellyfin:${s.playSessionId}`;
    let tmdbId: number | null = null;
    let mediaType: string | null = s.itemType === "Episode" ? "TV" : s.itemType === "Movie" ? "MOVIE" : null;

    if (s.itemType === "Episode") {
      // For episodes, resolve TMDB ID from the series, not the episode item
      tmdbId = await resolveShowTmdbId("jellyfin", s.seriesId);
    } else {
      const tmdbRaw = s.providerIds?.Tmdb ?? s.providerIds?.tmdb;
      const parsed = tmdbRaw ? parseInt(tmdbRaw, 10) : NaN;
      tmdbId = Number.isFinite(parsed) ? parsed : null;
      if (tmdbId == null && s.itemId) {
        const lib = await prisma.jellyfinLibraryItem.findFirst({
          where: { jellyfinItemId: s.itemId },
          select: { tmdbId: true, mediaType: true },
        });
        if (lib) {
          tmdbId = lib.tmdbId;
          mediaType = mediaType ?? lib.mediaType;
        }
      }
    }

    const positionMs = Math.floor(s.positionTicks / 10_000);
    const durationMs = Math.floor(s.durationTicks / 10_000);
    const progressPercent = durationMs > 0 ? (positionMs / durationMs) * 100 : 0;

    let jfPosterPath: string | null = null;
    const resolvedTmdbId = tmdbId && !isNaN(tmdbId) ? tmdbId : null;
    if (resolvedTmdbId && mediaType) {
      const core = await prisma.tmdbMediaCore.findUnique({
        where: { tmdbId_mediaType: { tmdbId: resolvedTmdbId, mediaType: mediaType as "MOVIE" | "TV" } },
        select: { posterPath: true },
      }).catch(() => null);
      jfPosterPath = core?.posterPath ?? null;
    }

    // The webhook creates sessions keyed by payload.PlaySessionId, which may not match the
    // Sessions API's PlaySessionId or s.Id for the same playback. Fall back to (userId, itemId)
    // so we update the existing webhook row instead of creating a duplicate. After a match,
    // rewrite the row's sessionKey to the API's playSessionId so subsequent polls find it directly
    // and finalization tracking (seenSessionKeys.has(sessionKey)) stays consistent.
    const altSessionId = s.sessionId && s.sessionId !== s.playSessionId ? `jellyfin:${s.sessionId}` : null;
    const existing =
      (await prisma.activeSession.findUnique({ where: { id: sessionId } })) ??
      (altSessionId ? await prisma.activeSession.findUnique({ where: { id: altSessionId } }) : null) ??
      (await prisma.activeSession.findFirst({
        where: { source: "jellyfin", mediaServerUserId: msUserId, sourceItemId: s.itemId },
      }));
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
          ...(increment > BigInt(0) ? { playtimeMs: { increment } } : {}),
          ...(resolvedTmdbId ? { tmdbId: resolvedTmdbId, mediaType } : {}),
          ...(jfPosterPath ? { posterPath: jfPosterPath } : {}),
        },
      });
      updated++;
    } else {
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
        },
      });
      started++;
    }
  }

  const activeJfSessions = await prisma.activeSession.findMany({
    where: { source: "jellyfin" },
  });

  let ended = 0;
  for (const session of activeJfSessions) {
    if (!seenSessionKeys.has(session.sessionKey)) {
      try {
        await recordCompletedSession(applyFinalTick(session, now, { stoppedAt: now }));
        ended++;
      } catch (err) {
        console.warn(`[play-history] Failed to finalize jellyfin session ${session.id}:`, err);
      }
    }
  }

  return { started, updated, ended };
}

export async function POST(request: NextRequest) {
  if (!(await isCronAuthorized(request))) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  if (!checkRateLimit(`sync-ph:${getClientIp(request.headers)}`, 30, 60_000)) {
    return NextResponse.json({ error: "Too many requests" }, { status: 429 });
  }

  if (!(await isPlayHistoryEnabled())) {
    return NextResponse.json({ message: "Play history tracking is disabled" });
  }

  const results: Record<string, unknown> = {};

  try {
    const [plexEnabled, jellyfinEnabled] = await Promise.all([
      isSourceEnabled("plex"),
      isSourceEnabled("jellyfin"),
    ]);

    const syncPromises: Promise<void>[] = [];

    if (plexEnabled) {
      syncPromises.push(
        syncPlexSessions()
          .then((r) => { results.plex = r; })
          .catch((err) => {
            const msg = err instanceof Error ? err.message : String(err);
            console.warn("[play-history] Plex session sync failed:", msg);
            results.plex = { error: msg };
          })
      );
    }

    if (jellyfinEnabled) {
      syncPromises.push(
        syncJellyfinSessions()
          .then((r) => { results.jellyfin = r; })
          .catch((err) => {
            const msg = err instanceof Error ? err.message : String(err);
            console.warn("[play-history] Jellyfin session sync failed:", msg);
            results.jellyfin = { error: msg };
          })
      );
    }

    await Promise.all(syncPromises);

    const allSessions = await prisma.activeSession.findMany({ orderBy: { startedAt: "desc" } });

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
            const id = parseInt(row.key.split(":")[1], 10);
            if (id && !sessionPosterMap[id]) sessionPosterMap[id] = posterUrl(parsed.posterPath, "w342");
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

    // Atomic CAS: only the first caller within a 1-hour window performs the retention purge
    const retentionClaimed = await prisma.$executeRaw`
      INSERT INTO "Setting" (key, value, "updatedAt")
      VALUES ('lastRetentionCheckAt', ${String(now)}, NOW())
      ON CONFLICT (key) DO UPDATE
        SET value = EXCLUDED.value, "updatedAt" = NOW()
      WHERE CAST("Setting".value AS BIGINT) + ${3600_000}::bigint <= ${now}::bigint
    `;
    if (retentionClaimed > 0) {
      const purged = await purgeOldHistory();
      if (purged > 0) results.purged = purged;
    }
  } catch (err) {
    return NextResponse.json({ error: "Sync failed" }, { status: 500 });
  }

  return NextResponse.json(results);
}
