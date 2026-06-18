import "server-only";
import { prisma } from "./prisma";
import { getCache, setCache, TTL } from "./tmdb-cache";
import { safeFetchTrusted } from "./safe-fetch";

// In-process request coalescing: concurrent callers for the same detail page share one upstream fetch
// rather than hammering TMDB and writing the same cache row N times.
const inflight = new Map<string, Promise<unknown>>();
function coalesce<T>(key: string, factory: () => Promise<T>): Promise<T> {
  const existing = inflight.get(key) as Promise<T> | undefined;
  if (existing) return existing;
  const promise = factory().finally(() => { inflight.delete(key); });
  inflight.set(key, promise);
  return promise;
}
import { syncTmdbMediaCore, upsertTmdbMediaCore } from "./tmdb-core-sync";
import { getOmdbRatingsForTmdb } from "./omdb";
import { getMdblistRatingsForTmdb } from "./mdblist";
import { tmdbAuth } from "./tmdb-auth";
import type {
  TmdbMedia, MediaType, CastMember, PersonDetails, PersonCredit,
  Genre, DiscoverFilters, WatchProvider, TmdbSeason, TmdbEpisode,
} from "./tmdb-types";

type UnifiedRatings = {
  imdbId: string | null;
  imdbRating: string | null;
  imdbVotes: string | null;
  rottenTomatoes: string | null;
  rtAudienceScore: string | null;
  metacritic: string | null;
  traktRating: string | null;
};

// MDBList is tried first because it returns more ratings fields (Trakt, Letterboxd, RT Audience).
// OMDB is only consulted when MDBList has no API key configured — not when MDBList simply lacks the item.
async function fetchUnifiedRatings(
  tmdbId: number,
  mediaType: "movie" | "tv",
  releaseDate?: string | null,
): Promise<{ found: boolean; keyConfigured: boolean; data?: UnifiedRatings }> {
  const mdb = await getMdblistRatingsForTmdb(tmdbId, mediaType, releaseDate).catch(
    () => ({ found: false, keyConfigured: true } as const),
  );
  if (mdb.found) {
    return {
      found: true,
      keyConfigured: true,
      data: {
        imdbId: mdb.data.imdbId,
        imdbRating: mdb.data.imdbRating,
        imdbVotes: mdb.data.imdbVotes,
        rottenTomatoes: mdb.data.rottenTomatoes,
        rtAudienceScore: mdb.data.rtAudienceScore,
        metacritic: mdb.data.metacritic,
        traktRating: mdb.data.traktRating,
      },
    };
  }

  if (mdb.keyConfigured) return { found: false, keyConfigured: true };

  const omdb = await getOmdbRatingsForTmdb(tmdbId, mediaType, releaseDate).catch(
    () => ({ found: false, keyConfigured: true } as const),
  );
  if (omdb.found) {
    return {
      found: true,
      keyConfigured: true,
      data: {
        imdbId: omdb.data.imdbId,
        imdbRating: omdb.data.imdbRating,
        imdbVotes: omdb.data.imdbVotes,
        rottenTomatoes: omdb.data.rottenTomatoes,
        rtAudienceScore: null,
        metacritic: omdb.data.metacritic,
        traktRating: null,
      },
    };
  }
  return { found: false, keyConfigured: omdb.keyConfigured };
}

export type {
  TmdbMedia, MediaType, CastMember, PersonDetails, PersonCredit,
  Genre, DiscoverFilters, WatchProvider, TmdbSeason, TmdbEpisode,
};
export { posterUrl, backdropUrl, stillUrl } from "./tmdb-types";

const BASE_URL = "https://api.themoviedb.org/3";

async function tmdbFetch<T>(path: string, params?: Record<string, string>, revalidate = 3600): Promise<T> {
  const auth = tmdbAuth();
  if (!auth) {
    throw new Error("No TMDB credentials configured (set TMDB_READ_TOKEN)");
  }
  const url = new URL(`${BASE_URL}${path}`);
  for (const [k, v] of Object.entries(auth.query)) url.searchParams.set(k, v);
  if (params) {
    for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
  }

  // Re-anchor to a literal origin so the host is verifiably not user-controlled
  const tmdbUrl = new URL(url.pathname + url.search, "https://api.themoviedb.org").toString();

  let lastErr: unknown;
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const res = await safeFetchTrusted(tmdbUrl, {
        allowedHosts: ["api.themoviedb.org"],
        headers: auth.headers,
        next: { revalidate },
      });
      if (!res.ok) throw new Error(`TMDB ${path} failed: ${res.status}`);
      const data = await res.json();

      if (data == null || typeof data !== "object") {
        throw new Error(`TMDB ${path} returned invalid response: ${typeof data}`);
      }
      return data as T;
    } catch (err) {
      // UND_ERR_SOCKET is a transient undici connection reset; retry twice before surfacing the error
      const cause = (err as { cause?: { code?: string } })?.cause;
      const isSocketError =
        cause?.code === "UND_ERR_SOCKET" ||
        (err instanceof Error && err.message.includes("UND_ERR_SOCKET"));
      if (isSocketError && attempt < 2) {
        lastErr = err;
        continue;
      }
      throw err;
    }
  }
  throw lastErr;
}

interface RawVideos {
  results: { key: string; site: string; type: string; official: boolean }[];
}

interface RawCastMember {
  id: number; name: string; character: string; profile_path: string | null; order: number;
}

interface RawKeywords {
  keywords?: { id: number; name: string }[];
  results?: { id: number; name: string }[];
}

interface RawWatchProviders {
  results?: Record<
    string,
    {
      flatrate?: { provider_id: number; provider_name: string; logo_path: string | null }[];
      rent?: { provider_id: number; provider_name: string; logo_path: string | null }[];
      buy?: { provider_id: number; provider_name: string; logo_path: string | null }[];
    }
  >;
}

