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
  addMovieToRadarr,
  addSeriesToSonarr,
} from "@/lib/arr";
import { getPlexTmdbIds, getPlexLibrarySections, getPlexTVEpisodes, type PlexLibraryItemData } from "@/lib/plex";
import { getJellyfinTmdbIds, getJellyfinTVEpisodes, type JellyfinLibraryItemData } from "@/lib/jellyfin";
import { syncDownloadPolicies } from "@/lib/download-policy";
import { notifyUsersRequestsAvailable, notifyUserAwaitingRelease, notifyUserDownloadPending } from "@/lib/discord-notify";
import { notifyUsersRequestsAvailablePush } from "@/lib/push";
import { logAudit } from "@/lib/audit";
import { isCronAuthorized, BATCH_TX_TIMEOUT, batchCreateMany, recordCronRun } from "@/lib/cron-auth";
import { isFeatureEnabled } from "@/lib/features";
import { withAdvisoryLock } from "@/lib/advisory-lock";
import { claimAvailableNotificationWinners, clearDeletionVotesForTmdbs } from "@/lib/notify-available";

// Advisory-lock id 2000 — distinct from 2001-2011 (cron warm/sync routes) and TRASH_SYNC_LOCK_ID (2010).
// Held for the entire orchestrator run so a second concurrent invocation (admin "Resync" while
// the cron POST is mid-flight) returns immediately with skipped=true rather than racing the
// shared-state writes (notifiedAvailable CAS, library tables, MediaRequest status updates).
const SYNC_ORCHESTRATOR_LOCK_ID = 2000;

const CONCURRENCY_LIMIT = 5;

// Re-push backoff for APPROVED requests the *arr never accepted (e.g. unreleased title with
// no Radarr/TheTVDB metadata yet). Without this the orchestrator would retry every sync tick
// (hourly) forever. Upstream metadata for an upcoming title appears some unpredictable day in
// the weeks before air, so a daily attempt catches it within ~24h of it landing while cutting
// the wasted lookups ~24×.
const ARR_REPUSH_BACKOFF_MS = 24 * 60 * 60 * 1000;

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

  return withAdvisoryLock(
    SYNC_ORCHESTRATOR_LOCK_ID,
    (signal: AbortSignal) => runSyncOrchestrator(signal),
    () => NextResponse.json({ skipped: true, reason: "sync already running" }, { status: 200 }),
  );
}

// Me-4: signal fires when withAdvisoryLock's hard timeout trips, before the lock is released.
// Prisma 7's $transaction(fn, opts) does not accept an AbortSignal, so abortion is best-effort —
// long-running outbound HTTP (Plex/Jellyfin/ARR fetches) can observe it; Prisma queries cannot.
// Strips angle brackets and null bytes, caps length. Shared between the
// orchestrator and the per-source /api/sync/{plex,jellyfin} routes so the
// PlexLibraryItem / JellyfinLibraryItem content is identical regardless of
// which path most recently wrote the row.
const sanitizeStr = (s: string | null | undefined, maxLen = 1000): string | null => {
  if (s == null) return null;
  return s.replace(/[<>]/g, "").replace(/\0/g, "").slice(0, maxLen) || null;
};

