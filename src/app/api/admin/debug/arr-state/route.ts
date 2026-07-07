import { NextResponse } from "next/server";
import { withAdmin } from "@/lib/api-auth";
import { prisma } from "@/lib/prisma";
import { attachArrPending } from "@/lib/arr-availability";
import { arrFetch, getArrCfg, isArrConfigured, isMovieWantedInRadarr, isSeriesWantedInSonarr } from "@/lib/arr";
import { getCache } from "@/lib/tmdb-cache";
import type { TmdbMedia } from "@/lib/tmdb-types";

export const GET = withAdmin(async (req, _ctx, _session) => {
  const sp = req.nextUrl.searchParams;
  const tmdbIdRaw = sp.get("tmdbId");
  const type = sp.get("type");
  if (!tmdbIdRaw || (type !== "movie" && type !== "tv")) {
    return NextResponse.json({ error: "tmdbId and type=movie|tv required" }, { status: 400 });
  }
  const tmdbId = Number(tmdbIdRaw);
  if (!Number.isInteger(tmdbId) || tmdbId <= 0) {
    return NextResponse.json({ error: "tmdbId must be a positive integer" }, { status: 400 });
  }
  const dbType: "MOVIE" | "TV" = type === "movie" ? "MOVIE" : "TV";

  // attachArrPending only needs id and mediaType; other fields are irrelevant for this diagnostic
  const stub: TmdbMedia = {
    id: tmdbId,
    mediaType: type,
    title: "",
    overview: "",
    posterPath: null,
    backdropPath: null,
    releaseDate: null,
    releaseYear: "",
    voteAverage: 0,
  };

  // Fetch both the HD and 4K wanted-cache rows so the diagnostic can explain a
  // missing badge on either instance. The 4K row is only meaningful when a 4K
  // instance is configured (checked below), but the cache lookup is harmless.
  const service = type === "movie" ? "radarr" : "sonarr";
  const [wantedRow, wanted4kRow, has4kInstance] = await Promise.all([
    type === "movie"
      ? prisma.radarrWantedItem.findUnique({ where: { tmdbId_is4k: { tmdbId, is4k: false } } })
      : prisma.sonarrWantedItem.findUnique({ where: { tmdbId_is4k: { tmdbId, is4k: false } } }),
    type === "movie"
      ? prisma.radarrWantedItem.findUnique({ where: { tmdbId_is4k: { tmdbId, is4k: true } } })
      : prisma.sonarrWantedItem.findUnique({ where: { tmdbId_is4k: { tmdbId, is4k: true } } }),
    isArrConfigured(service, "4k"),
  ]);

  const mediaRequests = await prisma.mediaRequest.findMany({
    where: { tmdbId, mediaType: dbType },
    select: { id: true, status: true, requestedBy: true, tvdbId: true, createdAt: true, updatedAt: true },
    orderBy: { createdAt: "desc" },
  });

  const enriched = await attachArrPending([stub]);
  const arrPendingResult = enriched[0]?.arrPending ?? false;

  let liveCheck: { result: boolean; error?: string };
  try {
    const result = type === "movie"
      ? await isMovieWantedInRadarr(tmdbId)
      : await isSeriesWantedInSonarr(tmdbId);
    liveCheck = { result };
  } catch (err) {
    // Don't leak raw Arr error detail (may carry the configured server URL /
    // upstream body) to the client — log it server-side, return a generic flag.
    console.error("[arr-state] live Arr check failed:", err instanceof Error ? err.message : err);
    liveCheck = { result: false, error: "live Arr check failed" };
  }

  // Same live check against the 4K instance, when one is configured. Lets the
  // diagnostic explain a missing 4K badge without a second endpoint.
  let liveCheck4k: { result: boolean; error?: string } | null = null;
  if (has4kInstance) {
    try {
      const result = type === "movie"
        ? await isMovieWantedInRadarr(tmdbId, "4k")
        : await isSeriesWantedInSonarr(tmdbId, "4k");
      liveCheck4k = { result };
    } catch (err) {
      console.error("[arr-state] live Arr 4K check failed:", err instanceof Error ? err.message : err);
      liveCheck4k = { result: false, error: "live Arr 4K check failed" };
    }
  }

  let tvdbInfo: {
    tvdbId: number | null;
    cachedMapping?: { tmdbId: number | null } | null;
  } | null = null;
  if (type === "tv") {
    try {
      // Route through arrFetch so the lookup inherits the 30s timeout, 50 MB
      // cap, X-Api-Key injection, and ArrResponseError handling (vs. a bare
      // safeFetchAdminConfigured that defaulted to a 10 MB cap / 15s timeout).
      const cfg = await getArrCfg("sonarr");
      if (cfg) {
        const lookup = await arrFetch<{ tvdbId?: number }[]>(
          cfg, `/api/v3/series/lookup?term=tmdb:${tmdbId}`,
        );
        const tvdbId = lookup[0]?.tvdbId ?? null;
        let cachedMapping: { tmdbId: number | null } | null = null;
        // Expose any negative-cached tvdb→tmdb mapping so stale entries can be diagnosed
        if (tvdbId) {
          cachedMapping = await getCache<{ tmdbId: number | null }>(`tvdb-to-tmdb:${tvdbId}`);
        }
        tvdbInfo = { tvdbId, cachedMapping };
      }
    } catch (err) {
      // Don't surface raw Arr error detail (configured server URL / upstream
      // body) to the client — log server-side, return a generic flag.
      console.error("[arr-state] sonarr series lookup failed:", err instanceof Error ? err.message : err);
      tvdbInfo = { tvdbId: null, cachedMapping: { tmdbId: null }, error: "sonarr lookup failed" } as typeof tvdbInfo;
    }
  }

  const lastSync = await prisma.auditLog.findFirst({
    where: { action: "LIBRARY_SYNC" },
    orderBy: { createdAt: "desc" },
    select: { createdAt: true, details: true },
  });
  let lastSyncDetails: unknown = null;
  if (lastSync?.details) {
    try { lastSyncDetails = JSON.parse(lastSync.details); } catch { lastSyncDetails = lastSync.details; }
  }

  const [radarrTotal, sonarrTotal] = await Promise.all([
    prisma.radarrWantedItem.count(),
    prisma.sonarrWantedItem.count(),
  ]);

  return NextResponse.json({
    query: { tmdbId, type },
    cacheTable: {
      tableName: type === "movie" ? "radarrWantedItem" : "sonarrWantedItem",
      row: wantedRow,
      hasEntry: !!wantedRow,
    },
    fourK: {
      instanceConfigured: has4kInstance,
      cacheRow: wanted4kRow,
      hasEntry: !!wanted4kRow,
      liveArrApi: liveCheck4k,
    },
    attachArrPendingReturns: arrPendingResult,
    liveArrApi: liveCheck,
    mediaRequests,
    tvdbInfo,
    wantedTableTotals: { radarr: radarrTotal, sonarr: sonarrTotal },
    lastFullSync: lastSync ? { at: lastSync.createdAt, details: lastSyncDetails } : null,
  });
});