interface RawMovie {
  id: number;
  title: string;
  original_title?: string;
  overview: string;
  poster_path: string | null;
  backdrop_path: string | null;
  release_date?: string;
  vote_average: number;
  vote_count: number;
  media_type?: string;
  genres?: { id: number; name: string }[];
  production_companies?: { id: number; name: string }[];
  production_countries?: { iso_3166_1: string; name: string }[];
  spoken_languages?: { iso_639_1: string; english_name?: string; name?: string }[];
  original_language?: string;
  tagline?: string;
  status?: string;
  runtime?: number | null;
  homepage?: string | null;
  budget?: number | null;
  revenue?: number | null;
  release_dates?: {
    results: { iso_3166_1: string; release_dates: { certification: string; type: number }[] }[];
  };
  videos?: RawVideos;
  belongs_to_collection?: { id: number; name: string } | null;
  credits?: { cast: RawCastMember[] };
  recommendations?: { results: RawMovie[] };
  similar?: { results: RawMovie[] };
  keywords?: RawKeywords;
  "watch/providers"?: RawWatchProviders;
  external_ids?: { imdb_id?: string | null; tvdb_id?: number | null };
}

interface RawTV {
  id: number;
  name: string;
  original_name?: string;
  overview: string;
  poster_path: string | null;
  backdrop_path: string | null;
  first_air_date?: string;
  last_air_date?: string | null;
  vote_average: number;
  vote_count: number;
  media_type?: string;
  genres?: { id: number; name: string }[];
  networks?: { id: number; name: string }[];
  production_companies?: { id: number; name: string }[];
  production_countries?: { iso_3166_1: string; name: string }[];
  origin_country?: string[];
  spoken_languages?: { iso_639_1: string; english_name?: string; name?: string }[];
  original_language?: string;
  tagline?: string;
  status?: string;
  type?: string;
  in_production?: boolean;
  homepage?: string | null;
  episode_run_time?: number[];
  number_of_seasons?: number | null;
  number_of_episodes?: number | null;
  next_episode_to_air?: { air_date?: string | null } | null;
  content_ratings?: {
    results: { iso_3166_1: string; rating: string }[];
  };
  videos?: RawVideos;
  credits?: { cast: RawCastMember[] };
  recommendations?: { results: RawTV[] };
  similar?: { results: RawTV[] };
  keywords?: RawKeywords;
  "watch/providers"?: RawWatchProviders;
  external_ids?: { imdb_id?: string | null; tvdb_id?: number | null };
  seasons?: {
    season_number: number;
    episode_count: number;
    air_date: string | null;
    poster_path: string | null;
    name: string;
    overview: string;
  }[];
}

interface RawEpisode {
  episode_number: number;
  season_number: number;
  name: string;
  overview: string;
  air_date: string | null;
  still_path: string | null;
  runtime: number | null;
  vote_average: number;
}

function extractTrailerKey(videos?: RawVideos): string | null {
  if (!videos?.results.length) return null;
  const trailers = videos.results.filter((v) => v.site === "YouTube" && v.type === "Trailer");
  const teasers  = videos.results.filter((v) => v.site === "YouTube" && v.type === "Teaser");
  const official = trailers.find((v) => v.official) ?? trailers[0] ?? teasers.find((v) => v.official) ?? teasers[0];
  return official?.key ?? null;
}

interface PagedResponse<T> {
  results: T[];
  total_pages: number;
  total_results: number;
}

// Best-effort ISO-code → English display name. Intl.DisplayNames is available in the Node runtime;
// fall back to the raw code if the lookup throws or returns nothing.
let regionNames: Intl.DisplayNames | null = null;
let languageNames: Intl.DisplayNames | null = null;
function displayRegion(code: string): string {
  try {
    regionNames ??= new Intl.DisplayNames(["en"], { type: "region" });
    return regionNames.of(code.toUpperCase()) ?? code;
  } catch {
    return code;
  }
}
function displayLanguage(code: string): string {
  try {
    languageNames ??= new Intl.DisplayNames(["en"], { type: "language" });
    return languageNames.of(code) ?? code;
  } catch {
    return code;
  }
}

function extractKeywords(raw?: RawKeywords): { id: number; name: string }[] | undefined {
  const list = raw?.keywords ?? raw?.results;
  if (!list?.length) return undefined;
  return list.slice(0, 12).map((k) => ({ id: k.id, name: k.name }));
}

function extractWatchProviders(
  raw?: RawWatchProviders,
  region = "US",
): TmdbMedia["watchProviders"] {
  const r = raw?.results?.[region];
  if (!r) return undefined;
  const out: NonNullable<TmdbMedia["watchProviders"]> = [];
  const seen = new Set<number>();
  const add = (type: "stream" | "rent" | "buy", list?: { provider_id: number; provider_name: string; logo_path: string | null }[]) => {
    for (const p of list ?? []) {
      if (seen.has(p.provider_id)) continue;
      seen.add(p.provider_id);
      out.push({ type, name: p.provider_name, logoPath: p.logo_path });
    }
  };
  add("stream", r.flatrate);
  add("rent", r.rent);
  add("buy", r.buy);
  return out.length ? out : undefined;
}

function normalizeMovie(r: RawMovie): TmdbMedia {
  const media: TmdbMedia = {
    id: r.id, mediaType: "movie", title: r.title ?? "", overview: r.overview ?? "",
    posterPath: r.poster_path ?? null, backdropPath: r.backdrop_path ?? null,
    releaseDate: r.release_date ?? null,
    releaseYear: r.release_date?.slice(0, 4) ?? null,
    voteAverage: r.vote_average ?? 0,
    voteCount: r.vote_count ?? 0,
  };
  // These fields are only present on the single-title detail response, not on list/search items —
  // set them only when present so cached list payloads stay lean.
  if (r.genres?.length) {
    media.genres = r.genres.map((g) => g.name);
    media.genreList = r.genres.map((g) => ({ id: g.id, name: g.name }));
  }
  if (r.production_companies?.length) media.studios = r.production_companies.map((c) => c.name);
  if (r.tagline) media.tagline = r.tagline;
  if (r.status) media.status = r.status;
  if (r.runtime != null) media.runtime = r.runtime;
  if (r.original_title && r.original_title !== media.title) media.originalTitle = r.original_title;
  if (r.original_language) media.originalLanguage = r.original_language;
  if (r.spoken_languages?.length) {
    media.spokenLanguages = r.spoken_languages.map((l) => l.english_name || l.name || displayLanguage(l.iso_639_1));
  }
  if (r.production_countries?.length) {
    media.productionCountries = r.production_countries.map((c) => c.name || displayRegion(c.iso_3166_1));
  }
  if (r.homepage) media.homepage = r.homepage;
  if (r.budget) media.budget = r.budget;
  if (r.revenue) media.revenue = r.revenue;
  const kw = extractKeywords(r.keywords);
  if (kw) {
    media.keywords = kw.map((k) => k.name);
    media.keywordList = kw;
  }
  const wp = extractWatchProviders(r["watch/providers"]);
  if (wp) media.watchProviders = wp;
  return media;
}

