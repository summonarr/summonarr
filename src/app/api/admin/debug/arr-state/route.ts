import { NextResponse } from "next/server";
import { withAdmin } from "@/lib/api-auth";
import { prisma } from "@/lib/prisma";
import { attachArrPending } from "@/lib/arr-availability";
import { arrFetch, getArrCfg, isArrConfigured, isMovieWantedInRadarr, isSeriesWantedInSonarr } from "@/lib/arr";
import { getArrInstances } from "@/lib/arr-instance-registry";
import { mapLimit } from "@/lib/concurrency";
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

  const service = type === "movie" ? "radarr" : "sonarr";

  // Generalized per-instance view: iterate every configured instance (default
  // first, plus legacy 4k and any named instances) so the diagnostic can explain
  // a missing badge on ANY instance, not just HD/4K. The legacy top-level
  // `cacheTable` / `fourK` / `liveArrApi` fields are DERIVED from this list below
  // (getArrInstances always yields the default first and includes "4k" whenever
  // it is configured) — re-reading the rows / re-running the live checks for
  // those two slugs doubled the DB reads and the 30s-timeout Arr round-trips on
  // a route meant to be hit whenever a badge looks wrong.
  const [instanceConfigs, has4kInstance] = await Promise.all([
    getArrInstances(service),
    isArrConfigured(service, "4k"),
  ]);
  const instances = await mapLimit(instanceConfigs, 4, async (inst) => {
    const cacheRow = type === "movie"
      ? await prisma.radarrWantedItem.findUnique({ where: { tmdbId_arrInstance: { tmdbId, arrInstance: inst.slug } } })
      : await prisma.sonarrWantedItem.findUnique({ where: { tmdbId_arrInstance: { tmdbId, arrInstance: inst.slug } } });
    let liveArrApi: { result: boolean; error?: string };
    try {
      const result = type === "movie"
        ? await isMovieWantedInRadarr(tmdbId, inst.slug)
        : await isSeriesWantedInSonarr(tmdbId, inst.slug);
      liveArrApi = { result };
    } catch (err) {
      // Don't leak raw Arr error detail (may carry the configured server URL /
      // upstream body) to the client — log it server-side, return a generic flag.
      console.error(`[arr-state] live Arr check failed (instance=${inst.slug}):`, err instanceof Error ? err.message : err);
      liveArrApi = { result: false, error: "live Arr check failed" };
    }
    return { slug: inst.slug, name: inst.name, cacheRow, hasEntry: !!cacheRow, liveArrApi };
  });

  // Legacy HD/4K sections, derived from the per-instance results (additive: the
  // debug UI still reads them). `has4kInstance` is its own predicate on purpose —
  // a registry-listed-but-unconfigured "4k" entry still appears in `instances`,
  // so mere presence there must not report the instance as configured.
  const defaultInst = instances.find((i) => i.slug === "");
  const fourKInst = instances.find((i) => i.slug === "4k");
  const wantedRow = defaultInst?.cacheRow ?? null;
  const wanted4kRow = fourKInst?.cacheRow ?? null;
  const liveCheck: { result: boolean; error?: string } = defaultInst?.liveArrApi ?? { result: false };
  const liveCheck4k: { result: boolean; error?: string } | null =
    has4kInstance ? (fourKInst?.liveArrApi ?? null) : null;

  const mediaRequests = await prisma.mediaRequest.findMany({
    where: { tmdbId, mediaType: dbType },
    select: { id: true, status: true, requestedBy: true, tvdbId: true, createdAt: true, updatedAt: true },
    orderBy: { createdAt: "desc" },
  });

  const enriched = await attachArrPending([stub]);
  const arrPendingResult = enriched[0]?.arrPending ?? false;

  let tvdbInfo: {
    tvdbId: number | null;
    cachedMapping?: { tmdbId: number | null } | null;
    error?: string;
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
      // `cachedMapping` must be null here, not `{ tmdbId: null }` — that shape is
      // exactly what a genuine NEGATIVE tvdb→tmdb cache entry looks like, and
      // nothing was read (the lookup never produced a tvdbId to key on).
      tvdbInfo = { tvdbId: null, cachedMapping: null, error: "sonarr lookup failed" };
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
    instances,
    attachArrPendingReturns: arrPendingResult,
    liveArrApi: liveCheck,
    mediaRequests,
    tvdbInfo,
    wantedTableTotals: { radarr: radarrTotal, sonarr: sonarrTotal },
    lastFullSync: lastSync ? { at: lastSync.createdAt, details: lastSyncDetails } : null,
  });
});
