import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import {
  getRadarrWantedTmdbIds,
  getSonarrWantedTmdbIds,
  isMovieDownloadingInRadarr,
  isSeriesDownloadingInSonarr,
  getMovieReleaseInfo,
  getSeriesFirstAired,
} from "@/lib/arr";
import { getPlexTmdbIds, getPlexLibrarySections, getPlexTVEpisodes, type PlexLibraryItemData } from "@/lib/plex";
import { getJellyfinTmdbIds, getJellyfinTVEpisodes, type JellyfinLibraryItemData } from "@/lib/jellyfin";
import { notifyUsersRequestsAvailable, notifyUserAwaitingRelease, notifyUserDownloadPending } from "@/lib/discord-notify";
import { notifyUsersRequestsAvailablePush } from "@/lib/push";
import { logAudit } from "@/lib/audit";
import { isCronAuthorized, BATCH_TX_TIMEOUT, batchCreateMany } from "@/lib/cron-auth";
import { isFeatureEnabled } from "@/lib/features";

const CONCURRENCY_LIMIT = 5;

async function runConcurrent<T>(
  items: T[],
  fn: (item: T) => Promise<void>
): Promise<void> {
  for (let i = 0; i < items.length; i += CONCURRENCY_LIMIT) {
    await Promise.all(items.slice(i, i + CONCURRENCY_LIMIT).map(fn));
  }
}