function normalizeTV(r: RawTV): TmdbMedia {
  const media: TmdbMedia = {
    id: r.id, mediaType: "tv", title: r.name ?? "", overview: r.overview ?? "",
    posterPath: r.poster_path ?? null, backdropPath: r.backdrop_path ?? null,
    releaseDate: r.first_air_date ?? null,
    releaseYear: r.first_air_date?.slice(0, 4) ?? null,
    voteAverage: r.vote_average ?? 0,
    voteCount: r.vote_count ?? 0,
  };
  if (r.genres?.length) {
    media.genres = r.genres.map((g) => g.name);
    media.genreList = r.genres.map((g) => ({ id: g.id, name: g.name }));
  }
  const studios = (r.networks?.length ? r.networks : r.production_companies) ?? [];
  if (studios.length) media.studios = studios.map((c) => c.name);
  if (r.tagline) media.tagline = r.tagline;
  if (r.status) media.status = r.status;
  if (r.episode_run_time?.length) media.runtime = r.episode_run_time[0];
  if (r.number_of_seasons != null) media.numberOfSeasons = r.number_of_seasons;
  if (r.number_of_episodes != null) media.numberOfEpisodes = r.number_of_episodes;
  if (r.original_name && r.original_name !== media.title) media.originalTitle = r.original_name;
  if (r.original_language) media.originalLanguage = r.original_language;
  if (r.spoken_languages?.length) {
    media.spokenLanguages = r.spoken_languages.map((l) => l.english_name || l.name || displayLanguage(l.iso_639_1));
  }
  if (r.production_countries?.length) {
    media.productionCountries = r.production_countries.map((c) => c.name || displayRegion(c.iso_3166_1));
  } else if (r.origin_country?.length) {
    media.productionCountries = r.origin_country.map(displayRegion);
  }
  if (r.homepage) media.homepage = r.homepage;
  if (r.last_air_date) media.lastAirDate = r.last_air_date;
  if (r.in_production != null) media.inProduction = r.in_production;
  if (r.type) media.tvType = r.type;
  if (r.next_episode_to_air?.air_date) media.nextEpisodeAirDate = r.next_episode_to_air.air_date;
  const kw = extractKeywords(r.keywords);
  if (kw) {
    media.keywords = kw.map((k) => k.name);
    media.keywordList = kw;
  }
  const wp = extractWatchProviders(r["watch/providers"]);
  if (wp) media.watchProviders = wp;
  if (r.external_ids?.tvdb_id) media.tvdbId = r.external_ids.tvdb_id;
  return media;
}

export async function verifyTmdbMedia(
  tmdbId: number,
  mediaType: "movie" | "tv",
): Promise<{ title: string; posterPath: string | null; releaseYear: string } | null> {
  try {
    if (mediaType === "movie") {
      const r = await tmdbFetch<RawMovie>(`/movie/${tmdbId}`);
      if (!r.title || typeof r.title !== "string") return null;
      return { title: r.title, posterPath: r.poster_path ?? null, releaseYear: r.release_date?.slice(0, 4) ?? "" };
    }
    const r = await tmdbFetch<RawTV>(`/tv/${tmdbId}`);
    if (!r.name || typeof r.name !== "string") return null;
    return { title: r.name, posterPath: r.poster_path ?? null, releaseYear: r.first_air_date?.slice(0, 4) ?? "" };
  } catch {
    return null;
  }
}

function discoverKey(type: "movie" | "tv", filters: DiscoverFilters): string {
  return [
    `discover:${type}`,
    filters.sortBy ?? "popularity.desc",
    filters.genreId ?? "",
    filters.keywordId ?? "",
    filters.minRating ?? "",
    filters.minVoteCount ?? "",
    filters.fromYear ?? "",
    filters.toYear ?? "",
    filters.watchProvider ?? "",
    filters.watchRegion ?? "",
  ].join(":");
}

const PAGES = 5;
const BROWSE_PAGES = 20;
const UPCOMING_PAGES = 10;

export async function getTrending(): Promise<TmdbMedia[]> {
  const key = "trending:week";
  const cached = await getCache<TmdbMedia[]>(key);
  if (cached?.length) return cached;

  const pages = await Promise.allSettled(
    Array.from({ length: PAGES }, (_, i) =>
      tmdbFetch<PagedResponse<RawMovie & RawTV & { media_type: string }>>(
        "/trending/all/week", { page: String(i + 1) }, 86400
      )
    )
  );
  const seen = new Set<number>();
  const result = pages
    .flatMap((r) => (r.status === "fulfilled" ? r.value.results : []))
    .filter((r) => r.media_type === "movie" || r.media_type === "tv")
    .filter((r) => r.id != null && r.id > 0)
    .filter((r) => (seen.has(r.id) ? false : (seen.add(r.id), true)))
    .map((r) => r.media_type === "movie" ? normalizeMovie(r as RawMovie) : normalizeTV(r as RawTV));

  if (result.length > 0) await setCache(key, result, TTL.DISCOVER);
  syncTmdbMediaCore(result).catch((err) => console.error("[tmdb] TmdbMediaCore sync failed:", err));
  return result;
}

