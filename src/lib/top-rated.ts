import "server-only";
import type { SummonarrSession } from "@/lib/api-auth";
import type { TmdbMedia } from "@/lib/tmdb-types";
import { getTopRatedMovies, getTopRatedTV } from "@/lib/tmdb";
import { getTraktPopularMovies, getTraktPopularTV } from "@/lib/trakt";
import { getMdblistTopRated, mdblistCacheKey } from "@/lib/mdblist";
import { omdbCacheKey } from "@/lib/omdb";
import { getCacheStaleMany } from "@/lib/tmdb-cache";
import { attachAllAvailability } from "@/lib/attach-all";
import { getUserHiddenSet, hiddenKeyOf } from "@/lib/hidden";
import { getBadgeVisibility } from "@/lib/badge-visibility";
import { getShow4kVisibility } from "@/lib/four-k-visibility";
import { isFeatureEnabled } from "@/lib/features";
import { prisma } from "@/lib/prisma";

// The deduplicated top-rated pool behind /top and /api/top-rated: TMDB's
// top-rated lists, then Trakt popular, then MDBList's top lists, ranked by a
// chosen rating source.
//
// The page and the route each carried a copy of this ("keep in sync"), and the
// copies drifted: the page still built one OR clause per posterless title and
// compared unvalidated year strings, which the route had stopped doing. One
// module now, the way browse-query.ts serves /movies, /tv and /api/browse.

export const TOP_RATED_PER_PAGE = 36;

export type TopRatedSort = "imdb" | "letterboxd" | "rt" | "trakt" | "mdblist";
const SORTS: ReadonlySet<string> = new Set<TopRatedSort>(["imdb", "letterboxd", "rt", "trakt", "mdblist"]);

export interface TopRatedQuery {
  mediaType?: "movies" | "tv";
  sortBy: TopRatedSort;
  minImdb?: string;
  minVotes?: string;
  fromYear?: string;
  toYear?: string;
  hideAvailable: boolean;
}

// releaseYear is a 4-digit string compared as a string, so only a 4-digit year
// may bound it: `fromYear=99` or `abc` sorts against "1999" in ways nobody
// meant and emptied the list. A value that doesn't parse is "not set", as is
// an unknown mediaType (it showed both sections under a "TV only" chip).
const YEAR = /^\d{4}$/;
const DECIMAL = /^\d+(\.\d+)?$/;
const COUNT = /^\d+$/;

// `get` is URLSearchParams.get or a page's searchParamGetter.
export function parseTopRatedQuery(get: (key: string) => string | null | undefined): TopRatedQuery {
  const valid = (key: string, shape: RegExp): string | undefined => {
    const v = get(key);
    return v && shape.test(v) ? v : undefined;
  };
  const mediaType = get("mediaType");
  const sortBy = get("sortBy");
  return {
    mediaType: mediaType === "movies" || mediaType === "tv" ? mediaType : undefined,
    sortBy: sortBy && SORTS.has(sortBy) ? (sortBy as TopRatedSort) : "imdb",
    minImdb: valid("minImdb", DECIMAL),
    minVotes: valid("minVotes", COUNT),
    fromYear: valid("fromYear", YEAR),
    toYear: valid("toYear", YEAR),
    hideAvailable: get("hideAvailable") === "1",
  };
}

// Any filter set (mediaType and the sort are not filters: they choose what is
// listed, not what is left out).
export function topRatedHasFilters(q: TopRatedQuery): boolean {
  return q.hideAvailable || !!q.minImdb || !!q.minVotes || !!q.fromYear || !!q.toYear;
}

// The query string for `q`, defaults omitted — a link back to the same view
// built from the normalised values, never the raw params.
export function topRatedSearch(q: TopRatedQuery, page = 1): string {
  const params = new URLSearchParams();
  if (q.mediaType) params.set("mediaType", q.mediaType);
  if (q.sortBy !== "imdb") params.set("sortBy", q.sortBy);
  if (q.minImdb) params.set("minImdb", q.minImdb);
  if (q.minVotes) params.set("minVotes", q.minVotes);
  if (q.fromYear) params.set("fromYear", q.fromYear);
  if (q.toYear) params.set("toYear", q.toYear);
  if (q.hideAvailable) params.set("hideAvailable", "1");
  if (page > 1) params.set("page", String(page));
  return params.toString();
}