async function runSyncOrchestrator(signal?: AbortSignal): Promise<NextResponse> {
  // signal is wired through so callers (e.g. arrFetch) can opt in later; currently unobserved.
  void signal;
  const startTime = Date.now();

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
  let repushed = 0;
  const arrNotify: Array<{ id: string; requestedBy: string; title: string; mediaType: string }> = [];

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

  // C3: collapse the per-request update loop into two updateMany calls — one CAS for the
  // unnotified candidates (which produces the arrNotify list), one bulk catch-up for the
  // already-notified rows. Snapshot pre-state so we can attribute the CAS winners.
  const nowAvailableApproved = approved.filter((r) =>
    r.mediaType === "MOVIE" ? availableMovieSet.has(r.tmdbId) : availableTvSet.has(r.tmdbId),
  );
  if (nowAvailableApproved.length > 0) {
    const nowAvailableIds = nowAvailableApproved.map((r) => r.id);
    const preNotifiedRows = await prisma.mediaRequest.findMany({
      where: { id: { in: nowAvailableIds } },
      select: { id: true, notifiedAvailable: true },
    });
    const wasUnnotifiedIds = new Set(
      preNotifiedRows.filter((r) => !r.notifiedAvailable).map((r) => r.id),
    );
    const wasNotifiedIds = preNotifiedRows.filter((r) => r.notifiedAvailable).map((r) => r.id);

    // CAS on notifiedAvailable: only the first writer fires notifications, preventing duplicates
    const casUpdated = await prisma.mediaRequest.updateMany({
      where: { id: { in: nowAvailableIds }, notifiedAvailable: false },
      data: { status: "AVAILABLE", availableAt: new Date(), pendingNotifyAt: null, notifiedAvailable: true },
    });
    if (casUpdated.count > 0) {
      for (const req of nowAvailableApproved) {
        if (wasUnnotifiedIds.has(req.id)) {
          arrNotify.push({ id: req.id, requestedBy: req.requestedBy, title: req.title, mediaType: req.mediaType });
        }
      }
    }
    if (wasNotifiedIds.length > 0) {
      // Another path already claimed notifiedAvailable; still mark AVAILABLE without re-notifying
      await prisma.mediaRequest.updateMany({
        where: { id: { in: wasNotifiedIds }, notifiedAvailable: true },
        data: { status: "AVAILABLE", availableAt: new Date(), pendingNotifyAt: null },
      });
    }
    marked = nowAvailableApproved.length;
  }

  const now = new Date();
  const overdue = approved.filter((r) => r.pendingNotifyAt && r.pendingNotifyAt <= now && !arrNotify.find((n) => n.id === r.id));
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

  const [plexEnabled, jellyfinEnabled, radarrEnabled, sonarrEnabled] = await Promise.all([
    isFeatureEnabled("feature.integration.plex"),
    isFeatureEnabled("feature.integration.jellyfin"),
    isFeatureEnabled("feature.integration.radarr"),
    isFeatureEnabled("feature.integration.sonarr"),
  ]);

  // Refresh Radarr/Sonarr caches BEFORE the AVAILABLE→APPROVED revert below. The revert reads
  // radarr/sonarr {Available,Wanted}Item — if those tables are stale from a prior failed run,
  // a fresh tick that also fails would mass-demote everything. We only consult the cache for
  // the revert decision when the current run successfully refreshed it.
  let radarrWanted = 0;
  let radarrSyncSucceeded = false;
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
          if (wantedRows.length > 0) await batchCreateMany(tx.radarrWantedItem, wantedRows);
          await tx.radarrAvailableItem.deleteMany();
          if (availableRows.length > 0) await batchCreateMany(tx.radarrAvailableItem, availableRows);
        }, { timeout: BATCH_TX_TIMEOUT });
        radarrWanted = wantedRows.length;
        radarrSyncSucceeded = true;
      }
    } catch (err) {
      console.error("[sync] Radarr wanted sync failed:", err);
    }
  }

  let sonarrWanted = 0;
  let sonarrSyncSucceeded = false;
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
          if (wantedRows.length > 0) await batchCreateMany(tx.sonarrWantedItem, wantedRows);
          await tx.sonarrAvailableItem.deleteMany();
          if (availableRows.length > 0) await batchCreateMany(tx.sonarrAvailableItem, availableRows);
        }, { timeout: BATCH_TX_TIMEOUT });
        sonarrWanted = wantedRows.length;
        sonarrSyncSucceeded = true;
      }
    } catch (err) {
      console.error("[sync] Sonarr wanted sync failed:", err);
    }
  }

  // Re-push APPROVED requests that never made it into Radarr/Sonarr. The approve-time push
  // can fail when the title has no Radarr/TheTVDB metadata yet (common for not-yet-released
  // titles, e.g. a show that airs in a few weeks); the request is then stranded in APPROVED
  // with nothing retrying it. We act only when the integration is enabled AND this run
  // refreshed its cache — same guard as the revert block below, so a stale or failed cache
  // can't trigger a mass re-push. A title absent from BOTH the freshly-synced wanted and
  // available sets is genuinely unknown to the *arr, so the earlier add never landed.
  // ARR_REPUSH_BACKOFF_MS gates retries to ~daily (lastArrPushAt is stamped on every
  // attempt, success or fail) so a permanently-unresolvable request doesn't churn hourly.
  const repushCutoff = new Date(Date.now() - ARR_REPUSH_BACKOFF_MS);
  const stillApproved = await prisma.mediaRequest.findMany({
    where: {
      id: { in: approved.map((r) => r.id) },
      status: "APPROVED",
      OR: [{ lastArrPushAt: null }, { lastArrPushAt: { lte: repushCutoff } }],
    },
    select: { id: true, tmdbId: true, mediaType: true },
  });
  const repushMovieIds = stillApproved.filter((r) => r.mediaType === "MOVIE" && radarrEnabled && radarrSyncSucceeded).map((r) => r.tmdbId);
  const repushTvIds    = stillApproved.filter((r) => r.mediaType === "TV"    && sonarrEnabled && sonarrSyncSucceeded).map((r) => r.tmdbId);
  let knownRadarrSet = new Set<number>();
  let knownSonarrSet = new Set<number>();
  if (repushMovieIds.length > 0 || repushTvIds.length > 0) {
    const [rAvail, rWant, sAvail, sWant] = await Promise.all([
      repushMovieIds.length > 0
        ? prisma.radarrAvailableItem.findMany({ where: { tmdbId: { in: repushMovieIds } } })
        : Promise.resolve([]),
      repushMovieIds.length > 0
        ? prisma.radarrWantedItem.findMany({ where: { tmdbId: { in: repushMovieIds } } })
        : Promise.resolve([]),
      repushTvIds.length > 0
        ? prisma.sonarrAvailableItem.findMany({ where: { tmdbId: { in: repushTvIds } } })
        : Promise.resolve([]),
      repushTvIds.length > 0
        ? prisma.sonarrWantedItem.findMany({ where: { tmdbId: { in: repushTvIds } } })
        : Promise.resolve([]),
    ]);
    knownRadarrSet = new Set([...rAvail.map((r) => r.tmdbId), ...rWant.map((r) => r.tmdbId)]);
    knownSonarrSet = new Set([...sAvail.map((r) => r.tmdbId), ...sWant.map((r) => r.tmdbId)]);
  }
  const toRepush = stillApproved.filter((r) =>
    r.mediaType === "MOVIE"
      ? radarrEnabled && radarrSyncSucceeded && !knownRadarrSet.has(r.tmdbId)
      : sonarrEnabled && sonarrSyncSucceeded && !knownSonarrSet.has(r.tmdbId),
  );
  const pushedAt = new Date();
  await runConcurrent(toRepush, async (req) => {
    try {
      if (req.mediaType === "MOVIE") {
        await addMovieToRadarr(req.tmdbId);
        await prisma.mediaRequest.update({ where: { id: req.id }, data: { lastArrPushAt: pushedAt } });
      } else {
        const tvdbId = await addSeriesToSonarr(req.tmdbId);
        await prisma.mediaRequest.update({ where: { id: req.id }, data: { tvdbId, lastArrPushAt: pushedAt } });
      }
      repushed++;
    } catch (err) {
      // Stamp the attempt so the backoff applies even though it failed.
      await prisma.mediaRequest.update({ where: { id: req.id }, data: { lastArrPushAt: pushedAt } }).catch(() => {});
      // Still unresolvable upstream (e.g. unreleased title with no Radarr/TVDB entry yet).
      // Leave the request APPROVED; a later tick retries once the metadata exists.
      console.error("[sync] re-push to *arr failed for", req.id, err);
    }
  });

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
  let plexSyncSucceeded = false;
  let jellyfinSyncSucceeded = false;

  // Plex and Jellyfin library writes + download-policy enforcement run concurrently
  const syncResults = await Promise.allSettled([
    syncDownloadPolicies(),
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
        const movieRows = Array.from(plexMovieIds.entries()).map(([tmdbId, d]) => ({ tmdbId, mediaType: "MOVIE" as const, filePath: d.filePath, plexRatingKey: d.ratingKey, title: sanitizeStr(d.title, 500) ?? "", year: d.year, overview: sanitizeStr(d.overview), contentRating: sanitizeStr(d.contentRating, 50), addedAt: d.addedAt }));
        const tvRows    = Array.from(plexTvIds.entries()).map(([tmdbId, d])    => ({ tmdbId, mediaType: "TV"    as const, filePath: d.filePath, plexRatingKey: d.ratingKey, title: sanitizeStr(d.title, 500) ?? "", year: d.year, overview: sanitizeStr(d.overview), contentRating: sanitizeStr(d.contentRating, 50), addedAt: d.addedAt }));
        // Advisory lock 2001,1 — matches /api/sync/plex so the two callers can't race the same write.
        await prisma.$transaction(async (tx) => {
          await tx.$executeRaw`SELECT pg_advisory_xact_lock(2001, 1)`;
          await tx.plexLibraryItem.deleteMany();
          if (movieRows.length > 0) await batchCreateMany(tx.plexLibraryItem, movieRows);
          if (tvRows.length    > 0) await batchCreateMany(tx.plexLibraryItem, tvRows);
        }, { timeout: BATCH_TX_TIMEOUT });
        plexSyncSucceeded = true;
        // Stamp last-success timestamp so the notify-fallback (below) can detect a stale source.
        await prisma.setting.upsert({
          where: { key: "lastPlexSyncSucceededAt" },
          update: { value: String(Date.now()) },
          create: { key: "lastPlexSyncSucceededAt", value: String(Date.now()) },
        }).catch((err) => console.error("[sync] failed to stamp lastPlexSyncSucceededAt:", err));
        try {
          const episodes = await getPlexTVEpisodes(serverUrl, token, undefined, sections);
          if (episodes.length > 0) {
            const episodeRows = episodes.map((e) => ({ source: "plex" as const, ...e }));
            await prisma.$transaction(async (tx) => {
              // Advisory lock 2002,1 — shared with /api/sync/tv-episodes and sync/plex so the
              // wholesale Plex TVEpisodeCache rewrite can't be interleaved with another writer.
              await tx.$executeRaw`SELECT pg_advisory_xact_lock(2002, 1)`;
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
        const movieRows = Array.from(jfMovieIds.entries()).map(([tmdbId, d]) => ({ tmdbId, mediaType: "MOVIE" as const, filePath: d.filePath, jellyfinItemId: d.itemId, title: sanitizeStr(d.title, 500) ?? "", year: d.year, overview: sanitizeStr(d.overview), contentRating: sanitizeStr(d.contentRating, 50), communityRating: d.communityRating, addedAt: d.addedAt }));
        const tvRows    = Array.from(jfTvIds.entries()).map(([tmdbId, d])    => ({ tmdbId, mediaType: "TV"    as const, filePath: d.filePath, jellyfinItemId: d.itemId, title: sanitizeStr(d.title, 500) ?? "", year: d.year, overview: sanitizeStr(d.overview), contentRating: sanitizeStr(d.contentRating, 50), communityRating: d.communityRating, addedAt: d.addedAt }));
        // Advisory lock 2001,2 — matches /api/sync/jellyfin so the two callers can't race the same write.
        await prisma.$transaction(async (tx) => {
          await tx.$executeRaw`SELECT pg_advisory_xact_lock(2001, 2)`;
          await tx.jellyfinLibraryItem.deleteMany();
          if (movieRows.length > 0) await batchCreateMany(tx.jellyfinLibraryItem, movieRows);
          if (tvRows.length    > 0) await batchCreateMany(tx.jellyfinLibraryItem, tvRows);
        }, { timeout: BATCH_TX_TIMEOUT });
        jellyfinSyncSucceeded = true;
        // Stamp last-success timestamp so the notify-fallback (below) can detect a stale source.
        await prisma.setting.upsert({
          where: { key: "lastJellyfinSyncSucceededAt" },
          update: { value: String(Date.now()) },
          create: { key: "lastJellyfinSyncSucceededAt", value: String(Date.now()) },
        }).catch((err) => console.error("[sync] failed to stamp lastJellyfinSyncSucceededAt:", err));

        const jfSeriesMap = new Map<string, number>();
        for (const [tmdbId, data] of jfTvIds) {
          if (data.itemId) jfSeriesMap.set(data.itemId, tmdbId);
        }
        try {
          const episodes = await getJellyfinTVEpisodes(baseUrl, apiKey, undefined, jfSeriesMap);
          if (episodes.length > 0) {
            const episodeRows = episodes.map((e) => ({ source: "jellyfin" as const, ...e }));
            await prisma.$transaction(async (tx) => {
              // Advisory lock 2002,2 — Jellyfin counterpart; same coordination contract as 2002,1.
              await tx.$executeRaw`SELECT pg_advisory_xact_lock(2002, 2)`;
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

  // Demote AVAILABLE requests that have dropped out of *both* the *arr caches and the
  // Plex/Jellyfin library caches. Consulting the library caches here — not just *arr — is
  // what stops a request present in Plex but absent from Radarr from being reverted to
  // APPROVED and then immediately re-marked AVAILABLE by markLibraryRequests below: a
  // same-run flap that rewrote availableAt and inflated the reverted counter every tick.
  // Runs after the library sync so the maps are populated; library presence is only trusted
  // when that source synced successfully (an empty map from a failed/disabled source falls
  // back to the *arr-only decision).
  const toRevert = available.filter((req) => {
    // Only consult the ARR cache when the integration is enabled AND this run refreshed it.
    // A disabled integration or a failed refresh leaves the cache meaningless — skip the demote.
    if (req.mediaType === "MOVIE" && (!radarrEnabled || !radarrSyncSucceeded)) return false;
    if (req.mediaType === "TV"    && (!sonarrEnabled || !sonarrSyncSucceeded)) return false;
    const inArr = req.mediaType === "MOVIE"
      ? inRadarrSet.has(req.tmdbId)
      : inSonarrSet.has(req.tmdbId);
    const inLibrary = req.mediaType === "MOVIE"
      ? plexMovieIds.has(req.tmdbId) || jfMovieIds.has(req.tmdbId)
      : plexTvIds.has(req.tmdbId)    || jfTvIds.has(req.tmdbId);
    return !inArr && !inLibrary;
  });
  if (toRevert.length > 0) {
    const result = await prisma.mediaRequest.updateMany({
      where: { id: { in: toRevert.map((r) => r.id) } },
      data: { status: "APPROVED" },
    });
    reverted = result.count;
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
        const winners = await claimAvailableNotificationWinners(toNotify, (ids) =>
          prisma.mediaRequest.updateMany({
            where: { id: { in: ids }, notifiedAvailable: false },
            data: { status: "AVAILABLE", availableAt: new Date(), notifiedAvailable: true },
          }),
        );
        if (winners.length > 0) {
          void clearDeletionVotesForTmdbs(winners);
          notifyUsersRequestsAvailable(winners).catch(() => {});
          notifyUsersRequestsAvailablePush(winners).catch(() => {});
        }
      }
      if (toMarkOnly.length > 0) {
        // Gate availableAt: only stamp it on rows that aren't already AVAILABLE,
        // otherwise every cron tick rewrites availableAt for the same request.
        const flipped = await prisma.mediaRequest.updateMany({
          where: { id: { in: toMarkOnly.map((r) => r.id) }, status: { not: "AVAILABLE" } },
          data: { status: "AVAILABLE", availableAt: new Date() },
        });
        if (flipped.count > 0) void clearDeletionVotesForTmdbs(toMarkOnly);
      }
    }
    const alreadyNotified = toMark.filter((r) => alreadyNotifiedIds.has(r.id));
    if (alreadyNotified.length > 0) {
      // Gate availableAt: only stamp it on rows that aren't already AVAILABLE,
      // otherwise every cron tick rewrites availableAt for the same request.
      const flipped = await prisma.mediaRequest.updateMany({
        where: { id: { in: alreadyNotified.map((r) => r.id) }, status: { not: "AVAILABLE" } },
        data: { status: "AVAILABLE", availableAt: new Date() },
      });
      if (flipped.count > 0) void clearDeletionVotesForTmdbs(alreadyNotified);
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

    // Fallback for notification starvation: if a per-source sync has been failing for more than
    // STALE_SYNC_FALLBACK_MS, treat that source's data as "valid" so the *other* source can
    // satisfy the notify gate alone. Without this, a permanently broken Plex would block every
    // Jellyfin-only user's "now available" notification forever (and vice versa). The within-window
    // guard is preserved: a recent failure still refuses to notify on stale data.
    const STALE_SYNC_FALLBACK_MS = 24 * 60 * 60 * 1000;
    const [lastPlexSuccessRow, lastJellyfinSuccessRow] = await Promise.all([
      prisma.setting.findUnique({ where: { key: "lastPlexSyncSucceededAt" } }),
      prisma.setting.findUnique({ where: { key: "lastJellyfinSyncSucceededAt" } }),
    ]);
    const parseTs = (v: string | null | undefined): number | null => {
      if (!v) return null;
      const n = parseInt(v, 10);
      return Number.isFinite(n) ? n : null;
    };
    const lastPlexSuccessAt = parseTs(lastPlexSuccessRow?.value);
    const lastJellyfinSuccessAt = parseTs(lastJellyfinSuccessRow?.value);
    const nowMs = Date.now();
    const plexStale = plexConfigured && !plexSyncSucceeded &&
      lastPlexSuccessAt != null && (nowMs - lastPlexSuccessAt) > STALE_SYNC_FALLBACK_MS;
    const jellyfinStale = jellyfinConfigured && !jellyfinSyncSucceeded &&
      lastJellyfinSuccessAt != null && (nowMs - lastJellyfinSuccessAt) > STALE_SYNC_FALLBACK_MS;

    const userRows = await prisma.user.findMany({
      where: { id: { in: pendingAvailableNotify.map((r) => r.requestedBy) } },
      select: { id: true, mediaServer: true },
    });
    const userMediaServer = new Map(userRows.map((u) => [u.id, u.mediaServer]));

    // C3: collect candidate ids, then do a single CAS updateMany + a single notify per channel
    // rather than one-DB-roundtrip-per-request and one-notify-call-per-request.
    const toNotify: typeof pendingAvailableNotify = [];
    for (const req of pendingAvailableNotify) {
      const ms = userMediaServer.get(req.requestedBy) ?? null;
      const inPlex = req.mediaType === "MOVIE" ? plexMovieIds.has(req.tmdbId) : plexTvIds.has(req.tmdbId);
      const inJellyfin = req.mediaType === "MOVIE" ? jfMovieIds.has(req.tmdbId) : jfTvIds.has(req.tmdbId);
      // Use sync success flags rather than configured flags so a failed sync doesn't trigger false notifications.
      // 24h-stale fallback (above) also flips dataValid TRUE so the other source can satisfy alone.
      const plexDataValid = plexSyncSucceeded || !plexConfigured || plexStale;
      const jellyfinDataValid = jellyfinSyncSucceeded || !jellyfinConfigured || jellyfinStale;
      const shouldNotify = !ms
        ? inPlex || inJellyfin || (plexDataValid && jellyfinDataValid && !plexConfigured && !jellyfinConfigured)
        : ms === "plex"
        ? inPlex || (plexDataValid && !plexConfigured && (inJellyfin || (jellyfinDataValid && !jellyfinConfigured)))
        : ms === "jellyfin"
        ? inJellyfin || (jellyfinDataValid && !jellyfinConfigured && (inPlex || (plexDataValid && !plexConfigured)))
        : false;
      if (shouldNotify) toNotify.push(req);
    }

    if (toNotify.length > 0) {
      // Single CAS updateMany flips notifiedAvailable=false→true for every candidate at once.
      // To know which rows we actually claimed (vs. ones a concurrent path flipped between our
      // initial snapshot and now), re-read the candidates' notifiedAvailable IMMEDIATELY before
      // the updateMany; only those still showing false at that moment are ones we flipped.
      const candidateIds = toNotify.map((r) => r.id);
      const preState = await prisma.mediaRequest.findMany({
        where: { id: { in: candidateIds } },
        select: { id: true, notifiedAvailable: true },
      });
      const stillUnnotifiedIds = new Set(
        preState.filter((r) => !r.notifiedAvailable).map((r) => r.id),
      );
      const updated = await prisma.mediaRequest.updateMany({
        where: { id: { in: candidateIds }, status: "AVAILABLE", notifiedAvailable: false },
        data: { notifiedAvailable: true },
      });
      if (updated.count > 0) {
        const notifyBatch = toNotify.filter((r) => stillUnnotifiedIds.has(r.id));
        if (notifyBatch.length > 0) {
          // Backstop wipe: the original AVAILABLE transition (per-source mark pass,
          // webhooks) should have wiped already, but a regression there is silent
          // until threshold notifications fire on stale votes — wipe again here.
          void clearDeletionVotesForTmdbs(notifyBatch);
          notifyUsersRequestsAvailable(notifyBatch).catch(() => {});
          notifyUsersRequestsAvailablePush(notifyBatch).catch(() => {});
        }
      }
    }
  }

  try {
    await prisma.tmdbCache.deleteMany({
      where: { expiresAt: { lt: new Date() } },
    });
  } catch (err) {
    console.error("[sync] TMDB cache purge failed:", err);
  }

  const durationMs = Date.now() - startTime;

  // `lastRunAt` observability for /settings?tab=system. Always written so that
  // cron-triggered runs (which have no `session.user`) still surface their
  // last-run timestamp, while the audit row stays scoped to admin-triggered
  // runs to avoid hourly flooding of the audit table.
  await recordCronRun("sync:full", durationMs);

  const session = await auth();
  if (session?.user) {
    void logAudit({
      userId: session.user.id,
      userName: session.user.name ?? session.user.id,
      action: "LIBRARY_SYNC",
      target: "sync:full",
      details: { marked, reverted, repushed, plexMarked, jellyfinMarked, radarrWanted, sonarrWanted, durationMs },
    });
  }

  return NextResponse.json({
    checked: { approved: approved.length, available: available.length },
    marked,
    reverted,
    repushed,
    plexMarked,
    jellyfinMarked,
    radarrWanted,
    sonarrWanted,
  });
}