export async function getPopularMovies(): Promise<TmdbMedia[]> {
  const key = "movies:popular";
  const cached = await getCache<TmdbMedia[]>(key);
  if (cached?.length) return cached;

  const pages = await Promise.allSettled(
    Array.from({ length: BROWSE_PAGES }, (_, i) =>
      tmdbFetch<PagedResponse<RawMovie>>("/movie/popular", { page: String(i + 1) })
    )
  );
  const seen = new Set<number>();
  const result = pages
    .flatMap((r) => (r.status === "fulfilled" ? r.value.results : []))
    .filter((r) => r.id != null && r.id > 0)
    .filter((r) => (seen.has(r.id) ? false : (seen.add(r.id), true)))
    .map(normalizeMovie);

  if (result.length > 0) await setCache(key, result, TTL.DISCOVER);
  syncTmdbMediaCore(result).catch((err) => console.error("[tmdb] TmdbMediaCore sync failed:", err));
  return result;
}

export async function getPopularTV(): Promise<TmdbMedia[]> {
  const key = "tv:popular";
  const cached = await getCache<TmdbMedia[]>(key);
  if (cached?.length) return cached;

  const pages = await Promise.allSettled(
    Array.from({ length: BROWSE_PAGES }, (_, i) =>
      tmdbFetch<PagedResponse<RawTV>>("/tv/popular", { page: String(i + 1) })
    )
  );
  const seen = new Set<number>();
  const result = pages
    .flatMap((r) => (r.status === "fulfilled" ? r.value.results : []))
    .filter((r) => r.id != null && r.id > 0)
    .filter((r) => (seen.has(r.id) ? false : (seen.add(r.id), true)))
    .map(normalizeTV);

  if (result.length > 0) await setCache(key, result, TTL.DISCOVER);
  syncTmdbMediaCore(result).catch((err) => console.error("[tmdb] TmdbMediaCore sync failed:", err));
  return result;
}

export async function searchMulti(query: string): Promise<TmdbMedia[]> {
  const q = query.trim();
  if (!q) return [];
  const key = `search:${q.toLowerCase()}`;
  const cached = await getCache<TmdbMedia[]>(key);
  if (cached) return cached;
  const data = await tmdbFetch<PagedResponse<RawMovie & RawTV & { media_type: string }>>(
    "/search/multi", { query: q, include_adult: "false" }
  );
  const results = data.results
    .filter((r) => r.media_type === "movie" || r.media_type === "tv")
    .filter((r) => r.id != null && r.id > 0)
    .map((r) => r.media_type === "movie" ? normalizeMovie(r as RawMovie) : normalizeTV(r as RawTV));
  await setCache(key, results, TTL.SEARCH);
  return results;
}

export async function getUpcomingMovies(): Promise<TmdbMedia[]> {
  const pages = await Promise.allSettled(
    Array.from({ length: UPCOMING_PAGES }, (_, i) =>
      tmdbFetch<PagedResponse<RawMovie>>("/movie/upcoming", { page: String(i + 1) }, 86400)
    )
  );
  const seen = new Set<number>();
  return pages
    .flatMap((r) => (r.status === "fulfilled" ? r.value.results : []))
    .filter((r) => r.id != null && r.id > 0)
    .filter((r) => (seen.has(r.id) ? false : (seen.add(r.id), true)))
    .map(normalizeMovie);
}

export async function getOnTheAirTV(): Promise<TmdbMedia[]> {
  const pages = await Promise.allSettled(
    Array.from({ length: UPCOMING_PAGES }, (_, i) =>
      tmdbFetch<PagedResponse<RawTV>>("/tv/on_the_air", { page: String(i + 1) }, 86400)
    )
  );
  const seen = new Set<number>();
  return pages
    .flatMap((r) => (r.status === "fulfilled" ? r.value.results : []))
    .filter((r) => r.id != null && r.id > 0)
    .filter((r) => (seen.has(r.id) ? false : (seen.add(r.id), true)))
    .map(normalizeTV);
}

export async function getUpcomingTV(): Promise<TmdbMedia[]> {
  // /tv/on_the_air returns shows whose original first_air_date is often years past
  // (long-running shows currently airing new episodes). For "Upcoming" we want
  // shows premiering today or later, so we use /discover/tv with first_air_date.gte.
  const today = new Date().toISOString().slice(0, 10);
  const pages = await Promise.allSettled(
    Array.from({ length: UPCOMING_PAGES }, (_, i) =>
      tmdbFetch<PagedResponse<RawTV>>(
        "/discover/tv",
        {
          include_adult: "false",
          sort_by: "popularity.desc",
          "first_air_date.gte": today,
          page: String(i + 1),
        },
        86400,
      )
    )
  );
  const seen = new Set<number>();
  return pages
    .flatMap((r) => (r.status === "fulfilled" ? r.value.results : []))
    .filter((r) => r.id != null && r.id > 0)
    .filter((r) => r.first_air_date && r.first_air_date >= today)
    .filter((r) => (seen.has(r.id) ? false : (seen.add(r.id), true)))
    .map(normalizeTV);
}

// Detail cache rows written before keywords were split into `keywords` (names) +
// `keywordList` (objects) hold object-form `keywords` and no `keywordList`. Coerce
// them on read in the cached branch below so every consumer (web keyword chips,
// native detail/popular routes) sees the current shape — native clients decode
// `keywords` as [String]? and choke on objects. Returns true if it mutated `m`.
function migrateKeywordShape(m: TmdbMedia): boolean {
  const kw: unknown = m.keywords;
  if (!Array.isArray(kw) || kw.length === 0) return false;
  if (typeof kw[0] !== "object" || kw[0] === null) return false;
  const objs = kw as { id: number; name: string }[];
  m.keywordList = objs.map((k) => ({ id: k.id, name: k.name }));
  m.keywords = objs.map((k) => k.name);
  return true;
}

