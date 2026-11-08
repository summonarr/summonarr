// The Upcoming list, shared by the /upcoming page and GET /api/upcoming (the
// native clients' mirror): the cached feed (refreshed by the /api/sync/upcoming
// cron), live TMDB for whichever side the cache is missing, interleaved by
// release date. One definition, so the page and the route return one list.
import { prisma } from "./prisma";
import { getUpcomingMovies, getUpcomingTV } from "./tmdb";
import type { TmdbMedia } from "./tmdb-types";
import { upcomingCutoffDate } from "./format-release-date";

/** A cached row older than this is stale: the cron runs daily, so one missed run is survivable. */
export const UPCOMING_CACHE_MAX_AGE_MS = 49 * 60 * 60 * 1000;
/** The most cached rows read per request. */
export const UPCOMING_CACHE_TAKE = 500;

// Still-fresh, not-yet-released titles from the UpcomingCacheItem table.
async function readUpcomingCache(today: string, now: number): Promise<TmdbMedia[]> {
  const rows = await prisma.upcomingCacheItem.findMany({
    where: {
      cachedAt: { gt: new Date(now - UPCOMING_CACHE_MAX_AGE_MS) },
      releaseDate: { gte: today },
    },
    orderBy: { releaseDate: "asc" },
    take: UPCOMING_CACHE_TAKE,
  });
  return rows.map((r) => ({
    id: r.tmdbId,
    mediaType: r.mediaType === "MOVIE" ? "movie" : "tv",
    title: r.title,
    overview: r.overview,
    posterPath: r.posterPath,
    backdropPath: r.backdropPath,
    releaseDate: r.releaseDate,
    releaseYear: r.releaseYear,
    voteAverage: r.voteAverage,
  }));
}

/** Movies and shows released on or after `today`, alternating movie, show, movie, … in their given order. */
export function interleaveUpcoming(all: readonly TmdbMedia[], today: string): TmdbMedia[] {
  const isFuture = (m: TmdbMedia) => !!m.releaseDate && m.releaseDate >= today;
  const movies = all.filter((m) => m.mediaType === "movie" && isFuture(m));
  const tv = all.filter((m) => m.mediaType === "tv" && isFuture(m));
  const out: TmdbMedia[] = [];
  const maxLen = Math.max(movies.length, tv.length);
  for (let i = 0; i < maxLen; i++) {
    if (i < movies.length) out.push(movies[i]);
    if (i < tv.length) out.push(tv[i]);
  }
  return out;
}

export interface UpcomingSources {
  readCache: (today: string, now: number) => Promise<TmdbMedia[]>;
  liveMovies: () => Promise<TmdbMedia[]>;
  liveTv: () => Promise<TmdbMedia[]>;
}

const DEFAULT_SOURCES: UpcomingSources = {
  readCache: readUpcomingCache,
  liveMovies: getUpcomingMovies,
  liveTv: getUpcomingTV,
};

/**
 * The interleaved list, and whether it is empty because a read FAILED (not
 * because nothing is upcoming). Each read fails on its own: a failed live
 * fallback for one side keeps the other side's cached titles.
 */
export async function loadUpcomingTitles(
  now: number = Date.now(),
  sources: UpcomingSources = DEFAULT_SOURCES,
): Promise<{ titles: TmdbMedia[]; failed: boolean }> {
  const today = upcomingCutoffDate(now);
  const failures: string[] = [];
  const settle = (label: string, read: Promise<TmdbMedia[]>) =>
    read.catch((err: unknown) => {
      failures.push(label);
      console.error(`[upcoming] ${label} read failed:`, err instanceof Error ? err.message : err);
      return [] as TmdbMedia[];
    });

  const cached = await settle("cache", sources.readCache(today, now));
  const hasMovies = cached.some((m) => m.mediaType === "movie");
  const hasTV = cached.some((m) => m.mediaType === "tv");
  // Fall back to live TMDB for whichever side the cache is missing — covers
  // both a cold cache and the transitional state where prior runs cached
  // currently-airing TV (past first_air_date) that the gte filter now drops.
  const [movies, tv] = await Promise.all([
    hasMovies ? Promise.resolve([] as TmdbMedia[]) : settle("live movies", sources.liveMovies()),
    hasTV ? Promise.resolve([] as TmdbMedia[]) : settle("live tv", sources.liveTv()),
  ]);
  const titles = interleaveUpcoming([...cached, ...movies, ...tv], today);
  return { titles, failed: failures.length > 0 && titles.length === 0 };
}