export async function POST(request: NextRequest) {
  if (!(await isCronAuthorized(request))) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  const [approved, available] = await Promise.all([
    prisma.mediaRequest.findMany({
      where: { status: "APPROVED" },
      select: { id: true, tmdbId: true, mediaType: true, requestedBy: true, title: true, pendingNotifyAt: true, notifiedAvailable: true },
    }),
    prisma.mediaRequest.findMany({
      where: { status: "AVAILABLE" },
      select: { id: true, tmdbId: true, mediaType: true, requestedBy: true, title: true, notifiedAvailable: true },
    }),
  ]);

  let marked = 0;
  let reverted = 0;
  const arrNotify: Array<{ requestedBy: string; title: string; mediaType: string }> = [];

  const approvedMovieTmdbIds = approved.filter((r) => r.mediaType === "MOVIE").map((r) => r.tmdbId);
  const approvedTvTmdbIds    = approved.filter((r) => r.mediaType === "TV").map((r) => r.tmdbId);
  let availableMovieSet = new Set<number>();
  let availableTvSet    = new Set<number>();
  if (approvedMovieTmdbIds.length > 0 || approvedTvTmdbIds.length > 0) {
    const [availableMovieRows, availableTvRows] = await Promise.all([
      approvedMovieTmdbIds.length > 0
        ? prisma.radarrAvailableItem.findMany({ where: { tmdbId: { in: approvedMovieTmdbIds } } })
        : Promise.resolve([]),
      approvedTvTmdbIds.length > 0
        ? prisma.sonarrAvailableItem.findMany({ where: { tmdbId: { in: approvedTvTmdbIds } } })
        : Promise.resolve([]),
    ]);
    availableMovieSet = new Set(availableMovieRows.map((r) => r.tmdbId));
    availableTvSet    = new Set(availableTvRows.map((r) => r.tmdbId));
  }

  for (const req of approved) {
    const nowAvailable = req.mediaType === "MOVIE"
      ? availableMovieSet.has(req.tmdbId)
      : availableTvSet.has(req.tmdbId);

    if (nowAvailable) {
      // CAS on notifiedAvailable: only the first writer fires notifications, preventing duplicates
      const updated = await prisma.mediaRequest.updateMany({
        where: { id: req.id, notifiedAvailable: false },
        data: { status: "AVAILABLE", availableAt: new Date(), pendingNotifyAt: null, notifiedAvailable: true },
      });

      if (updated.count === 0) {
        // Another path already claimed notifiedAvailable; still mark AVAILABLE without re-notifying
        await prisma.mediaRequest.updateMany({
          where: { id: req.id, notifiedAvailable: true },
          data: { status: "AVAILABLE", availableAt: new Date(), pendingNotifyAt: null },
        });
      } else {
        arrNotify.push({ requestedBy: req.requestedBy, title: req.title, mediaType: req.mediaType });
      }
      marked++;
    }
  }

  const now = new Date();
  const overdue = approved.filter((r) => r.pendingNotifyAt && r.pendingNotifyAt <= now && !arrNotify.find((n) => n.requestedBy === r.requestedBy && n.title === r.title));
  await runConcurrent(overdue, async (req) => {
    try {
      const downloading = req.mediaType === "MOVIE"
        ? await isMovieDownloadingInRadarr(req.tmdbId)
        : await isSeriesDownloadingInSonarr(req.tmdbId);
      if (downloading) {
        await prisma.mediaRequest.update({ where: { id: req.id }, data: { pendingNotifyAt: null } });
        return;
      }
      let released = true;
      let soonestReleaseDate: string | null = null;
      if (req.mediaType === "MOVIE") {
        const info = await getMovieReleaseInfo(req.tmdbId);
        if (info) {
          const futureDates = [info.digitalRelease, info.physicalRelease].filter((d): d is string => !!d && new Date(d) > now);
          const pastDates   = [info.digitalRelease, info.physicalRelease].filter((d): d is string => !!d && new Date(d) <= now);
          if (pastDates.length === 0 && futureDates.length > 0) {
            released = false;
            soonestReleaseDate = futureDates.sort((a, b) => new Date(a).getTime() - new Date(b).getTime())[0];
          }
        }
      } else {
        const firstAired = await getSeriesFirstAired(req.tmdbId);
        if (firstAired && new Date(firstAired) > now) {
          released = false;
          soonestReleaseDate = firstAired;
        }
      }
      await prisma.mediaRequest.update({ where: { id: req.id }, data: { pendingNotifyAt: null } });
      if (!released) {
        await notifyUserAwaitingRelease(req.requestedBy, req.title, req.mediaType, soonestReleaseDate);
      } else {
        await notifyUserDownloadPending(req.requestedBy, req.title, req.mediaType);
      }
    } catch (err) {
      console.error("[sync] pendingNotifyAt check failed for", req.id, err);
    }
  });

  notifyUsersRequestsAvailable(arrNotify).catch(() => {});
  notifyUsersRequestsAvailablePush(arrNotify).catch(() => {});

  const availableMovieTmdbIds = available.filter((r) => r.mediaType === "MOVIE").map((r) => r.tmdbId);
  const availableTvTmdbIds    = available.filter((r) => r.mediaType === "TV").map((r) => r.tmdbId);
  let inRadarrSet = new Set<number>();
  let inSonarrSet = new Set<number>();
  if (availableMovieTmdbIds.length > 0 || availableTvTmdbIds.length > 0) {
    const [inRadarrAvail, inRadarrWanted, inSonarrAvail, inSonarrWanted] = await Promise.all([
      availableMovieTmdbIds.length > 0
        ? prisma.radarrAvailableItem.findMany({ where: { tmdbId: { in: availableMovieTmdbIds } } })
        : Promise.resolve([]),
      availableMovieTmdbIds.length > 0
        ? prisma.radarrWantedItem.findMany({ where: { tmdbId: { in: availableMovieTmdbIds } } })
        : Promise.resolve([]),
      availableTvTmdbIds.length > 0
        ? prisma.sonarrAvailableItem.findMany({ where: { tmdbId: { in: availableTvTmdbIds } } })
        : Promise.resolve([]),
      availableTvTmdbIds.length > 0
        ? prisma.sonarrWantedItem.findMany({ where: { tmdbId: { in: availableTvTmdbIds } } })
        : Promise.resolve([]),
    ]);
    inRadarrSet = new Set([...inRadarrAvail.map((r) => r.tmdbId), ...inRadarrWanted.map((r) => r.tmdbId)]);
    inSonarrSet = new Set([...inSonarrAvail.map((r) => r.tmdbId), ...inSonarrWanted.map((r) => r.tmdbId)]);
  }

  for (const req of available) {
    const stillInLibrary = req.mediaType === "MOVIE"
      ? inRadarrSet.has(req.tmdbId)
      : inSonarrSet.has(req.tmdbId);

    if (!stillInLibrary) {
      await prisma.mediaRequest.update({
        where: { id: req.id },
        data: { status: "APPROVED" },
      });
      reverted++;
    }
  }

  let plexMarked = 0;
  let jellyfinMarked = 0;

  const [[plexUrlRow, plexTokenRow], [jfUrlRow, jfKeyRow]] = await Promise.all([
    Promise.all([
      prisma.setting.findUnique({ where: { key: "plexServerUrl" } }),
      prisma.setting.findUnique({ where: { key: "plexAdminToken" } }),
    ]),
    Promise.all([
      prisma.setting.findUnique({ where: { key: "jellyfinUrl" } }),
      prisma.setting.findUnique({ where: { key: "jellyfinApiKey" } }),
    ]),
  ]);

  let plexMovieIds = new Map<number, PlexLibraryItemData>();
  let plexTvIds    = new Map<number, PlexLibraryItemData>();
  let jfMovieIds   = new Map<number, JellyfinLibraryItemData>();
  let jfTvIds      = new Map<number, JellyfinLibraryItemData>();

  const [plexEnabled, jellyfinEnabled, radarrEnabled, sonarrEnabled] = await Promise.all([
    isFeatureEnabled("feature.integration.plex"),
    isFeatureEnabled("feature.integration.jellyfin"),
    isFeatureEnabled("feature.integration.radarr"),
    isFeatureEnabled("feature.integration.sonarr"),
  ]);

  // Plex and Jellyfin library writes run concurrently; errors in one don't abort the other
  const syncResults = await Promise.allSettled([
    (async () => {
      if (!plexEnabled) return;
      if (!plexUrlRow?.value || !plexTokenRow?.value) return;
      try {
        const serverUrl = plexUrlRow.value.replace(/\/$/, "");
        const token = plexTokenRow.value;
        const sections = await getPlexLibrarySections(serverUrl, token);
        [plexMovieIds, plexTvIds] = await Promise.all([
          getPlexTmdbIds(serverUrl, token, "MOVIE", false, undefined, sections),
          getPlexTmdbIds(serverUrl, token, "TV", false, undefined, sections),
        ]);
        const movieRows = Array.from(plexMovieIds.entries()).map(([tmdbId, d]) => ({ tmdbId, mediaType: "MOVIE" as const, filePath: d.filePath, plexRatingKey: d.ratingKey, title: d.title, year: d.year, overview: d.overview, contentRating: d.contentRating, addedAt: d.addedAt }));
        const tvRows    = Array.from(plexTvIds.entries()).map(([tmdbId, d])    => ({ tmdbId, mediaType: "TV"    as const, filePath: d.filePath, plexRatingKey: d.ratingKey, title: d.title, year: d.year, overview: d.overview, contentRating: d.contentRating, addedAt: d.addedAt }));
        await prisma.$transaction(async (tx) => {
          await tx.plexLibraryItem.deleteMany();
          if (movieRows.length > 0) await batchCreateMany(tx.plexLibraryItem, movieRows);
          if (tvRows.length    > 0) await batchCreateMany(tx.plexLibraryItem, tvRows);
        }, { timeout: BATCH_TX_TIMEOUT });
        try {
          const episodes = await getPlexTVEpisodes(serverUrl, token, undefined, sections);
          if (episodes.length > 0) {
            const episodeRows = episodes.map((e) => ({ source: "plex" as const, ...e }));
            await prisma.$transaction(async (tx) => {
              await tx.tVEpisodeCache.deleteMany({ where: { source: "plex" } });
              await batchCreateMany(tx.tVEpisodeCache, episodeRows);
            }, { timeout: BATCH_TX_TIMEOUT });
          }
        } catch (err) {
          console.error("[sync] Plex TV episode cache failed:", err);
        }
      } catch (err) {
        console.error("[sync] Plex check failed:", err);
      }
    })(),
    (async () => {
      if (!jellyfinEnabled) return;
      if (!jfUrlRow?.value || !jfKeyRow?.value) return;
      try {
        const baseUrl = jfUrlRow.value.replace(/\/$/, "");
        const apiKey  = jfKeyRow.value;
        [jfMovieIds, jfTvIds] = await Promise.all([
          getJellyfinTmdbIds(baseUrl, apiKey, "MOVIE"),
          getJellyfinTmdbIds(baseUrl, apiKey, "TV"),
        ]);
        const movieRows = Array.from(jfMovieIds.entries()).map(([tmdbId, d]) => ({ tmdbId, mediaType: "MOVIE" as const, filePath: d.filePath, jellyfinItemId: d.itemId, title: d.title, year: d.year, overview: d.overview, contentRating: d.contentRating, communityRating: d.communityRating, addedAt: d.addedAt }));
        const tvRows    = Array.from(jfTvIds.entries()).map(([tmdbId, d])    => ({ tmdbId, mediaType: "TV"    as const, filePath: d.filePath, jellyfinItemId: d.itemId, title: d.title, year: d.year, overview: d.overview, contentRating: d.contentRating, communityRating: d.communityRating, addedAt: d.addedAt }));
        await prisma.$transaction(async (tx) => {
          await tx.jellyfinLibraryItem.deleteMany();
          if (movieRows.length > 0) await batchCreateMany(tx.jellyfinLibraryItem, movieRows);
          if (tvRows.length    > 0) await batchCreateMany(tx.jellyfinLibraryItem, tvRows);
        }, { timeout: BATCH_TX_TIMEOUT });

        const jfSeriesMap = new Map<string, number>();
        for (const [tmdbId, data] of jfTvIds) {
          if (data.itemId) jfSeriesMap.set(data.itemId, tmdbId);
        }
        try {
          const episodes = await getJellyfinTVEpisodes(baseUrl, apiKey, undefined, jfSeriesMap);
          if (episodes.length > 0) {
            const episodeRows = episodes.map((e) => ({ source: "jellyfin" as const, ...e }));
            await prisma.$transaction(async (tx) => {
              await tx.tVEpisodeCache.deleteMany({ where: { source: "jellyfin" } });
              await batchCreateMany(tx.tVEpisodeCache, episodeRows);
            }, { timeout: BATCH_TX_TIMEOUT });
          }
        } catch (err) {
          console.error("[sync] Jellyfin TV episode cache failed:", err);
        }
      } catch (err) {
        console.error("[sync] Jellyfin check failed:", err);
      }
    })(),
  ]);
  for (const result of syncResults) {
    if (result.status === "rejected") {
      console.error("[sync] Unexpected top-level sync rejection:", result.reason);
    }
  }

  // Snapshot taken once after both library writes complete; both marking passes share this exact set.
  // Changes made by the Plex pass are NOT visible to the Jellyfin pass — intentional by design.
  const stillPending = await prisma.mediaRequest.findMany({
    where: { status: { in: ["PENDING", "APPROVED"] } },
    select: { id: true, tmdbId: true, mediaType: true, requestedBy: true, title: true, notifiedAvailable: true },
  });

  const markLibraryRequests = async (
    movieIds: Map<number, unknown>,
    tvIds: Map<number, unknown>,
    source: "plex" | "jellyfin",
  ): Promise<number> => {
    const toMark = stillPending.filter((req) =>
      req.mediaType === "MOVIE" ? movieIds.has(req.tmdbId) : tvIds.has(req.tmdbId)
    );
    if (toMark.length === 0) return 0;

    // Re-fetch notifiedAvailable to catch any updates the concurrent Plex pass may have committed
    const freshRows = await prisma.mediaRequest.findMany({
      where: { id: { in: toMark.map((r) => r.id) } },
      select: { id: true, notifiedAvailable: true },
    });
    const alreadyNotifiedIds = new Set(freshRows.filter((r) => r.notifiedAvailable).map((r) => r.id));

    const unnotified = toMark.filter((r) => !alreadyNotifiedIds.has(r.id));
    if (unnotified.length > 0) {

      const userRows = await prisma.user.findMany({
        where: { id: { in: unnotified.map((r) => r.requestedBy) } },
        select: { id: true, mediaServer: true },
      });
      const userMediaServer = new Map(userRows.map((u) => [u.id, u.mediaServer]));

      // Users with a mediaServer preference only get notified by their preferred source;
      // users with no preference get notified by whichever source sees the item first
      const toNotify = unnotified.filter((r) => {
        const ms = userMediaServer.get(r.requestedBy) ?? null;
        return !ms || ms === source;
      });

      // Mark available without notifying users whose preferred server is a different source
      const toMarkOnly = unnotified.filter((r) => {
        const ms = userMediaServer.get(r.requestedBy) ?? null;
        return !!ms && ms !== source;
      });

      if (toNotify.length > 0) {
        const updated = await prisma.mediaRequest.updateMany({
          where: { id: { in: toNotify.map((r) => r.id) }, notifiedAvailable: false },
          data: { status: "AVAILABLE", availableAt: new Date(), notifiedAvailable: true },
        });
        if (updated.count > 0) {
          notifyUsersRequestsAvailable(toNotify).catch(() => {});
          notifyUsersRequestsAvailablePush(toNotify).catch(() => {});
        }
      }
      if (toMarkOnly.length > 0) {
        await prisma.mediaRequest.updateMany({
          where: { id: { in: toMarkOnly.map((r) => r.id) } },
          data: { status: "AVAILABLE", availableAt: new Date() },
        });
      }
    }
    const alreadyNotified = toMark.filter((r) => alreadyNotifiedIds.has(r.id));
    if (alreadyNotified.length > 0) {
      await prisma.mediaRequest.updateMany({
        where: { id: { in: alreadyNotified.map((r) => r.id) } },
        data: { status: "AVAILABLE", availableAt: new Date() },
      });
    }
    return toMark.length;
  };

  if (plexMovieIds.size > 0 || plexTvIds.size > 0) {
    plexMarked = await markLibraryRequests(plexMovieIds, plexTvIds, "plex");
  }
  if (jfMovieIds.size > 0 || jfTvIds.size > 0) {
    jellyfinMarked = await markLibraryRequests(jfMovieIds, jfTvIds, "jellyfin");
  }

  const pendingAvailableNotify = available.filter((r) => !r.notifiedAvailable);
  if (pendingAvailableNotify.length > 0) {
    const plexConfigured = !!(plexUrlRow?.value && plexTokenRow?.value);
    const jellyfinConfigured = !!(jfUrlRow?.value && jfKeyRow?.value);
    const userRows = await prisma.user.findMany({
      where: { id: { in: pendingAvailableNotify.map((r) => r.requestedBy) } },
      select: { id: true, mediaServer: true },
    });
    const userMediaServer = new Map(userRows.map((u) => [u.id, u.mediaServer]));
    for (const req of pendingAvailableNotify) {
      const ms = userMediaServer.get(req.requestedBy) ?? null;
      const inPlex = req.mediaType === "MOVIE" ? plexMovieIds.has(req.tmdbId) : plexTvIds.has(req.tmdbId);
      const inJellyfin = req.mediaType === "MOVIE" ? jfMovieIds.has(req.tmdbId) : jfTvIds.has(req.tmdbId);
      const shouldNotify = !ms
        ? inPlex || inJellyfin || (!plexConfigured && !jellyfinConfigured)
        : ms === "plex"
        ? inPlex || (!plexConfigured && (inJellyfin || !jellyfinConfigured))
        : ms === "jellyfin"
        ? inJellyfin || (!jellyfinConfigured && (inPlex || !plexConfigured))
        : false;
      if (!shouldNotify) continue;
      const cas = await prisma.mediaRequest.updateMany({
        where: { id: req.id, status: "AVAILABLE", notifiedAvailable: false },
        data: { notifiedAvailable: true },
      });
      if (cas.count > 0) {
        notifyUsersRequestsAvailable([req]).catch(() => {});
        notifyUsersRequestsAvailablePush([req]).catch(() => {});
      }
    }
  }

  let radarrWanted = 0;
  if (radarrEnabled) {
    try {
      const radarrResult = await getRadarrWantedTmdbIds();
      if (radarrResult === null) {
        console.warn("[sync] skipping Radarr cache update — ARR fetch failed");
      } else {
        const wantedRows    = Array.from(radarrResult.wanted).map((tmdbId) => ({ tmdbId }));
        const availableRows = Array.from(radarrResult.available).map((tmdbId) => ({ tmdbId }));
        // Advisory lock 1001,1 coordinates with the Radarr webhook handler to prevent partial reads
        await prisma.$transaction(async (tx) => {
          await tx.$executeRaw`SELECT pg_advisory_xact_lock(1001, 1)`;
          await tx.radarrWantedItem.deleteMany();
          if (wantedRows.length > 0) await tx.radarrWantedItem.createMany({ data: wantedRows });
          await tx.radarrAvailableItem.deleteMany();
          if (availableRows.length > 0) await tx.radarrAvailableItem.createMany({ data: availableRows });
        }, { timeout: BATCH_TX_TIMEOUT });
        radarrWanted = wantedRows.length;
      }
    } catch (err) {
      console.error("[sync] Radarr wanted sync failed:", err);
    }
  }

  let sonarrWanted = 0;
  if (sonarrEnabled) {
    try {
      const sonarrResult = await getSonarrWantedTmdbIds();
      if (sonarrResult === null) {
        console.warn("[sync] skipping Sonarr cache update — ARR fetch failed");
      } else {
        const wantedRows    = Array.from(sonarrResult.wanted).map((tmdbId) => ({ tmdbId }));
        const availableRows = Array.from(sonarrResult.available).map((tmdbId) => ({ tmdbId }));
        // Advisory lock 1001,2 coordinates with the Sonarr webhook handler to prevent partial reads
        await prisma.$transaction(async (tx) => {
          await tx.$executeRaw`SELECT pg_advisory_xact_lock(1001, 2)`;
          await tx.sonarrWantedItem.deleteMany();
          if (wantedRows.length > 0) await tx.sonarrWantedItem.createMany({ data: wantedRows });
          await tx.sonarrAvailableItem.deleteMany();
          if (availableRows.length > 0) await tx.sonarrAvailableItem.createMany({ data: availableRows });
        }, { timeout: BATCH_TX_TIMEOUT });
        sonarrWanted = wantedRows.length;
      }
    } catch (err) {
      console.error("[sync] Sonarr wanted sync failed:", err);
    }
  }

  try {
    await prisma.tmdbCache.deleteMany({
      where: { expiresAt: { lt: new Date() } },
    });
  } catch (err) {
    console.error("[sync] TMDB cache purge failed:", err);
  }

  const session = await auth();
  if (session?.user) {
    void logAudit({
      userId: session.user.id,
      userName: session.user.name ?? session.user.id,
      action: "LIBRARY_SYNC",
      target: "sync:full",
      details: { marked, reverted, plexMarked, jellyfinMarked, radarrWanted, sonarrWanted },
    });
  }

  return NextResponse.json({
    checked: { approved: approved.length, available: available.length },
    marked,
    reverted,
    plexMarked,
    jellyfinMarked,
    radarrWanted,
    sonarrWanted,
  });
}