export async function getMovieDetails(id: number): Promise<TmdbMedia> {
  const key = `movie:${id}:details`;
  return coalesce(key, async () => {
  const cached = await getCache<TmdbMedia>(key);

  if (cached) {
    let needsWrite = migrateKeywordShape(cached);
    if (cached.imdbRating === undefined || cached.rtAudienceScore === undefined) {
      const r = await fetchUnifiedRatings(id, "movie", cached.releaseDate);
      if (r.found && r.data) {
        Object.assign(cached, r.data);
        needsWrite = true;
      } else if (r.keyConfigured) {
        cached.imdbRating = null;
        cached.rtAudienceScore = null;
        cached.traktRating = null;
        needsWrite = true;
      }
    }
    if (needsWrite) await setCache(key, cached, TTL.DETAILS);
    return cached;
  }

  const [r, ratings] = await Promise.all([
    tmdbFetch<RawMovie>(`/movie/${id}`, { append_to_response: "release_dates,videos,credits,recommendations,similar,keywords,watch/providers,external_ids" }),
    fetchUnifiedRatings(id, "movie"),
  ]);

  const media = normalizeMovie(r);
  const usEntry = r.release_dates?.results.find((x) => x.iso_3166_1 === "US");
  const cert = usEntry?.release_dates.find((d) => d.certification)?.certification;
  if (cert) media.certification = cert;
  media.trailerKey = extractTrailerKey(r.videos);
  if (r.belongs_to_collection) {
    media.collectionId = r.belongs_to_collection.id;
    media.collectionName = r.belongs_to_collection.name;
  }
  if (ratings.found && ratings.data) {
    Object.assign(media, ratings.data);
  } else if (ratings.keyConfigured) {
    media.imdbRating = null;
    media.rtAudienceScore = null;
    media.traktRating = null;
  }

  if (r.credits?.cast) {
    const credits = r.credits.cast.slice(0, 12).map((c) => ({
      id: c.id, name: c.name, character: c.character, profilePath: c.profile_path,
    }));
    setCache(`movie:${id}:credits`, credits, TTL.DETAILS).catch(() => {});
  }
  if (r.recommendations || r.similar) {
    const seen = new Set<number>([id]);
    const suggestions: TmdbMedia[] = [];
    for (const page of [r.similar, r.recommendations]) {
      if (!page) continue;
      for (const item of page.results) {
        if (item.id == null || item.id <= 0 || seen.has(item.id) || !item.poster_path) continue;
        seen.add(item.id);
        suggestions.push(normalizeMovie(item));
      }
    }
    setCache(`movie:${id}:suggestions`, suggestions.slice(0, 18), TTL.DETAILS).catch(() => {});
  }

  await setCache(key, media, TTL.DETAILS);
  upsertTmdbMediaCore(media).catch((err) => console.error("[tmdb] TmdbMediaCore upsert failed:", err));
  return media;
  });
}

export async function getTVDetails(id: number): Promise<TmdbMedia> {
  const key = `tv:${id}:details`;
  return coalesce(key, async () => {
  const cached = await getCache<TmdbMedia>(key);

  if (cached) {
    // A cached TV entry without a seasons field is from before the schema added seasons; bust it
    // so the next request fetches a fresh response that includes seasons.
    if (cached.seasons === undefined) {
      prisma.tmdbCache.delete({ where: { key } }).catch(() => {});
    } else {
      let needsWrite = migrateKeywordShape(cached);
      if (cached.imdbRating === undefined || cached.rtAudienceScore === undefined) {
        const r = await fetchUnifiedRatings(id, "tv", cached.releaseDate);
        if (r.found && r.data) {
          Object.assign(cached, r.data);
          needsWrite = true;
        } else if (r.keyConfigured) {
          cached.imdbRating = null;
          cached.rtAudienceScore = null;
          cached.traktRating = null;
          needsWrite = true;
        }
      }
      if (needsWrite) await setCache(key, cached, TTL.DETAILS);
      return cached;
    }
  }

  const [r, ratings] = await Promise.all([
    tmdbFetch<RawTV>(`/tv/${id}`, { append_to_response: "content_ratings,videos,credits,recommendations,similar,seasons,keywords,watch/providers,external_ids" }),
    fetchUnifiedRatings(id, "tv"),
  ]);

  const media = normalizeTV(r);
  const usEntry = r.content_ratings?.results.find((x) => x.iso_3166_1 === "US");
  if (usEntry?.rating) media.certification = usEntry.rating;
  media.trailerKey = extractTrailerKey(r.videos);
  // Season 0 is the specials season; skip it and any placeholder seasons with no episodes
  media.seasons = (r.seasons ?? [])
    .filter((s) => s.season_number > 0 && s.episode_count > 0)
    .map((s) => ({
      seasonNumber: s.season_number,
      episodeCount: s.episode_count,
      airDate: s.air_date ?? null,
      posterPath: s.poster_path ?? null,
      name: s.name ?? `Season ${s.season_number}`,
      overview: s.overview ?? "",
    }));
  if (ratings.found && ratings.data) {
    Object.assign(media, ratings.data);
  } else if (ratings.keyConfigured) {
    media.imdbRating = null;
    media.rtAudienceScore = null;
    media.traktRating = null;
  }

  if (r.credits?.cast) {
    const credits = r.credits.cast.slice(0, 12).map((c) => ({
      id: c.id, name: c.name, character: c.character, profilePath: c.profile_path,
    }));
    setCache(`tv:${id}:credits`, credits, TTL.DETAILS).catch(() => {});
  }
  if (r.recommendations || r.similar) {
    const seen = new Set<number>([id]);
    const suggestions: TmdbMedia[] = [];
    for (const page of [r.similar, r.recommendations]) {
      if (!page) continue;
      for (const item of page.results) {
        if (item.id == null || item.id <= 0 || seen.has(item.id) || !item.poster_path) continue;
        seen.add(item.id);
        suggestions.push(normalizeTV(item));
      }
    }
    setCache(`tv:${id}:suggestions`, suggestions.slice(0, 18), TTL.DETAILS).catch(() => {});
  }

  await setCache(key, media, TTL.DETAILS);
  upsertTmdbMediaCore(media).catch((err) => console.error("[tmdb] TmdbMediaCore upsert failed:", err));
  return media;
  });
}