function ratingOf(m: TmdbMedia, sortBy: TopRatedSort): number {
  switch (sortBy) {
    case "letterboxd":
      return parseFloat(m.letterboxdRating ?? "");
    case "rt":
      return parseInt(m.rottenTomatoes?.replace("%", "") ?? "", 10);
    case "trakt":
      return parseFloat(m.traktRating ?? "");
    case "mdblist":
      return parseFloat(m.mdblistScore ?? "");
    default:
      return parseFloat(m.imdbRating ?? "");
  }
}

// Rated titles first, highest first; unrated ones after, by TMDB vote average.
// The sort is stable, so ties keep source order.
function byRating<T extends TmdbMedia>(items: T[], value: (m: T) => number): T[] {
  return [...items].sort((a, b) => {
    const av = value(a);
    const bv = value(b);
    if (!isNaN(av) && !isNaN(bv)) return bv - av;
    if (!isNaN(av)) return -1;
    if (!isNaN(bv)) return 1;
    return b.voteAverage - a.voteAverage;
  });
}

export function sortByRating<T extends TmdbMedia>(items: T[], sortBy: TopRatedSort): T[] {
  return byRating(items, (m) => ratingOf(m, sortBy));
}

// Merge the per-source arrays, keeping the first occurrence of each mediaType:id.
export function dedupSources(sources: TmdbMedia[][]): TmdbMedia[] {
  const seen = new Set<string>();
  const result: TmdbMedia[] = [];
  for (const items of sources) {
    for (const item of items) {
      const key = `${item.mediaType}:${item.id}`;
      if (!seen.has(key)) {
        seen.add(key);
        result.push(item);
      }
    }
  }
  return result;
}

// Fill posterless items (Trakt/MDBList entries lacking TMDB fields) from the
// TmdbMediaCore cache. Two `IN` lists (one per media type), never one OR clause
// per item: every Trakt title is posterless, so on a whole pool that was ~1,000
// clauses. The table's key is [tmdbId, mediaType], so two id lists are two
// cheap index lookups.
export async function backfillMetadata(items: TmdbMedia[]): Promise<TmdbMedia[]> {
  const missing = items.filter((i) => !i.posterPath);
  if (missing.length === 0) return items;

  const movieIds = missing.filter((i) => i.mediaType === "movie").map((i) => i.id);
  const tvIds = missing.filter((i) => i.mediaType !== "movie").map((i) => i.id);
  const coreRows = await prisma.tmdbMediaCore.findMany({
    where: {
      OR: [
        ...(movieIds.length ? [{ mediaType: "MOVIE" as const, tmdbId: { in: movieIds } }] : []),
        ...(tvIds.length ? [{ mediaType: "TV" as const, tmdbId: { in: tvIds } }] : []),
      ],
    },
  });
  const coreMap = new Map(coreRows.map((r) => [`${r.mediaType}:${r.tmdbId}`, r]));

  return items.map((item) => {
    if (item.posterPath) return item;
    const core = coreMap.get(`${item.mediaType === "movie" ? "MOVIE" : "TV"}:${item.id}`);
    if (!core) return item;
    return {
      ...item,
      title: core.title || item.title,
      posterPath: core.posterPath ?? item.posterPath,
      releaseYear: core.releaseYear ?? item.releaseYear,
      voteAverage: core.voteAverage ?? item.voteAverage,
    };
  });
}

export interface TopRatedFilterOptions {
  hideAvailable: boolean;
  showPlex: boolean;
  showJellyfin: boolean;
  minImdb?: string;
  minVotes?: string;
  fromYear?: string;
  toYear?: string;
}

