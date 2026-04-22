import { NextRequest, NextResponse } from "next/server";
import { requireAuth } from "@/lib/api-auth";
import { prisma } from "@/lib/prisma";
import { attachArrPending } from "@/lib/arr-availability";
import { isMovieWantedInRadarr, isSeriesWantedInSonarr } from "@/lib/arr";
import { getCache } from "@/lib/tmdb-cache";
import { safeFetchTrusted } from "@/lib/safe-fetch";
import type { TmdbMedia } from "@/lib/tmdb-types";

export async function GET(req: NextRequest) {
  const session = await requireAuth({ role: "ADMIN" });
  if (session instanceof NextResponse) return session;

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

  const wantedRow = type === "movie"
    ? await prisma.radarrWantedItem.findUnique({ where: { tmdbId } })
    : await prisma.sonarrWantedItem.findUnique({ where: { tmdbId } });

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
    liveCheck = { result: false, error: err instanceof Error ? err.message : String(err) };
  }

  let tvdbInfo: {
    tvdbId: number | null;
    cachedMapping?: { tmdbId: number | null } | null;
  } | null = null;
  if (type === "tv") {
    try {
      const cfgRows = await prisma.setting.findMany({
        where: { key: { in: ["sonarrUrl", "sonarrApiKey"] } },
      });
      const cfgMap = Object.fromEntries(cfgRows.map((r) => [r.key, r.value]));
      if (cfgMap.sonarrUrl && cfgMap.sonarrApiKey) {
        const url = `${cfgMap.sonarrUrl.replace(/\/$/, "")}/api/v3/series/lookup?term=tmdb:${tmdbId}`;
        const res = await safeFetchTrusted(url, {
          headers: { "X-Api-Key": cfgMap.sonarrApiKey },
          timeoutMs: 10_000,
        });
        if (res.ok) {
          const lookup = await res.json() as { tvdbId?: number }[];
          const tvdbId = lookup[0]?.tvdbId ?? null;
          let cachedMapping: { tmdbId: number | null } | null = null;
          // Expose any negative-cached tvdb→tmdb mapping so stale entries can be diagnosed
          if (tvdbId) {
            cachedMapping = await getCache<{ tmdbId: number | null }>(`tvdb-to-tmdb:${tvdbId}`);
          }
          tvdbInfo = { tvdbId, cachedMapping };
        } else {
          tvdbInfo = { tvdbId: null };
        }
      }
    } catch (err) {
      tvdbInfo = { tvdbId: null, cachedMapping: { tmdbId: null }, ...(err instanceof Error ? { error: err.message } : {}) } as typeof tvdbInfo;
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
    attachArrPendingReturns: arrPendingResult,
    liveArrApi: liveCheck,
    mediaRequests,
    tvdbInfo,
    wantedTableTotals: { radarr: radarrTotal, sonarr: sonarrTotal },
    lastFullSync: lastSync ? { at: lastSync.createdAt, details: lastSyncDetails } : null,
  });
}