export async function getMovieCredits(id: number): Promise<CastMember[]> {
  const key = `movie:${id}:credits`;
  const cached = await getCache<CastMember[]>(key);
  if (cached) return cached;

  const r = await tmdbFetch<{ cast: { id: number; name: string; character: string; profile_path: string | null; order: number }[] }>(`/movie/${id}/credits`);
  const result = (r.cast ?? []).slice(0, 12).map((c) => ({
    id: c.id, name: c.name, character: c.character, profilePath: c.profile_path,
  }));

  await setCache(key, result, TTL.DETAILS);
  return result;
}

export async function getTVCredits(id: number): Promise<CastMember[]> {
  const key = `tv:${id}:credits`;
  const cached = await getCache<CastMember[]>(key);
  if (cached) return cached;

  const r = await tmdbFetch<{ cast: { id: number; name: string; character: string; profile_path: string | null; order: number }[] }>(`/tv/${id}/credits`);
  const result = (r.cast ?? []).slice(0, 12).map((c) => ({
    id: c.id, name: c.name, character: c.character, profilePath: c.profile_path,
  }));

  await setCache(key, result, TTL.DETAILS);
  return result;
}

export async function getTVSeasonEpisodes(
  tmdbId: number,
  seasonNumber: number,
): Promise<TmdbEpisode[]> {
  const key = `tv:${tmdbId}:season:${seasonNumber}`;
  const cached = await getCache<TmdbEpisode[]>(key);
  if (cached) return cached;

  const r = await tmdbFetch<{ episodes?: RawEpisode[] }>(`/tv/${tmdbId}/season/${seasonNumber}`);
  const episodes: TmdbEpisode[] = (r.episodes ?? []).map((e) => ({
    episodeNumber: e.episode_number,
    seasonNumber: e.season_number,
    name: e.name ?? `Episode ${e.episode_number}`,
    overview: e.overview ?? "",
    airDate: e.air_date ?? null,
    stillPath: e.still_path ?? null,
    runtime: e.runtime ?? null,
    voteAverage: e.vote_average ?? 0,
  }));

  await setCache(key, episodes, TTL.DETAILS);
  return episodes;
}

export async function getPersonDetails(id: number): Promise<PersonDetails> {
  const key = `person:${id}`;
  const cached = await getCache<PersonDetails>(key);
  if (cached) return cached;

  const r = await tmdbFetch<{
    id: number; name: string; profile_path: string | null; known_for_department: string;
    combined_credits: {
      cast: {
        id: number; media_type: string; title?: string; name?: string;
        poster_path: string | null; release_date?: string; first_air_date?: string;
        vote_average: number; character: string; vote_count: number;
      }[];
    };
  }>(`/person/${id}`, { append_to_response: "combined_credits" });

  const credits: PersonCredit[] = r.combined_credits.cast
    .filter((c) => (c.media_type === "movie" || c.media_type === "tv") && c.poster_path && c.vote_count > 10)
    .sort((a, b) => {
      const aDate = a.release_date ?? a.first_air_date ?? "";
      const bDate = b.release_date ?? b.first_air_date ?? "";
      return bDate.localeCompare(aDate);
    })
    .slice(0, 20)
    .map((c) => ({
      id: c.id, mediaType: c.media_type as MediaType,
      title: c.title ?? c.name ?? "",
      posterPath: c.poster_path,
      releaseYear: (c.release_date ?? c.first_air_date ?? "").slice(0, 4),
      character: c.character, voteAverage: c.vote_average,
    }));

  const result: PersonDetails = {
    id: r.id, name: r.name, profilePath: r.profile_path,
    knownForDepartment: r.known_for_department, credits,
  };

  await setCache(key, result, TTL.PERSON);
  return result;
}

export async function getMovieGenres(): Promise<Genre[]> {
  const key = "genres:movie";
  const cached = await getCache<Genre[]>(key);
  if (cached) return cached;

  const r = await tmdbFetch<{ genres: Genre[] }>("/genre/movie/list", {}, 86400);
  await setCache(key, r.genres, TTL.GENRES);
  return r.genres;
}

export async function getTVGenres(): Promise<Genre[]> {
  const key = "genres:tv";
  const cached = await getCache<Genre[]>(key);
  if (cached) return cached;

  const r = await tmdbFetch<{ genres: Genre[] }>("/genre/tv/list", {}, 86400);
  await setCache(key, r.genres, TTL.GENRES);
  return r.genres;
}

export async function getWatchProviders(type: "movie" | "tv", region = "US"): Promise<WatchProvider[]> {
  const key = `watchproviders:${type}:${region}`;
  const cached = await getCache<WatchProvider[]>(key);
  if (cached) return cached;

  const r = await tmdbFetch<{ results: WatchProvider[] }>(
    `/watch/providers/${type}`,
    { watch_region: region },
    86400,
  );
  const providers = r.results
    .filter((p) => p.logo_path)
    .sort((a, b) => a.provider_name.localeCompare(b.provider_name));

  await setCache(key, providers, TTL.GENRES);
  return providers;
}

const TOP_PAGES = 20;

const TOP_MIN_VOTES_MOVIE = 200;
const TOP_MIN_VOTES_TV = 100;

export async function getTopRatedMovies(): Promise<TmdbMedia[]> {
  const key = "movies:top_rated";
  const cached = await getCache<TmdbMedia[]>(key);
  if (cached?.length) return cached;

  const pages = await Promise.allSettled(
    Array.from({ length: TOP_PAGES }, (_, i) =>
      tmdbFetch<PagedResponse<RawMovie>>("/movie/top_rated", { page: String(i + 1) })
    )
  );
  const seen = new Set<number>();
  const result = pages
    .flatMap((r) => (r.status === "fulfilled" ? r.value.results : []))
    .filter((r) => r.id != null && r.id > 0)
    .filter((r) => (seen.has(r.id) ? false : (seen.add(r.id), true)))
    .filter((r) => r.vote_count >= TOP_MIN_VOTES_MOVIE)
    .map(normalizeMovie);

  if (result.length > 0) await setCache(key, result, TTL.DISCOVER);
  syncTmdbMediaCore(result).catch((err) => console.error("[tmdb] TmdbMediaCore sync failed:", err));
  return result;
}