// The availability / rating / vote-count / year filters. They read fields that
// exist only after attachAllAvailability.
export function applyFilters<T extends TmdbMedia>(items: T[], opts: TopRatedFilterOptions): T[] {
  let result = items;
  if (opts.hideAvailable) {
    // Gate on the user's own server visibility: a Plex-pinned user must not have
    // Jellyfin-only titles hidden (and vice versa).
    result = result.filter((m) => !((opts.showPlex && m.plexAvailable) || (opts.showJellyfin && m.jellyfinAvailable)));
  }
  if (opts.minImdb) {
    const threshold = parseFloat(opts.minImdb);
    if (!isNaN(threshold)) {
      result = result.filter((m) => {
        const r = parseFloat(m.imdbRating ?? "");
        return !isNaN(r) && r >= threshold;
      });
    }
  }
  if (opts.minVotes) {
    const threshold = parseInt(opts.minVotes, 10);
    if (!isNaN(threshold)) {
      // Unknown voteCount passes — non-TMDB sources (Trakt/MDBList) carry no vote counts; only a known count is filterable (cf. content-rating.ts exceedsCap).
      result = result.filter((m) => typeof m.voteCount !== "number" || m.voteCount >= threshold);
    }
  }
  const { fromYear, toYear } = opts;
  if (fromYear || toYear) {
    // A title with no year is outside EITHER bound. It used to fail `fromYear`
    // ("" sorts before every year) but pass `toYear` for the same reason.
    result = result.filter((m) => {
      const year = m.releaseYear ?? "";
      if (!YEAR.test(year)) return false;
      return (!fromYear || year >= fromYear) && (!toYear || year <= toYear);
    });
  }
  return result;
}

// Cached IMDb ratings for a whole pool, read from the ratings cache ONLY — no
// upstream call, inline or after the response. Same precedence as the ratings
// merge (omdb-availability.ts): the MDBList row's value, else the OMDb row's.
// Stale rows count (they are what the cards show); "not found" sentinels and
// misses are unrated. Read in chunks so one IN list stays bounded.
const CACHE_READ_CHUNK = 1_000;

function imdbOf(row: { value: unknown } | undefined): string | undefined {
  const v = row?.value;
  if (!v || typeof v !== "object" || "_notFound" in v) return undefined;
  const rating = (v as { imdbRating?: unknown }).imdbRating;
  return typeof rating === "string" && rating !== "" ? rating : undefined;
}

export async function readCachedImdbRatings(items: TmdbMedia[]): Promise<Map<string, string>> {
  const keys: string[] = [];
  for (const m of items) keys.push(mdblistCacheKey(m.mediaType, m.id), omdbCacheKey(m.mediaType, m.id));
  const rows = new Map<string, { value: unknown }>();
  for (let i = 0; i < keys.length; i += CACHE_READ_CHUNK) {
    const part = await getCacheStaleMany<unknown>(keys.slice(i, i + CACHE_READ_CHUNK));
    for (const [key, row] of part) rows.set(key, row);
  }
  const out = new Map<string, string>();
  for (const m of items) {
    const rating = imdbOf(rows.get(mdblistCacheKey(m.mediaType, m.id))) ?? imdbOf(rows.get(omdbCacheKey(m.mediaType, m.id)));
    if (rating) out.set(`${m.mediaType}:${m.id}`, rating);
  }
  return out;
}

// The default view's order: the whole pool by cached IMDb rating. The pool is
// NOT rating-ordered by source — after TMDB's top-rated lists it continues with
// Trakt's POPULAR lists — so sorting each page on its own let page 2 hold
// higher-rated titles than page 1.
export function sortByCachedImdb<T extends TmdbMedia>(items: T[], imdb: ReadonlyMap<string, string>): T[] {
  return byRating(items, (m) => parseFloat(imdb.get(`${m.mediaType}:${m.id}`) ?? ""));
}

export interface TopRatedResult {
  movies: TmdbMedia[];
  tv: TmdbMedia[];
  totalMovies: number;
  totalTv: number;
  totalPages: number;
  /** How many of the three sources contributed anything. */
  sourceCount: number;
  /** Badge visibility, for the page's cards. */
  showPlex: boolean;
  showJellyfin: boolean;
}