export async function getTopRatedTV(): Promise<TmdbMedia[]> {
  const key = "tv:top_rated";
  const cached = await getCache<TmdbMedia[]>(key);
  if (cached?.length) return cached;

  const pages = await Promise.allSettled(
    Array.from({ length: TOP_PAGES }, (_, i) =>
      tmdbFetch<PagedResponse<RawTV>>("/tv/top_rated", { page: String(i + 1) })
    )
  );
  const seen = new Set<number>();
  const result = pages
    .flatMap((r) => (r.status === "fulfilled" ? r.value.results : []))
    .filter((r) => r.id != null && r.id > 0)
    .filter((r) => (seen.has(r.id) ? false : (seen.add(r.id), true)))
    .filter((r) => r.vote_count >= TOP_MIN_VOTES_TV)
    .map(normalizeTV);

  if (result.length > 0) await setCache(key, result, TTL.DISCOVER);
  syncTmdbMediaCore(result).catch((err) => console.error("[tmdb] TmdbMediaCore sync failed:", err));
  return result;
}

export async function getMovieSuggestions(id: number): Promise<TmdbMedia[]> {
  const key = `movie:${id}:suggestions`;
  const cached = await getCache<TmdbMedia[]>(key);
  if (cached) return cached;

  const [similar, recommended] = await Promise.allSettled([
    tmdbFetch<PagedResponse<RawMovie>>(`/movie/${id}/similar`),
    tmdbFetch<PagedResponse<RawMovie>>(`/movie/${id}/recommendations`),
  ]);
  const seen = new Set<number>([id]);
  const result: TmdbMedia[] = [];
  for (const r of [similar, recommended]) {
    if (r.status !== "fulfilled") continue;
    for (const item of r.value.results) {
      if (item.id == null || item.id <= 0 || seen.has(item.id) || !item.poster_path) continue;
      seen.add(item.id);
      result.push(normalizeMovie(item));
    }
  }
  const trimmed = result.slice(0, 18);
  await setCache(key, trimmed, TTL.DETAILS);
  return trimmed;
}

export async function getTVSuggestions(id: number): Promise<TmdbMedia[]> {
  const key = `tv:${id}:suggestions`;
  const cached = await getCache<TmdbMedia[]>(key);
  if (cached) return cached;

  const [similar, recommended] = await Promise.allSettled([
    tmdbFetch<PagedResponse<RawTV>>(`/tv/${id}/similar`),
    tmdbFetch<PagedResponse<RawTV>>(`/tv/${id}/recommendations`),
  ]);
  const seen = new Set<number>([id]);
  const result: TmdbMedia[] = [];
  for (const r of [similar, recommended]) {
    if (r.status !== "fulfilled") continue;
    for (const item of r.value.results) {
      if (item.id == null || item.id <= 0 || seen.has(item.id) || !item.poster_path) continue;
      seen.add(item.id);
      result.push(normalizeTV(item));
    }
  }
  const trimmed = result.slice(0, 18);
  await setCache(key, trimmed, TTL.DETAILS);
  return trimmed;
}

export async function getMovieCollection(collectionId: number): Promise<TmdbMedia[]> {
  const key = `collection:${collectionId}`;
  const cached = await getCache<TmdbMedia[]>(key);
  if (cached) return cached;

  const r = await tmdbFetch<{ id: number; parts: RawMovie[] }>(`/collection/${collectionId}`);
  const result = r.parts
    .filter((p) => p.id != null && p.id > 0 && p.poster_path)
    .sort((a, b) => (a.release_date ?? "").localeCompare(b.release_date ?? ""))
    .map(normalizeMovie);

  await setCache(key, result, TTL.DETAILS);
  return result;
}

export interface PagedResult {
  items: TmdbMedia[];
  totalPages: number;
}

export async function getPopularMoviesPage(page: number): Promise<PagedResult> {
  const p = Math.max(1, page);
  const key = `movies:popular:page:${p}`;
  const cached = await getCache<PagedResult>(key);
  if (cached) return cached;

  const r = await tmdbFetch<PagedResponse<RawMovie>>("/movie/popular", { page: String(p) });
  const result: PagedResult = {
    items: r.results.filter((item) => item.id != null && item.id > 0).map(normalizeMovie),
    totalPages: Math.min(r.total_pages, 500),
  };
  await setCache(key, result, TTL.DISCOVER);
  syncTmdbMediaCore(result.items).catch((err) => console.error("[tmdb] TmdbMediaCore sync failed:", err));
  return result;
}

export async function getPopularTVPage(page: number): Promise<PagedResult> {
  const p = Math.max(1, page);
  const key = `tv:popular:page:${p}`;
  const cached = await getCache<PagedResult>(key);
  if (cached) return cached;

  const r = await tmdbFetch<PagedResponse<RawTV>>("/tv/popular", { page: String(p) });
  const result: PagedResult = {
    items: r.results.filter((item) => item.id != null && item.id > 0).map(normalizeTV),
    totalPages: Math.min(r.total_pages, 500),
  };
  await setCache(key, result, TTL.DISCOVER);
  syncTmdbMediaCore(result.items).catch((err) => console.error("[tmdb] TmdbMediaCore sync failed:", err));
  return result;
}

// Allowlist TMDB sort_by values — an arbitrary sortBy would otherwise reach TMDB
// (400 → propagated 500) AND be baked into the discoverKey() cache key, letting
// any authenticated user manufacture junk TmdbCache entries. Union of the movie +
// TV sort fields TMDB accepts.
const ALLOWED_DISCOVER_SORT = new Set([
  "popularity.desc", "popularity.asc",
  "vote_average.desc", "vote_average.asc",
  "primary_release_date.desc", "primary_release_date.asc",
  // The web filter-bar sends release_date.* for Newest/Oldest (iOS sends
  // primary_release_date.*); both are valid TMDB discover sorts — keep both.
  "release_date.desc", "release_date.asc",
  "first_air_date.desc", "first_air_date.asc",
  "revenue.desc", "revenue.asc",
  "original_title.desc", "original_title.asc",
  "vote_count.desc", "vote_count.asc",
]);
function allowedDiscoverSort(sortBy: string | undefined): string {
  return sortBy && ALLOWED_DISCOVER_SORT.has(sortBy) ? sortBy : "popularity.desc";
}

export async function discoverMoviesPage(filters: DiscoverFilters, page: number): Promise<PagedResult> {
  const p = Math.max(1, page);
  // Sanitize sortBy up front so a junk value reaches neither TMDB nor the cache key.
  filters = { ...filters, sortBy: allowedDiscoverSort(filters.sortBy) };
  const key = `${discoverKey("movie", filters)}:page:${p}`;
  const cached = await getCache<PagedResult>(key);
  if (cached) return cached;

  let fromYear = filters.fromYear ? parseInt(filters.fromYear, 10) : undefined;
  let toYear = filters.toYear ? parseInt(filters.toYear, 10) : undefined;
  let minRating = filters.minRating ? parseFloat(filters.minRating) : undefined;
  const watchProvider = filters.watchProvider && /^[\d|]+$/.test(filters.watchProvider) ? filters.watchProvider : undefined;
  if (fromYear !== undefined && (isNaN(fromYear) || fromYear < 1888 || fromYear > 2100)) fromYear = undefined;
  if (toYear !== undefined && (isNaN(toYear) || toYear < 1888 || toYear > 2100)) toYear = undefined;
  if (minRating !== undefined) {
    if (isNaN(minRating)) minRating = undefined;
    else minRating = Math.min(10, Math.max(0, minRating));
  }

  const params: Record<string, string> = {
    include_adult: "false",
    sort_by: filters.sortBy ?? "popularity.desc", // already allowlisted at entry
    page: String(p),
  };
  if (filters.genreId)         params["with_genres"] = filters.genreId;
  if (filters.keywordId && /^[\d|,]+$/.test(filters.keywordId)) params["with_keywords"] = filters.keywordId;
  if (minRating !== undefined)  params["vote_average.gte"] = String(minRating);
  if (filters.minVoteCount)    params["vote_count.gte"] = filters.minVoteCount;
  if (fromYear !== undefined)   params["primary_release_date.gte"] = `${fromYear}-01-01`;
  if (toYear !== undefined)     params["primary_release_date.lte"] = `${toYear}-12-31`;
  if (watchProvider) { params["with_watch_providers"] = watchProvider; params["watch_region"] = filters.watchRegion ?? "US"; }

  const r = await tmdbFetch<PagedResponse<RawMovie>>("/discover/movie", params);
  const result: PagedResult = {
    items: r.results.filter((item) => item.id != null && item.id > 0).map(normalizeMovie),
    totalPages: Math.min(r.total_pages, 500),
  };
  await setCache(key, result, TTL.DISCOVER);
  syncTmdbMediaCore(result.items).catch((err) => console.error("[tmdb] TmdbMediaCore sync failed:", err));
  return result;
}

export async function discoverTVPage(filters: DiscoverFilters, page: number): Promise<PagedResult> {
  const p = Math.max(1, page);
  // Sanitize sortBy up front so a junk value reaches neither TMDB nor the cache key.
  filters = { ...filters, sortBy: allowedDiscoverSort(filters.sortBy) };
  const key = `${discoverKey("tv", filters)}:page:${p}`;
  const cached = await getCache<PagedResult>(key);
  if (cached) return cached;

  let fromYear = filters.fromYear ? parseInt(filters.fromYear, 10) : undefined;
  let toYear = filters.toYear ? parseInt(filters.toYear, 10) : undefined;
  let minRating = filters.minRating ? parseFloat(filters.minRating) : undefined;
  const watchProvider = filters.watchProvider && /^[\d|]+$/.test(filters.watchProvider) ? filters.watchProvider : undefined;
  if (fromYear !== undefined && (isNaN(fromYear) || fromYear < 1888 || fromYear > 2100)) fromYear = undefined;
  if (toYear !== undefined && (isNaN(toYear) || toYear < 1888 || toYear > 2100)) toYear = undefined;
  if (minRating !== undefined) {
    if (isNaN(minRating)) minRating = undefined;
    else minRating = Math.min(10, Math.max(0, minRating));
  }

  const params: Record<string, string> = {
    include_adult: "false",
    sort_by: filters.sortBy ?? "popularity.desc", // already allowlisted at entry
    page: String(p),
  };
  if (filters.genreId)         params["with_genres"] = filters.genreId;
  if (filters.keywordId && /^[\d|,]+$/.test(filters.keywordId)) params["with_keywords"] = filters.keywordId;
  if (minRating !== undefined)  params["vote_average.gte"] = String(minRating);
  if (filters.minVoteCount)    params["vote_count.gte"] = filters.minVoteCount;
  if (fromYear !== undefined)   params["first_air_date.gte"] = `${fromYear}-01-01`;
  if (toYear !== undefined)     params["first_air_date.lte"] = `${toYear}-12-31`;
  if (watchProvider) { params["with_watch_providers"] = watchProvider; params["watch_region"] = filters.watchRegion ?? "US"; }

  const r = await tmdbFetch<PagedResponse<RawTV>>("/discover/tv", params);
  const result: PagedResult = {
    items: r.results.filter((item) => item.id != null && item.id > 0).map(normalizeTV),
    totalPages: Math.min(r.total_pages, 500),
  };
  await setCache(key, result, TTL.DISCOVER);
  syncTmdbMediaCore(result.items).catch((err) => console.error("[tmdb] TmdbMediaCore sync failed:", err));
  return result;
}