export async function runTopRatedQuery(input: {
  query: TopRatedQuery;
  /** Already clamped by the caller. */
  page: number;
  session: SummonarrSession;
}): Promise<TopRatedResult> {
  const { query, page, session } = input;
  const userId = session.user.id;
  const wantMovies = query.mediaType !== "tv";
  const wantTv = query.mediaType !== "movies";

  // A single down source degrades to an empty contribution rather than failing
  // the whole list. Logged so a silently-missing source is diagnosable.
  const fromSource = (name: string, want: boolean, load: () => Promise<TmdbMedia[]>): Promise<TmdbMedia[]> =>
    want
      ? load().catch((err: unknown) => {
          console.error(`[top-rated] source ${name} failed:`, err instanceof Error ? err.message : err);
          return [];
        })
      : Promise.resolve([]);

  const [
    tmdbMovies, tmdbTv,
    traktMovies, traktTv,
    mdbMovies, mdbTv,
    show4k, plexEnabled, jellyfinEnabled, hidden,
  ] = await Promise.all([
    fromSource("tmdb-movies", wantMovies, getTopRatedMovies),
    fromSource("tmdb-tv", wantTv, getTopRatedTV),
    fromSource("trakt-movies", wantMovies, getTraktPopularMovies),
    fromSource("trakt-tv", wantTv, getTraktPopularTV),
    fromSource("mdblist-movies", wantMovies, () => getMdblistTopRated("movie")),
    fromSource("mdblist-tv", wantTv, () => getMdblistTopRated("tv")),
    getShow4kVisibility(session),
    isFeatureEnabled("feature.integration.plex"),
    isFeatureEnabled("feature.integration.jellyfin"),
    getUserHiddenSet(userId),
  ]);
  // Integration flags passed explicitly — they default to TRUE when omitted.
  const { showPlex, showJellyfin } = getBadgeVisibility(session, { plex: plexEnabled, jellyfin: jellyfinEnabled });

  // The viewer's hidden titles leave the POOL, before anything is paged —
  // guardrail 35a's rule for server-hidden titles. Removed from each page
  // instead (attachAllAvailability's own filter), pages came up short and the
  // totals still counted them. The enrichment below is told not to re-read the set.
  const unhidden = (items: TmdbMedia[]) =>
    hidden.size === 0 ? items : items.filter((m) => !hidden.has(hiddenKeyOf(m)));
  const allMovies = unhidden(dedupSources([tmdbMovies, traktMovies, mdbMovies]));
  const allTv = unhidden(dedupSources([tmdbTv, traktTv, mdbTv]));

  const offset = (page - 1) * TOP_RATED_PER_PAGE;
  const filterOpts: TopRatedFilterOptions = {
    hideAvailable: query.hideAvailable,
    showPlex,
    showJellyfin,
    minImdb: query.minImdb,
    minVotes: query.minVotes,
    fromYear: query.fromYear,
    toYear: query.toYear,
  };
  // applyFilters and a non-IMDb sort read fields that exist only after
  // enrichment, so with either active the WHOLE pool is enriched, filtered and
  // sorted before paging (pages aren't short and the totals are the filtered
  // count). Ratings stay non-blocking: blocking on a whole pool's misses would
  // burn the OMDB daily quota on one cold load (a title whose rating is still
  // uncached drops out of minImdb until the post-response warm fills it).
  const filtersActive = topRatedHasFilters(query) || query.sortBy !== "imdb";
  const enrich = (items: TmdbMedia[]) =>
    attachAllAvailability(items, userId, { show4k, includeHidden: true });

  const rank = async (pool: TmdbMedia[]): Promise<{ items: TmdbMedia[]; total: number }> => {
    if (pool.length === 0) return { items: [], total: 0 };
    const filled = await backfillMetadata(pool);
    if (filtersActive) {
      const ranked = sortByRating(applyFilters(await enrich(filled), filterOpts), query.sortBy);
      return { items: ranked.slice(offset, offset + TOP_RATED_PER_PAGE), total: ranked.length };
    }
    // The default view: the whole pool ordered by cached IMDb rating (a cache
    // read, no enrichment), then only the visible page enriched.
    const ranked = sortByCachedImdb(filled, await readCachedImdbRatings(filled));
    const slice = ranked.slice(offset, offset + TOP_RATED_PER_PAGE);
    return { items: slice.length > 0 ? await enrich(slice) : [], total: ranked.length };
  };

  const [movies, tv] = await Promise.all([rank(allMovies), rank(allTv)]);

  return {
    movies: movies.items,
    tv: tv.items,
    totalMovies: movies.total,
    totalTv: tv.total,
    totalPages: Math.max(1, Math.ceil(movies.total / TOP_RATED_PER_PAGE), Math.ceil(tv.total / TOP_RATED_PER_PAGE)),
    sourceCount: [
      tmdbMovies.length || tmdbTv.length,
      traktMovies.length || traktTv.length,
      mdbMovies.length || mdbTv.length,
    ].filter(Boolean).length,
    showPlex,
    showJellyfin,
  };
}
