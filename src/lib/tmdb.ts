import "server-only";
import { prisma } from "./prisma";
import { getCache, getCacheEntry, setCache, setCacheUntil, tmdbDetailsKey, TTL } from "./tmdb-cache";
import { safeFetchTrusted, SafeFetchError } from "./safe-fetch";
// coalesce: concurrent callers for the same list/detail key share one upstream
// fetch rather than hammering TMDB and writing the same cache row N times.
import { settleLimit, coalesce } from "./concurrency";
import { forgetWarnOnChange, warnOnChange } from "./log-dedup";
import { processSingleton } from "./process-singleton";
import { sanitizeForLog } from "./sanitize";
import { upstreamFailed, upstreamMissing, upstreamOk, valueOr, type UpstreamResult } from "./upstream-result";
import { syncTmdbMediaCore, upsertTmdbMediaCore } from "./tmdb-core-sync";
import { fetchUnifiedRatings, type UnifiedRatingsResult } from "./omdb-availability";
import type { MdblistRatings } from "./mdblist";
import { tmdbAuth } from "./tmdb-auth";
import type { Locale } from "./i18n/locales";
import type {
  TmdbMedia, MediaType, CastMember, PersonDetails, PersonCredit,
  Genre, DiscoverFilters, WatchProvider, TmdbSeason, TmdbEpisode,
} from "./tmdb-types";
// languageName / regionName are the ONE ISO-code → display-name helpers (the
// detail pages use the same exports, in the viewer's locale). Don't add a private copy here.
import { languageName, regionName } from "./tmdb-types";
import { extractHomeReleaseDates } from "./home-release-dates";
import { buildStudioList, isCertificationCap } from "./studio-list";
import { upcomingCutoffDate } from "./format-release-date";

// Merge a unified ratings payload (fetchUnifiedRatings) onto a media object.
// `trailerUrl` must never displace an already-extracted TMDB YouTube trailerKey
// (mirrors applyMdblist's guard in omdb-availability.ts) — the fresh-fetch paths
// set trailerKey before this runs, and cached rows already carry theirs. Nor may
// a ratings source with no IMDb id erase the one TMDB's external_ids supplied.
function assignUnifiedRatings(media: TmdbMedia, data: MdblistRatings): void {
  const { trailerUrl, imdbId, ...rest } = data;
  Object.assign(media, rest);
  if (imdbId != null || media.imdbId == null) media.imdbId = imdbId;
  if (!media.trailerKey) media.trailerUrl = trailerUrl;
}

// Authoritative "a configured source says this title has NO ratings": pin EVERY
// unified field to null so absent (never fetched) stays distinguishable from
// none (fetched, empty) — the tri-state the debug ratings-state endpoint
// documents. Pinning only the lazy-upgrade trigger fields left imdbVotes/
// rottenTomatoes/metacritic/releasedDigital/imdbId undefined, which read as
// "never fetched" downstream. imdbId pins softly (?? null) — a row may carry a
// real id from the prewarm or a prior ratings hit, and this verdict is about
// ratings, not identity. trailerUrl is deliberately untouched (trailerKey guard).
function pinAuthoritativeNoRatings(media: TmdbMedia): void {
  media.imdbRating = null;
  media.imdbVotes = null;
  media.rottenTomatoes = null;
  media.metacritic = null;
  media.rtAudienceScore = null;
  media.traktRating = null;
  media.mdblistScore = null;
  media.letterboxdRating = null;
  media.malRating = null;
  media.rogerEbertRating = null;
  media.releasedDigital = null;
  media.imdbId = media.imdbId ?? null;
}

export type {
  TmdbMedia, MediaType, CastMember, PersonDetails, PersonCredit,
  Genre, DiscoverFilters, WatchProvider, TmdbSeason, TmdbEpisode,
};
export { posterUrl, backdropUrl, stillUrl } from "./tmdb-types";

const BASE_URL = "https://api.themoviedb.org/3";

// A dropped connection, as the transport really reports it: safe-fetch wraps
// every transport failure in SafeFetchError("network") and keeps the cause's
// text in the message — node:http's ECONNRESET / "socket hang up", undici's
// "other side closed" / UND_ERR_SOCKET, and "terminated" for a body torn
// mid-read. A plain "fetch failed" (DNS, refused connection) is not one.
const CONNECTION_DROPPED = /ECONNRESET|EPIPE|socket hang up|UND_ERR_SOCKET|other side closed|terminated/i;
// Gateway answers in front of TMDB: transient by nature. 500 is not retried
// (TMDB's own error), and no other 4xx than 429 ever is.
const RETRY_STATUSES = new Set([502, 503, 504]);
const RETRY_BACKOFF_MS = 250;

/**
 * TMDB answered with a non-2xx status (after tmdbFetch's retries). Callers
 * read the status through isTmdbNotFound — the detail pages map a 404 to
 * notFound() (tests/detail-page-invariants.test.mts).
 */
export class TmdbHttpError extends Error {
  status: number;
  constructor(path: string, status: number) {
    super(`TMDB ${path} failed: ${status}`);
    this.name = "TmdbHttpError";
    this.status = status;
  }
}

/** Whether a thrown tmdbFetch error is TMDB answering 404 (the title or person doesn't exist). */
export function isTmdbNotFound(err: unknown): boolean {
  // By name and status, never instanceof: Turbopack copies this module into
  // every server chunk, so a class check can fail across chunks (guardrail 23b's
  // reasoning, for Prisma's errors).
  return err instanceof Error && err.name === "TmdbHttpError" && (err as { status?: unknown }).status === 404;
}

// A failure's cause without the path (which names the title), so a log line
// keyed on it repeats once per cause rather than once per title.
function tmdbFailureReason(err: unknown): string {
  if (err instanceof Error && err.name === "TmdbHttpError") return `HTTP ${(err as TmdbHttpError).status}`;
  if (err instanceof SafeFetchError) return err.reason;
  return err instanceof Error ? err.message : String(err);
}

// A transport failure worth another attempt: a dropped connection (up to the
// loop's two retries), or a timeout once — a second 15s wait is the most a page
// render should pay for one TMDB call.
function retriableTransportError(err: unknown, attempt: number): boolean {
  if (!(err instanceof SafeFetchError)) return false;
  if (err.reason === "network") return CONNECTION_DROPPED.test(err.message);
  return err.reason === "timeout" && attempt === 0;
}

// The response is only checked to be a JSON object: the Raw* shapes below mark
// as optional every field TMDB can leave out, and each reader defaults what it
// uses (an array check, a finite number), so a field TMDB dropped degrades to
// "absent" instead of throwing or reaching a cache.
async function tmdbFetch<T>(path: string, params?: Record<string, string>): Promise<T> {
  const auth = tmdbAuth();
  if (!auth) {
    throw new Error("No TMDB credentials configured (set TMDB_READ_TOKEN)");
  }
  const url = new URL(`${BASE_URL}${path}`);
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
        // TmdbCache is the app's ONE caching layer for TMDB payloads. An explicit
        // revalidate here also enrolled every call in Next's server-side Data
        // Cache (patch-fetch caches request-scope fetches with explicit cache
        // config despite force-dynamic), whose longer TTLs served refreshes from
        // a shadow cache and silently doubled the effective TmdbCache TTLs.
        next: { revalidate: 0 },
      });
      // TMDB throttling (~50 req/s budget) is transient — honor Retry-After
      // (capped) and retry rather than failing the page: a rejected page trips
      // the all-fulfilled gates below into serving-but-not-caching, which costs
      // a full re-fan-out on every cold caller until a clean pass.
      if (res.status === 429 && attempt < 2) {
        res.body?.cancel().catch(() => {});
        const ra = Number(res.headers.get("retry-after"));
        const waitMs = Math.min(Number.isFinite(ra) && ra > 0 ? ra * 1000 : 1000, 5000);
        await new Promise((r) => setTimeout(r, waitMs));
        lastErr = new TmdbHttpError(path, 429);
        continue;
      }
      if (RETRY_STATUSES.has(res.status) && attempt < 2) {
        res.body?.cancel().catch(() => {});
        lastErr = new TmdbHttpError(path, res.status);
        await new Promise((r) => setTimeout(r, RETRY_BACKOFF_MS * (attempt + 1)));
        continue;
      }
      if (!res.ok) {
        res.body?.cancel().catch(() => {});
        throw new TmdbHttpError(path, res.status);
      }
      const data: unknown = await res.json();

      if (data == null || typeof data !== "object") {
        throw new Error(`TMDB ${path} returned invalid response: ${typeof data}`);
      }
      return data as T;
    } catch (err) {
      // A body read that fails mid-stream lands here too (res.json()).
      if (retriableTransportError(err, attempt) && attempt < 2) {
        lastErr = err;
        await new Promise((r) => setTimeout(r, RETRY_BACKOFF_MS * (attempt + 1)));
        continue;
      }
      throw err;
    }
  }
  // Unreachable (the last attempt returns or throws), but the return type needs it.
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

// Every field TMDB can leave out is optional, and the normalizers default it.
interface RawMovie {
  id: number;
  title?: string;
  original_title?: string;
  overview?: string;
  poster_path?: string | null;
  backdrop_path?: string | null;
  release_date?: string;
  vote_average?: number;
  vote_count?: number;
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
    results: { iso_3166_1: string; release_dates: { certification: string; type: number; release_date?: string }[] }[];
  };
  videos?: RawVideos;
  belongs_to_collection?: { id: number; name: string } | null;
  credits?: { cast: RawCastMember[] };
  recommendations?: { results?: RawMovie[] };
  similar?: { results?: RawMovie[] };
  keywords?: RawKeywords;
  "watch/providers"?: RawWatchProviders;
  external_ids?: { imdb_id?: string | null; tvdb_id?: number | null };
  // Movie details carry the IMDb id at the top level too, and origin_country
  // beside production_countries.
  imdb_id?: string | null;
  origin_country?: string[];
}

interface RawTV {
  id: number;
  name?: string;
  original_name?: string;
  overview?: string;
  poster_path?: string | null;
  backdrop_path?: string | null;
  first_air_date?: string;
  last_air_date?: string | null;
  vote_average?: number;
  vote_count?: number;
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
  next_episode_to_air?: {
    air_date?: string | null;
    season_number?: number | null;
    episode_number?: number | null;
    name?: string | null;
  } | null;
  content_ratings?: {
    results: { iso_3166_1: string; rating: string }[];
  };
  videos?: RawVideos;
  credits?: { cast: RawCastMember[] };
  recommendations?: { results?: RawTV[] };
  similar?: { results?: RawTV[] };
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
  if (!videos?.results?.length) return null;
  const trailers = videos.results.filter((v) => v.site === "YouTube" && v.type === "Trailer");
  const teasers  = videos.results.filter((v) => v.site === "YouTube" && v.type === "Teaser");
  const official = trailers.find((v) => v.official) ?? trailers[0] ?? teasers.find((v) => v.official) ?? teasers[0];
  return official?.key ?? null;
}

// `results` and the counts are optional to match reality: a 200 can come back
// without them, and every reader must degrade to an empty page rather than throw.
interface PagedResponse<T> {
  results?: T[];
  total_pages?: number;
  total_results?: number;
}

// A page list's page count for the pagination UIs, capped at TMDB's own depth
// (500). A missing or non-numeric total_pages (Math.min would make it NaN)
// reads as "at least the page just served".
const MAX_TMDB_PAGE = 500;
function totalPagesOf(raw: unknown, page: number): number {
  return typeof raw === "number" && Number.isFinite(raw) && raw >= 0 ? Math.min(Math.floor(raw), MAX_TMDB_PAGE) : page;
}

// Best-effort ISO-code → English display name (stored in the cache; the detail
// pages localize through localizedProductionCountry, from `productionCountryCodes`).
function displayRegion(code: string): string {
  return regionName(code) ?? code;
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

// TMDB sends "" for an undated title; the contract is `string | null`.
function dateOrNull(date: string | null | undefined): string | null {
  return date || null;
}

// The base fields every list item and detail response carries.
function baseMedia(r: RawMovie | RawTV, mediaType: "movie" | "tv", title: string | undefined, date: string | undefined): TmdbMedia {
  return {
    id: r.id, mediaType, title: title ?? "", overview: r.overview ?? "",
    posterPath: r.poster_path ?? null, backdropPath: r.backdrop_path ?? null,
    releaseDate: dateOrNull(date),
    releaseYear: date ? date.slice(0, 4) : null,
    voteAverage: r.vote_average ?? 0,
    voteCount: r.vote_count ?? 0,
  };
}

// The detail-only fields movies and TV share, in the order the blobs have always
// carried them. Each is set only when present, so cached list payloads stay lean.
function applyGenres(media: TmdbMedia, r: RawMovie | RawTV): void {
  if (r.genres?.length) {
    media.genres = r.genres.map((g) => g.name);
    media.genreList = r.genres.map((g) => ({ id: g.id, name: g.name }));
  }
}

function applyTaglineAndStatus(media: TmdbMedia, r: RawMovie | RawTV): void {
  if (r.tagline) media.tagline = r.tagline;
  if (r.status) media.status = r.status;
}

function applySharedLanguageFields(media: TmdbMedia, r: RawMovie | RawTV): void {
  if (r.original_language) media.originalLanguage = r.original_language;
  if (r.spoken_languages?.length) {
    media.spokenLanguages = r.spoken_languages.map((l) => l.english_name || l.name || languageName(l.iso_639_1) || l.iso_639_1);
  }
}

function applySharedDiscoveryFields(media: TmdbMedia, r: RawMovie | RawTV): void {
  const kw = extractKeywords(r.keywords);
  if (kw) {
    media.keywords = kw.map((k) => k.name);
    media.keywordList = kw;
  }
  const wp = extractWatchProviders(r["watch/providers"]);
  if (wp) media.watchProviders = wp;
}

function normalizeMovie(r: RawMovie): TmdbMedia {
  const media = baseMedia(r, "movie", r.title, r.release_date);
  applyGenres(media, r);
  if (r.production_companies?.length) {
    media.studios = r.production_companies.map((c) => c.name);
    media.studioList = buildStudioList("MOVIE", null, r.production_companies);
  }
  applyTaglineAndStatus(media, r);
  if (r.runtime != null) media.runtime = r.runtime;
  if (r.original_title && r.original_title !== media.title) media.originalTitle = r.original_title;
  applySharedLanguageFields(media, r);
  if (r.production_countries?.length) {
    media.productionCountries = r.production_countries.map((c) => c.name || displayRegion(c.iso_3166_1));
    media.productionCountryCodes = r.production_countries.map((c) => c.iso_3166_1);
    // ISO codes alongside the display names — the anime auto-route matches "JP".
    media.originCountryCodes = r.production_countries.map((c) => c.iso_3166_1);
  } else if (r.origin_country?.length) {
    // Details only (list items carry no origin_country): the same fallback the
    // TV mapper takes, so the anime route sees the codes either way.
    media.productionCountries = r.origin_country.map(displayRegion);
    media.productionCountryCodes = r.origin_country;
    media.originCountryCodes = r.origin_country;
  }
  if (r.homepage) media.homepage = r.homepage;
  if (r.budget) media.budget = r.budget;
  if (r.revenue) media.revenue = r.revenue;
  applySharedDiscoveryFields(media, r);
  // Only detail responses carry an IMDb id, so list payloads stay lean.
  const imdbId = r.external_ids?.imdb_id || r.imdb_id;
  if (imdbId) media.imdbId = imdbId;
  return media;
}

function normalizeTV(r: RawTV): TmdbMedia {
  const media = baseMedia(r, "tv", r.name, r.first_air_date);
  applyGenres(media, r);
  const studios = (r.networks?.length ? r.networks : r.production_companies) ?? [];
  if (studios.length) {
    media.studios = studios.map((c) => c.name);
    media.studioList = buildStudioList("TV", r.networks, r.production_companies);
  }
  applyTaglineAndStatus(media, r);
  if (r.episode_run_time?.length) media.runtime = r.episode_run_time[0];
  if (r.number_of_seasons != null) media.numberOfSeasons = r.number_of_seasons;
  if (r.number_of_episodes != null) media.numberOfEpisodes = r.number_of_episodes;
  if (r.original_name && r.original_name !== media.title) media.originalTitle = r.original_name;
  applySharedLanguageFields(media, r);
  if (r.production_countries?.length) {
    media.productionCountries = r.production_countries.map((c) => c.name || displayRegion(c.iso_3166_1));
    media.productionCountryCodes = r.production_countries.map((c) => c.iso_3166_1);
  } else if (r.origin_country?.length) {
    media.productionCountries = r.origin_country.map(displayRegion);
    media.productionCountryCodes = r.origin_country;
  }
  // ISO codes alongside the display names — origin_country IS codes; the anime
  // auto-route matches "JP" against these (the display-name mapping above lost
  // them, leaving the routing predicate's JP branch unreachable).
  if (r.origin_country?.length) {
    media.originCountryCodes = r.origin_country;
  } else if (r.production_countries?.length) {
    media.originCountryCodes = r.production_countries.map((c) => c.iso_3166_1);
  }
  if (r.homepage) media.homepage = r.homepage;
  if (r.last_air_date) media.lastAirDate = r.last_air_date;
  if (r.in_production != null) media.inProduction = r.in_production;
  if (r.type) media.tvType = r.type;
  if (r.next_episode_to_air?.air_date) media.nextEpisodeAirDate = r.next_episode_to_air.air_date;
  applySharedDiscoveryFields(media, r);
  if (r.external_ids?.tvdb_id) media.tvdbId = r.external_ids.tvdb_id;
  if (r.external_ids?.imdb_id) media.imdbId = r.external_ids.imdb_id;
  return media;
}

// The `:details` blob for a single-title response. The ONE builder for both
// writers of that key — getMovieDetails/getTVDetails and the library prewarm
// (tmdb-prewarm.ts) — so the stored shape can't depend on which wrote it: the
// normalized fields plus the detail-only ones (US certification, home release
// dates, trailer, collection, real seasons). Absent data stays absent; a
// writer's own concerns (ratings, carry-forward, TTL) stay with the writer.
export type TmdbDetailsBody = RawMovie | RawTV;
export function buildDetailsMedia(raw: TmdbDetailsBody, mediaType: "movie" | "tv"): TmdbMedia {
  if (mediaType === "movie") {
    const r = raw as RawMovie;
    const media = normalizeMovie(r);
    const usEntry = r.release_dates?.results?.find((x) => x.iso_3166_1 === "US");
    const cert = usEntry?.release_dates?.find((d) => d.certification)?.certification;
    if (cert) media.certification = cert;
    const home = extractHomeReleaseDates(r.release_dates);
    media.digitalReleaseDate = home.digital;
    media.physicalReleaseDate = home.physical;
    media.trailerKey = extractTrailerKey(r.videos);
    if (r.belongs_to_collection) {
      media.collectionId = r.belongs_to_collection.id;
      media.collectionName = r.belongs_to_collection.name;
    }
    return media;
  }
  const r = raw as RawTV;
  const media = normalizeTV(r);
  const usEntry = r.content_ratings?.results?.find((x) => x.iso_3166_1 === "US");
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
  return media;
}

const VERIFY_WARN_KEY = "tmdb:verify";

export interface VerifiedTmdbMedia {
  title: string;
  posterPath: string | null;
  releaseYear: string;
}

// Confirms a user-supplied tmdbId/type actually exists on TMDB, yielding minimal
// metadata before minting a vote/issue/request row for it. "missing" is TMDB's
// own answer (a 404, or a record with no title); "failed" is no answer at all —
// a timeout, a 5xx, a 429, missing credentials — which says nothing about the
// title, so a caller can tell "no such title" from "try again".
export async function verifyTmdbMediaResult(
  tmdbId: number,
  mediaType: "movie" | "tv",
): Promise<UpstreamResult<VerifiedTmdbMedia>> {
  let r: RawMovie & RawTV;
  try {
    r = await tmdbFetch<RawMovie & RawTV>(`/${mediaType}/${tmdbId}`);
  } catch (err) {
    if (isTmdbNotFound(err)) {
      forgetWarnOnChange(VERIFY_WARN_KEY);
      return upstreamMissing();
    }
    // Once per change of cause (guardrail 7b): during an outage every write
    // path that verifies a title would otherwise log a line per attempt.
    const reason = tmdbFailureReason(err);
    warnOnChange(VERIFY_WARN_KEY, reason, `[tmdb] could not verify a title with TMDB (${sanitizeForLog(reason)}) — it is refused as unverified until TMDB answers`);
    return upstreamFailed(err);
  }
  forgetWarnOnChange(VERIFY_WARN_KEY);
  const title = mediaType === "movie" ? r.title : r.name;
  if (!title || typeof title !== "string") return upstreamMissing();
  const date = mediaType === "movie" ? r.release_date : r.first_air_date;
  return upstreamOk({
    title,
    posterPath: typeof r.poster_path === "string" ? r.poster_path : null,
    releaseYear: typeof date === "string" ? date.slice(0, 4) : "",
  });
}

// The verification as its callers have always read it: null for "TMDB can't
// vouch for the id" — a failure included (the callers answer 422 either way).
// New callers should use verifyTmdbMediaResult and tell the two apart.
export async function verifyTmdbMedia(
  tmdbId: number,
  mediaType: "movie" | "tv",
): Promise<VerifiedTmdbMedia | null> {
  return valueOr(await verifyTmdbMediaResult(tmdbId, mediaType), null);
}

function discoverKey(type: "movie" | "tv", filters: DiscoverFilters): string {
  return [
    `discover:${type}`,
    filters.sortBy ?? "popularity.desc",
    filters.genreId ?? "",
    filters.keywordId ?? "",
    filters.companyId ?? "",
    filters.networkId ?? "",
    filters.certification ?? "",
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
const TOP_PAGES = 20;

const TOP_MIN_VOTES_MOVIE = 200;
const TOP_MIN_VOTES_TV = 100;

// Each cold-cache list helper fans out many paged TMDB fetches, and the Discover
// home page fires seven of them at once — ~105 concurrent requests on a cold
// cache without a bound. Cap the per-list page fan-out, and wrap each helper in
// coalesce() so simultaneous callers share one fan-out instead of multiplying it.
//
// Each helper caches its result ONLY when every page settled fulfilled.
// settleLimit swallows per-page rejections, so without this gate a transient TMDB
// degradation (e.g. 2/10 pages succeed) would cache a truncated list for the full
// TTL.DISCOVER. On partial success the helper still returns what it has (so the
// page renders) but doesn't cache it, so the next request re-fetches.
const LIST_PAGE_CONCURRENCY = 5;

interface PagedListSpec<R extends { id: number }> {
  /** The shared English cache key (and coalesce key) — never a language in it (guardrail 40a). */
  key: string;
  path: string;
  pages: number;
  params?: Record<string, string>;
  /** Rows the list must not show (a date or vote gate). */
  keep?: (row: R) => boolean;
  /** Identity for the first-wins dedupe; the TMDB id unless the list mixes types. */
  identity?: (row: R) => string | number;
  normalize: (row: R) => TmdbMedia;
  /** Re-filter a cache hit (the upcoming lists drop what has since released). */
  fromCache?: (cached: TmdbMedia[]) => TmdbMedia[];
}

// A list and whether EVERY TMDB page answered with a page of results (a cache
// hit is complete). The ONE paged-list loader: cache-first, a bounded fan-out,
// first-wins dedupe, the all-fulfilled cache gate, and the TmdbMediaCore sync.
export interface PagedList {
  items: TmdbMedia[];
  complete: boolean;
}
// After every page of a list failed, the list is not asked for again for this
// long: coalesce only merges callers already in flight, so during an outage
// every new render re-fired up to TOP_PAGES fetches (each with its retries).
// An empty, incomplete answer is served meanwhile — what the failed fan-out
// would have produced anyway. Process-wide (guardrail 27a).
const LIST_FAILURE_BACKOFF_MS = 60_000;
const listFailedUntil = processSingleton("tmdb:list-failed-until", () => new Map<string, number>());

function loadPagedList<R extends { id: number }>(spec: PagedListSpec<R>): Promise<PagedList> {
  return coalesce(spec.key, async (): Promise<PagedList> => {
    const cached = await getCache<TmdbMedia[]>(spec.key);
    if (cached?.length) return { items: spec.fromCache ? spec.fromCache(cached) : cached, complete: true };
    const backoffUntil = listFailedUntil.get(spec.key);
    if (backoffUntil !== undefined) {
      if (Date.now() < backoffUntil) return { items: [], complete: false };
      listFailedUntil.delete(spec.key);
    }

    const pages = await settleLimit(
      Array.from({ length: spec.pages }, (_, i) => i + 1),
      LIST_PAGE_CONCURRENCY,
      (page) => tmdbFetch<PagedResponse<R>>(spec.path, { ...spec.params, page: String(page) }),
    );
    const identity = spec.identity ?? ((r: R) => r.id);
    const seen = new Set<string | number>();
    const items = pages
      .flatMap((p) => (p.status === "fulfilled" ? p.value.results ?? [] : []))
      .filter((r) => r.id != null && r.id > 0)
      .filter((r) => !spec.keep || spec.keep(r))
      .filter((r) => {
        const k = identity(r);
        return seen.has(k) ? false : (seen.add(k), true);
      })
      .map(spec.normalize);

    // A page that answered without a results array is a malformed page, not an
    // empty one — served, but not cached as the whole list.
    const complete = pages.every((p) => p.status === "fulfilled" && Array.isArray(p.value.results));
    if (complete && items.length > 0) await setCache(spec.key, items, TTL.DISCOVER);
    // settleLimit swallows each page's rejection, so a revoked token or a TMDB
    // outage read as an empty list with no trace. Say so once per change of
    // reason (guardrail 7b), keyed on the fixed TMDB path, never the filters.
    const failures = pages.flatMap((p) => (p.status === "rejected" ? [p.reason] : []));
    const logKey = `tmdb:list:${spec.path}`;
    if (failures.length > 0 && failures.length === pages.length) {
      const reason = failures[0] instanceof Error ? failures[0].message : String(failures[0]);
      warnOnChange(logKey, reason, `[tmdb] every page of ${spec.path} failed: ${reason}`);
      listFailedUntil.set(spec.key, Date.now() + LIST_FAILURE_BACKOFF_MS);
    } else {
      forgetWarnOnChange(logKey);
    }
    syncTmdbMediaCore(items).catch((err) => console.error("[tmdb] TmdbMediaCore sync failed:", err));
    return { items, complete };
  });
}

type RawTrending = RawMovie & RawTV & { media_type: string };

export async function getTrending(): Promise<TmdbMedia[]> {
  const key = "trending:week";
  return (await loadPagedList<RawTrending>({
    key,
    path: "/trending/all/week",
    pages: PAGES,
    keep: (r) => r.media_type === "movie" || r.media_type === "tv",
    // /trending/all is the only mixed-type list here, and TMDB movie ids and TV ids are
    // independent namespaces (movie 1399 ≠ tv 1399) — a bare-id Set would drop the second
    // title of a colliding pair from the rail for the whole 12h cache TTL. Key on the
    // composite identity, as every other dedupe in the tree does.
    identity: (r) => `${r.media_type}:${r.id}`,
    normalize: (r) => (r.media_type === "movie" ? normalizeMovie(r) : normalizeTV(r)),
  })).items;
}

export async function getPopularMovies(): Promise<TmdbMedia[]> {
  const key = "movies:popular";
  return (await loadPagedList<RawMovie>({
    key, path: "/movie/popular", pages: BROWSE_PAGES, normalize: normalizeMovie,
  })).items;
}

export async function getPopularTV(): Promise<TmdbMedia[]> {
  const key = "tv:popular";
  return (await loadPagedList<RawTV>({
    key, path: "/tv/popular", pages: BROWSE_PAGES, normalize: normalizeTV,
  })).items;
}

export async function searchMulti(query: string): Promise<TmdbMedia[]> {
  const q = query.trim();
  if (!q) return [];
  const key = `search:${q.toLowerCase()}`;
  return coalesce(key, async () => {
    const cached = await getCache<TmdbMedia[]>(key);
    if (cached?.length) return cached;
    const data = await tmdbFetch<PagedResponse<RawMovie & RawTV & { media_type: string }>>(
      "/search/multi", { query: q, include_adult: "false" }
    );
    const results = (data.results ?? [])
      .filter((r) => r.media_type === "movie" || r.media_type === "tv")
      .filter((r) => r.id != null && r.id > 0)
      .map((r) => r.media_type === "movie" ? normalizeMovie(r as RawMovie) : normalizeTV(r as RawTV));
    // Don't negative-cache an empty result — a transiently-empty TMDB response would otherwise
    // suppress real matches for the full SEARCH TTL.
    if (results.length > 0) await setCache(key, results, TTL.SEARCH);
    return results;
  });
}

function stillUpcoming(items: TmdbMedia[], today: string): TmdbMedia[] {
  return items.filter((m) => m.releaseDate != null && m.releaseDate >= today);
}

// An upcoming list and whether EVERY TMDB page answered (a cache hit is
// complete). The page helpers absorb a failed page and keep going, so an outage
// reads as an empty list; the cache-refresh cron must tell the two apart or it
// replaces the stored list with nothing (sync/upcoming).
type UpcomingList = PagedList;

/** Thrown by the *ForRefresh helpers when TMDB did not answer every page. */
export class UpcomingIncompleteError extends Error {
  constructor(list: "movies" | "tv") {
    super(`TMDB upcoming ${list}: not every page answered — keeping the stored list`);
    this.name = "UpcomingIncompleteError";
  }
}

export async function getUpcomingMovies(): Promise<TmdbMedia[]> {
  return (await loadUpcomingMovies()).items;
}

/**
 * For the upcoming-cache refresh only: the list, or a throw when any TMDB page
 * failed. A refresh must never replace the stored list with a partial or empty
 * answer from an outage.
 */
export async function getUpcomingMoviesForRefresh(): Promise<TmdbMedia[]> {
  const { items, complete } = await loadUpcomingMovies();
  if (!complete) throw new UpcomingIncompleteError("movies");
  return items;
}

function loadUpcomingMovies(): Promise<UpcomingList> {
  // The shared Upcoming cutoff (the page and /api/upcoming use it too): the bare
  // UTC date dropped a title releasing today every evening west of UTC.
  const today = upcomingCutoffDate();
  // /movie/upcoming's window is region-relative and, unanchored, drifts to
  // include already-released titles — the /upcoming page re-filters >= today
  // at read time, but the home "Hitting theaters soon" rail rendered the raw
  // list. Filter here like the TV sibling does, and pin the region to US to
  // match the app-wide convention (certifications, watch providers).
  const key = "movies:upcoming";
  return loadPagedList<RawMovie>({
    key,
    path: "/movie/upcoming",
    pages: UPCOMING_PAGES,
    params: { region: "US" },
    keep: (r) => !!r.release_date && r.release_date >= today,
    normalize: normalizeMovie,
    fromCache: (cached) => stillUpcoming(cached, today),
  });
}

export async function getOnTheAirTV(): Promise<TmdbMedia[]> {
  const key = "tv:on_the_air";
  return (await loadPagedList<RawTV>({
    key, path: "/tv/on_the_air", pages: UPCOMING_PAGES, normalize: normalizeTV,
  })).items;
}

export async function getUpcomingTV(): Promise<TmdbMedia[]> {
  return (await loadUpcomingTV()).items;
}

/** getUpcomingMoviesForRefresh's TV twin. */
export async function getUpcomingTVForRefresh(): Promise<TmdbMedia[]> {
  const { items, complete } = await loadUpcomingTV();
  if (!complete) throw new UpcomingIncompleteError("tv");
  return items;
}

function loadUpcomingTV(): Promise<UpcomingList> {
  const today = upcomingCutoffDate(); // see loadUpcomingMovies
  // /tv/on_the_air returns shows whose original first_air_date is often years past
  // (long-running shows currently airing new episodes). For "Upcoming" we want
  // shows premiering today or later, so we use /discover/tv with first_air_date.gte.
  const key = "tv:upcoming";
  return loadPagedList<RawTV>({
    key,
    path: "/discover/tv",
    pages: UPCOMING_PAGES,
    params: { include_adult: "false", sort_by: "popularity.desc", "first_air_date.gte": today },
    keep: (r) => !!r.first_air_date && r.first_air_date >= today,
    normalize: normalizeTV,
    fromCache: (cached) => stillUpcoming(cached, today),
  });
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

// Suggestion lists feed two consumers with very different appetites, so the
// cache stores the WIDE list and each caller slices to what it needs.
//   - detail-page "More like this" rails take SUGGESTIONS_RAIL_LIMIT (18);
//   - the For You engine takes the whole list, because each seed's tail is what
//     lets a ranked set reach MAX_STORED_RECOMMENDATIONS_PER_USER (200).
// Widening costs ZERO extra requests: /similar and /recommendations each return
// 20 items and both are already fetched, so the surplus was simply discarded.
//
// Declared HERE rather than beside getMovieSuggestions because getMovieDetails/
// getTVDetails are the OTHER writers of the same cache rows and sit above it —
// the two writers must agree on both the key and the stored size.
export const SUGGESTIONS_CACHE_MAX = 40;
const SUGGESTIONS_RAIL_LIMIT = 18;

function creditsKey(type: "movie" | "tv", id: number): string {
  return `${type}:${id}:credits`;
}

// ":v3" retires the 18-item v2 rows in place — a wide caller would otherwise
// keep receiving 18 items for the rest of the 7-day DETAILS TTL, silently
// capping the recommendation pool at the old size after a deploy. (":v2" did
// the same for the pre-reorder similar-first lists.) Orphaned older rows age
// out through the expired-TmdbCache purge.
function suggestionsKey(type: "movie" | "tv", id: number): string {
  return `${type}:${id}:suggestions:v3`;
}

// The cast the detail pages show, from a /credits answer or the appended one.
const CAST_LIMIT = 12;
function castMembers(cast: unknown): CastMember[] {
  if (!Array.isArray(cast)) return [];
  return (cast as RawCastMember[]).slice(0, CAST_LIMIT).flatMap((c) =>
    c && typeof c === "object" ? [{ id: c.id, name: c.name, character: c.character, profilePath: c.profile_path }] : [],
  );
}

// The ONE merge behind both writers of the suggestions key (a details response's
// appended lists and the standalone two-fetch path), so they agree on order,
// filter and width. /recommendations (TMDB's behaviour-based engine) comes
// FIRST, so the cap starves /similar (a crude keyword/genre matcher) rather than
// the reverse: these lists feed the For You engine and the "More like this"
// rails, and similar-first filled both with genre-adjacent noise. The title
// itself, posterless items and repeats are dropped.
function mergeSuggestionPages<R extends { id: number; poster_path?: string | null }>(
  recommended: unknown,
  similar: unknown,
  selfId: number,
  normalize: (r: R) => TmdbMedia,
): TmdbMedia[] {
  const seen = new Set<number>([selfId]);
  const out: TmdbMedia[] = [];
  for (const page of [recommended, similar]) {
    if (!Array.isArray(page)) continue;
    for (const item of page as R[]) {
      if (out.length >= SUGGESTIONS_CACHE_MAX) return out;
      if (!item || typeof item.id !== "number" || item.id <= 0 || seen.has(item.id) || !item.poster_path) continue;
      seen.add(item.id);
      out.push(normalize(item));
    }
  }
  return out;
}

// What a details response carries appended besides the title itself, cached
// fire-and-forget under the keys the standalone credits/suggestions readers
// use. Suggestions only when BOTH lists came back: one alone is a partial
// answer, and the standalone path never caches a partial one either.
function cacheAppendedLists<R extends { id: number; poster_path?: string | null }>(
  type: "movie" | "tv",
  id: number,
  r: { credits?: { cast?: unknown }; recommendations?: { results?: unknown }; similar?: { results?: unknown } },
  normalize: (r: R) => TmdbMedia,
): void {
  if (r.credits?.cast) setCache(creditsKey(type, id), castMembers(r.credits.cast), TTL.DETAILS).catch(() => {});
  const recommended = r.recommendations?.results;
  const similar = r.similar?.results;
  if (Array.isArray(recommended) && Array.isArray(similar)) {
    setCache(suggestionsKey(type, id), mergeSuggestionPages(recommended, similar, id, normalize), TTL.DETAILS).catch(() => {});
  }
}

// A ratings lookup applied to a details row. Only a configured source's
// authoritative "no ratings" pins nulls: a transient failure leaves the fields
// undefined so a later read re-fetches instead of serving null for the 7-day
// TTL (pinAuthoritativeNoRatings covers every field the cached-row upgrade
// below checks, so a no-ratings title never re-fetches on every read). True
// when the row changed.
function applyRatingsResult(media: TmdbMedia, r: UnifiedRatingsResult): boolean {
  if (r.found && r.data) {
    assignUnifiedRatings(media, r.data);
    return true;
  }
  if (r.keyConfigured && !r.transient) {
    pinAuthoritativeNoRatings(media);
    return true;
  }
  return false;
}

// A cached details row is upgraded in place on read (the two upgrades below).
// When one fails transiently it is not tried again on every read for this long:
// each attempt waits out the providers' timeouts (or TMDB's retries) in the
// render path of a page that is otherwise served from cache. Process-wide
// (guardrail 27a), bounded.
const DETAIL_UPGRADE_RETRY_MS = 10 * 60 * 1000;
const MAX_DEFERRED_UPGRADES = 5_000;
const deferredUpgrades = processSingleton("tmdb:deferred-detail-upgrades", () => new Map<string, number>());

function upgradeDeferred(key: string): boolean {
  const until = deferredUpgrades.get(key);
  if (until === undefined) return false;
  if (Date.now() < until) return true;
  deferredUpgrades.delete(key);
  return false;
}

function deferUpgrade(key: string): void {
  const now = Date.now();
  if (deferredUpgrades.size >= MAX_DEFERRED_UPGRADES) {
    for (const [k, until] of deferredUpgrades) if (until <= now) deferredUpgrades.delete(k);
    if (deferredUpgrades.size >= MAX_DEFERRED_UPGRADES) {
      const oldest = deferredUpgrades.keys().next().value;
      if (oldest !== undefined) deferredUpgrades.delete(oldest);
    }
  }
  deferredUpgrades.set(key, now + DETAIL_UPGRADE_RETRY_MS);
}

/** Test seam: forgets the process-wide failure backoffs (list and detail-upgrade). */
export function __resetTmdbBackoffsForTests(): void {
  listFailedUntil.clear();
  deferredUpgrades.clear();
}

// `mdblistScore === undefined` also catches rows cached before the unified
// payload widened to the full MDBList field set, so they lazily re-fetch and
// gain the new fields within the 7-day TTL. The row's stored imdbId is
// forwarded (prewarm/fresh writers persist it) so a cold OMDB fallback skips its
// TMDB external_ids resolve; a stale hint self-heals in fetchAndCacheOmdbForTmdb
// (one live re-resolve), so it can't tombstone.
async function upgradeCachedRatings(cached: TmdbMedia, type: "movie" | "tv", id: number, key: string): Promise<boolean> {
  if (cached.imdbRating !== undefined && cached.rtAudienceScore !== undefined && cached.mdblistScore !== undefined) return false;
  const deferKey = `${key}:ratings`;
  if (upgradeDeferred(deferKey)) return false;
  const r = await fetchUnifiedRatings(id, type, cached.releaseDate, cached.imdbId ?? null);
  if (applyRatingsResult(cached, r)) return true;
  if (r.transient) deferUpgrade(deferKey);
  return false;
}

// Movie rows cached before the home-release fields existed: one small
// /release_dates call fills them in place instead of waiting out the 7-day
// TTL. A failure leaves them undefined so a later read retries.
async function upgradeCachedHomeReleaseDates(cached: TmdbMedia, id: number, key: string): Promise<boolean> {
  if (cached.digitalReleaseDate !== undefined && cached.physicalReleaseDate !== undefined) return false;
  const deferKey = `${key}:release-dates`;
  if (upgradeDeferred(deferKey)) return false;
  try {
    const rd = await tmdbFetch<NonNullable<RawMovie["release_dates"]>>(`/movie/${id}/release_dates`);
    const home = extractHomeReleaseDates(rd);
    cached.digitalReleaseDate = home.digital;
    cached.physicalReleaseDate = home.physical;
    return true;
  } catch (err) {
    deferUpgrade(deferKey);
    console.warn(`[tmdb] movie:${id} release_dates fetch failed:`, err instanceof Error ? err.message : err);
    return false;
  }
}

const DETAILS_APPEND: Record<"movie" | "tv", string> = {
  movie: "release_dates,videos,credits,recommendations,similar,keywords,watch/providers,external_ids",
  tv: "content_ratings,videos,credits,recommendations,similar,seasons,keywords,watch/providers,external_ids",
};

// The details of one title: the cached row (upgraded in place), else a fresh
// fetch. The one body behind getMovieDetails and getTVDetails.
function loadDetails(type: "movie" | "tv", id: number): Promise<TmdbMedia> {
  const key = tmdbDetailsKey(type, id);
  return coalesce(key, async () => {
    const entry = await getCacheEntry<TmdbMedia>(key);
    const cached = entry?.value;

    // Self-heal: the old getMovieReleaseInfo (arr.ts, pre key-split) wrote the
    // RAW snake_case TMDB body under the movie key. Every normalized writer sets
    // `mediaType`; a row without it is a poisoned blob — treat it as a miss so
    // it re-fetches and overwrites now instead of serving a shape with
    // mediaType/posterPath/releaseDate undefined for the rest of the TTL.
    if (entry && cached && cached.mediaType) {
      if (type === "tv" && cached.seasons === undefined) {
        // A cached TV entry without a seasons field is from before the schema
        // added seasons; bust it so this read fetches one that includes them.
        // Awaited on purpose: fire-and-forget, this unpredicated delete can land
        // AFTER the setCache upsert in fetchDetails (or one from tmdb-prewarm)
        // and wipe the freshly written row, forcing another full fetch.
        await prisma.tmdbCache.delete({ where: { key } }).catch(() => {});
      } else {
        let needsWrite = migrateKeywordShape(cached);
        if (await upgradeCachedRatings(cached, type, id, key)) needsWrite = true;
        if (type === "movie" && (await upgradeCachedHomeReleaseDates(cached, id, key))) needsWrite = true;
        // An in-place upgrade keeps the row's own expiry: rewriting with a fresh
        // TTL.DETAILS let the TMDB fields it carries live up to two TTLs.
        if (needsWrite) await setCacheUntil(key, cached, entry.expiresAt);
        return cached;
      }
    }
    return fetchDetails(type, id, key);
  });
}

async function fetchDetails(type: "movie" | "tv", id: number, key: string): Promise<TmdbMedia> {
  // Sequential on purpose: the ratings caches derive their TTL from the release
  // date (libraryDetailsTtl). Fetching in parallel passed no date, so a
  // brand-new release's MDBList/OMDB rows were cached with the 30-day
  // back-catalog TTL instead of the 3-day fresh-title one.
  const r = await tmdbFetch<TmdbDetailsBody>(`/${type}/${id}`, { append_to_response: DETAILS_APPEND[type] });
  const media = buildDetailsMedia(r, type);
  // The appended external_ids already carry the IMDb id — hand it to the ratings
  // chain so a cold OMDB fallback doesn't re-buy it with a second TMDB call.
  applyRatingsResult(media, await fetchUnifiedRatings(id, type, media.releaseDate, media.imdbId ?? null));

  if (type === "movie") cacheAppendedLists("movie", id, r as RawMovie, normalizeMovie);
  else cacheAppendedLists("tv", id, r as RawTV, normalizeTV);

  await setCache(key, media, TTL.DETAILS);
  upsertTmdbMediaCore(media).catch((err) => console.error("[tmdb] TmdbMediaCore upsert failed:", err));
  return media;
}

export async function getMovieDetails(id: number): Promise<TmdbMedia> {
  return loadDetails("movie", id);
}

export async function getTVDetails(id: number): Promise<TmdbMedia> {
  return loadDetails("tv", id);
}

async function loadCredits(type: "movie" | "tv", id: number): Promise<CastMember[]> {
  const key = creditsKey(type, id);
  const cached = await getCache<CastMember[]>(key);
  if (cached) return cached;

  const r = await tmdbFetch<{ cast?: unknown }>(`/${type}/${id}/credits`);
  const result = castMembers(r.cast);
  // Don't cache an empty result — `cast` missing from an otherwise-200 response
  // would otherwise suppress the real cast for the full DETAILS TTL (mirrors
  // searchMulti's guard).
  if (result.length > 0) await setCache(key, result, TTL.DETAILS);
  return result;
}

export async function getMovieCredits(id: number): Promise<CastMember[]> {
  return loadCredits("movie", id);
}

export async function getTVCredits(id: number): Promise<CastMember[]> {
  return loadCredits("tv", id);
}

// The season for a viewer: `episodes` is TMDB's `language=` answer merged over
// the English list episode by episode, `english` the list it was merged over.
// TMDB fills an untranslated episode name with a generic "Épisode 3" and leaves
// the overview blank, so a blank overview keeps the English one. English
// (language null) is the plain cached path and returns the same array as both.
// `english` is the ONLY one a caller may STORE: TVEpisodeCache is shared by every
// viewer and stored data stays English (guardrail 40a) — `episodes` is display-only.
export async function getTVSeasonEpisodesLocalized(
  tmdbId: number,
  seasonNumber: number,
  language: string | null,
): Promise<{ episodes: TmdbEpisode[]; english: TmdbEpisode[] }> {
  const english = await getTVSeasonEpisodes(tmdbId, seasonNumber);
  if (!language || english.length === 0) return { episodes: english, english };
  const key = `tv:${tmdbId}:season:${seasonNumber}:${language}`;
  let local = await getCache<{ n: number; name: string; overview: string }[]>(key);
  if (!local) {
    try {
      const r = await tmdbFetch<{ episodes?: RawEpisode[] }>(`/tv/${tmdbId}/season/${seasonNumber}`, { language });
      local = (r.episodes ?? []).map((e) => ({ n: e.episode_number, name: (e.name ?? "").trim(), overview: (e.overview ?? "").trim() }));
      if (local.length > 0) await setCache(key, local, TTL.DETAILS);
    } catch {
      return { episodes: english, english }; // a failed translation never fails the season
    }
  }
  const byNumber = new Map(local.map((e) => [e.n, e]));
  const episodes = english.map((e) => {
    const l = byNumber.get(e.episodeNumber);
    if (!l) return e;
    return { ...e, name: l.name || e.name, overview: l.overview || e.overview };
  });
  return { episodes, english };
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

  // Don't cache an empty result — `episodes` missing from an otherwise-200
  // response would otherwise suppress the real season for the full DETAILS TTL
  // (mirrors searchMulti's guard).
  if (episodes.length > 0) await setCache(key, episodes, TTL.DETAILS);
  return episodes;
}

// Calendar-feed TV data (src/lib/calendar-events.ts): a plain /tv/<id> read,
// cached under its OWN key. Deliberately not getTVDetails — that path also runs
// the MDBList/OMDB ratings chain, whose OMDB getter detaches a stale refresh, so
// a bounded warm over it would not bound the upstream work (guardrail 31a). This
// one awaits everything it starts. A short TTL because next_episode_to_air moves
// weekly for an airing show.
export interface TvCalendarInfo {
  status: string | null;
  lastAirDate: string | null;
  seasons: { seasonNumber: number; airDate: string | null; episodeCount: number }[];
  nextEpisode: {
    airDate: string;
    seasonNumber: number | null;
    episodeNumber: number | null;
    name: string | null;
  } | null;
}
export const TV_CALENDAR_TTL = 2 * 24 * 60 * 60;
export function tvCalendarKey(tmdbId: number): string {
  return `tv:${tmdbId}:calendar:v1`;
}

export async function getTVCalendarInfo(tmdbId: number): Promise<TvCalendarInfo> {
  const key = tvCalendarKey(tmdbId);
  return coalesce(key, async () => {
    const cached = await getCache<TvCalendarInfo>(key);
    if (cached) return cached;
    const r = await tmdbFetch<RawTV>(`/tv/${tmdbId}`);
    const next = r.next_episode_to_air;
    const info: TvCalendarInfo = {
      status: r.status ?? null,
      lastAirDate: r.last_air_date ?? null,
      seasons: (r.seasons ?? [])
        .filter((s) => s.season_number > 0)
        .map((s) => ({ seasonNumber: s.season_number, airDate: s.air_date ?? null, episodeCount: s.episode_count })),
      nextEpisode: next?.air_date
        ? {
            airDate: next.air_date,
            seasonNumber: next.season_number ?? null,
            episodeNumber: next.episode_number ?? null,
            name: next.name ?? null,
          }
        : null,
    };
    await setCache(key, info, TV_CALENDAR_TTL);
    return info;
  });
}

type TranslatedLocale = Exclude<Locale, "en">;

// One field of a /<kind>/<id>/translations answer, per locale: each locale's
// first TMDB tag (region preference order, TMDB_LANGUAGES) with a non-blank
// value. One call answers every language; {} when nothing is translated.
async function fetchTranslatedField<V>(
  path: string,
  read: (data: { biography?: string; title?: string; name?: string }) => string | undefined,
  wrap: (value: string) => V,
): Promise<Partial<Record<TranslatedLocale, V>>> {
  const r = await tmdbFetch<{ translations?: { iso_639_1?: string; iso_3166_1?: string; data?: { biography?: string; title?: string; name?: string } }[] }>(path);
  const byTag = new Map<string, string>();
  for (const tr of Array.isArray(r.translations) ? r.translations : []) {
    if (!tr || typeof tr !== "object" || !tr.data) continue;
    const value = (read(tr.data) ?? "").trim();
    if (tr.iso_639_1 && tr.iso_3166_1 && value) byTag.set(`${tr.iso_639_1}-${tr.iso_3166_1}`, value);
  }
  const out: Partial<Record<TranslatedLocale, V>> = {};
  for (const [locale, tags] of Object.entries(TMDB_LANGUAGES) as [TranslatedLocale, readonly string[]][]) {
    const value = tags.map((t) => byTag.get(t)).find(Boolean);
    if (value) out[locale] = wrap(value);
  }
  return out;
}

// A person's biography in each of our languages (fetchTitleTranslations' trimming
// and region preference).
export type PersonTranslations = Partial<Record<TranslatedLocale, { biography: string }>>;
export function fetchPersonTranslations(id: number): Promise<PersonTranslations> {
  return fetchTranslatedField(`/person/${id}/translations`, (d) => d.biography, (biography) => ({ biography }));
}

// A collection's name in each of our languages.
export type CollectionTranslations = Partial<Record<TranslatedLocale, { name: string }>>;
export function fetchCollectionTranslations(id: number): Promise<CollectionTranslations> {
  return fetchTranslatedField(`/collection/${id}/translations`, (d) => d.title ?? d.name, (name) => ({ name }));
}

interface RawPersonCredit {
  id: number;
  media_type?: string;
  title?: string;
  name?: string;
  poster_path?: string | null;
  release_date?: string;
  first_air_date?: string;
  vote_average?: number;
  character?: string;
  vote_count?: number;
}

interface RawPerson {
  id: number;
  name?: string;
  profile_path?: string | null;
  known_for_department?: string;
  biography?: string;
  birthday?: string | null;
  deathday?: string | null;
  place_of_birth?: string | null;
  // Optional in the type to match reality: append_to_response payloads can be
  // absent on edge responses; personCredits degrades to an empty list.
  combined_credits?: { cast?: RawPersonCredit[] };
}

const PERSON_CREDIT_LIMIT = 40;
const PERSON_CREDIT_MIN_VOTES = 10;

const creditDate = (c: RawPersonCredit): string => c.release_date ?? c.first_air_date ?? "";

// A person's filmography for the person page: titles with a poster and a real
// audience, newest first. TMDB lists a title once PER CHARACTER (a series with
// several roles, a movie with a dual part), so it is deduped on (media_type, id)
// BEFORE the cap — otherwise the 40-credit budget is spent on repeated roles and
// the UI would render two cards for one title (person-view keys cards by
// `${mediaType}-${id}`). The first (newest-dated) entry wins; the extra roles
// fold into its `character` text so nothing is lost. Pure.
function personCredits(cast: unknown): PersonCredit[] {
  const eligible = (Array.isArray(cast) ? (cast as RawPersonCredit[]) : [])
    .filter((c) => c && (c.media_type === "movie" || c.media_type === "tv") && c.poster_path && (c.vote_count ?? 0) > PERSON_CREDIT_MIN_VOTES)
    .sort((a, b) => creditDate(b).localeCompare(creditDate(a)));
  const byTitle = new Map<string, PersonCredit>();
  for (const c of eligible) {
    const dedupeKey = `${c.media_type}:${c.id}`;
    const existing = byTitle.get(dedupeKey);
    if (!existing) {
      byTitle.set(dedupeKey, {
        id: c.id, mediaType: c.media_type as MediaType,
        title: c.title ?? c.name ?? "",
        posterPath: c.poster_path ?? null,
        releaseYear: creditDate(c).slice(0, 4),
        character: c.character ?? "", voteAverage: c.vote_average ?? 0,
      });
      continue;
    }
    const role = c.character?.trim();
    if (role && !existing.character.split(" / ").includes(role)) {
      existing.character = existing.character ? `${existing.character} / ${role}` : role;
    }
  }
  return [...byTitle.values()].slice(0, PERSON_CREDIT_LIMIT);
}

export async function getPersonDetails(id: number): Promise<PersonDetails> {
  // v2: shape grew (biography/birth/death/placeOfBirth + a larger credit cap) —
  // bump the key so pre-existing cached rows don't serve the old shape.
  // v3: credits are deduped per (mediaType, id) — v2 rows can still carry one
  // entry per character, which collide under person-view's `${mediaType}-${id}` key.
  const key = `person:v3:${id}`;
  const cached = await getCache<PersonDetails>(key);
  if (cached) return cached;

  const r = await tmdbFetch<RawPerson>(`/person/${id}`, { append_to_response: "combined_credits" });
  const result: PersonDetails = {
    id: r.id, name: r.name ?? "", profilePath: r.profile_path ?? null,
    knownForDepartment: r.known_for_department ?? "",
    biography: r.biography ?? "",
    birthday: r.birthday ?? null,
    deathday: r.deathday ?? null,
    placeOfBirth: r.place_of_birth ?? null,
    credits: personCredits(r.combined_credits?.cast),
  };

  await setCache(key, result, TTL.PERSON);
  return result;
}

// `language` is a TMDB language tag (tmdbLanguageFor) — omitted, the list is
// English under the original cache key, so every existing caller and the
// warm-list-cache cron are unchanged.
export async function getMovieGenres(language?: string | null): Promise<Genre[]> {
  return getGenres("movie", language);
}

export async function getTVGenres(language?: string | null): Promise<Genre[]> {
  return getGenres("tv", language);
}

async function getGenres(type: "movie" | "tv", language?: string | null): Promise<Genre[]> {
  const key = `genres:${type}${language ? `:${language}` : ""}`;
  const cached = await getCache<Genre[]>(key);
  if (cached) return cached;

  const r = await tmdbFetch<{ genres?: unknown }>(`/genre/${type}/list`, language ? { language } : {});
  // A 200 without a usable genres list is served as empty and never cached: a
  // cached undefined read back as a miss on every call, a cached [] would hide
  // the filters for the whole TTL.
  const genres = Array.isArray(r.genres)
    ? (r.genres as Genre[]).filter((g) => g && typeof g.id === "number" && typeof g.name === "string")
    : [];
  if (genres.length > 0) await setCache(key, genres, TTL.GENRES);
  return genres;
}

// ── Localized TMDB content ──────────────────────────────────────────────────
// Every cached TMDB payload is English and stays that way (stored requests,
// notifications, the *arr pushes and the ratings pipeline all read it). Other
// languages are an OVERLAY applied at display time by tmdb-localize.ts.

// The TMDB translation tags tried, in order, for each non-English UI locale.
// "pt" is Brazilian and "zh" Simplified, like the UI catalogs; Traditional
// Chinese (zh-TW/zh-HK) is never used for "zh".
export const TMDB_LANGUAGES: Record<Exclude<Locale, "en">, readonly string[]> = {
  es: ["es-ES", "es-MX"],
  fr: ["fr-FR", "fr-CA"],
  de: ["de-DE", "de-AT", "de-CH"],
  pt: ["pt-BR", "pt-PT"],
  it: ["it-IT"],
  zh: ["zh-CN", "zh-SG"],
};

// The tag sent as TMDB's `language=` parameter, or null for English (which is
// TMDB's default and the cached form).
export function tmdbLanguageFor(locale: Locale): string | null {
  return locale === "en" ? null : TMDB_LANGUAGES[locale][0];
}

export interface TitleTranslation {
  title?: string;
  overview?: string;
  tagline?: string;
  // A poster whose artwork is in this language (title text on it), when TMDB
  // has one; absent ⇒ keep the default poster.
  posterPath?: string;
}
export type TitleTranslations = Partial<Record<Exclude<Locale, "en">, TitleTranslation>>;

interface RawTranslationsEntry {
  iso_639_1?: string;
  iso_3166_1?: string;
  data?: { title?: string; name?: string; overview?: string; tagline?: string };
}
interface RawImage {
  file_path?: string;
  iso_639_1?: string | null;
  iso_3166_1?: string | null;
  vote_average?: number;
  vote_count?: number;
}
interface RawTranslatedDetails {
  translations?: { translations?: RawTranslationsEntry[] };
  images?: { posters?: RawImage[] };
}

// Every language's poster we could use, asked for in one parameter.
const POSTER_LANGUAGES = [...new Set(Object.values(TMDB_LANGUAGES).flat().map((tag) => tag.split("-")[0]))].join(",");

// The best poster in one of `tags`' languages. A poster tagged with a region
// must match one of the tags (so "zh" never picks a zh-TW Traditional poster);
// an untagged-region poster counts for the language — except Chinese, where the
// script can't be told without the region.
function pickLanguagePoster(posters: RawImage[], tags: readonly string[]): string | undefined {
  const langs = new Set(tags.map((t) => t.split("-")[0]));
  const regions = new Set(tags.map((t) => t.split("-")[1]));
  const ok = posters.filter((p) => {
    if (!p.file_path || !p.iso_639_1 || !langs.has(p.iso_639_1)) return false;
    if (p.iso_3166_1) return regions.has(p.iso_3166_1);
    return p.iso_639_1 !== "zh";
  });
  ok.sort((a, b) => (b.vote_average ?? 0) - (a.vote_average ?? 0) || (b.vote_count ?? 0) - (a.vote_count ?? 0));
  return ok[0]?.file_path;
}

// ONE call answers every language: the details endpoint with translations and
// the language-tagged posters appended. Trimmed to our locales so a cached row
// is a few KB, not the ~50 KB TMDB returns for a popular title. An empty string
// means "not translated" and is dropped — the overlay then keeps the English
// field. A title with nothing usable yields {}.
export async function fetchTitleTranslations(mediaType: MediaType, id: number): Promise<TitleTranslations> {
  const path = mediaType === "movie" ? `/movie/${id}` : `/tv/${id}`;
  const r = await tmdbFetch<RawTranslatedDetails>(path, {
    append_to_response: "translations,images",
    include_image_language: POSTER_LANGUAGES,
  });
  const posters = r.images?.posters ?? [];
  const byTag = new Map<string, NonNullable<RawTranslationsEntry["data"]>>();
  for (const tr of r.translations?.translations ?? []) {
    if (tr.iso_639_1 && tr.iso_3166_1 && tr.data) byTag.set(`${tr.iso_639_1}-${tr.iso_3166_1}`, tr.data);
  }
  const out: TitleTranslations = {};
  for (const [locale, tags] of Object.entries(TMDB_LANGUAGES) as [Exclude<Locale, "en">, readonly string[]][]) {
    const entry: TitleTranslation = {};
    // Field by field: es-ES may carry a title but no overview that es-MX has.
    for (const tag of tags) {
      const d = byTag.get(tag);
      if (!d) continue;
      const title = (d.title ?? d.name ?? "").trim();
      const overview = (d.overview ?? "").trim();
      const tagline = (d.tagline ?? "").trim();
      if (!entry.title && title) entry.title = title;
      if (!entry.overview && overview) entry.overview = overview;
      if (!entry.tagline && tagline) entry.tagline = tagline;
    }
    const poster = pickLanguagePoster(posters, tags);
    if (poster) entry.posterPath = poster;
    if (entry.title || entry.overview || entry.tagline || entry.posterPath) out[locale] = entry;
  }
  return out;
}

export async function getWatchProviders(type: "movie" | "tv", region = "US"): Promise<WatchProvider[]> {
  // Canonicalize region to a 2-letter ISO code (uppercased) at the source. The
  // movies/tv pages pass sp.watchRegion straight through here (unlike the discover
  // path, which routes through sanitizeDiscoverFilters), so an unvalidated value
  // would otherwise mint unbounded `watchproviders:*:<region>` cache rows + TMDB
  // calls and land raw in the watch_region query param. Junk → default "US".
  const canonRegion = /^[A-Za-z]{2}$/.test(region) ? region.toUpperCase() : "US";
  const key = `watchproviders:${type}:${canonRegion}`;
  const cached = await getCache<WatchProvider[]>(key);
  if (cached) return cached;

  const r = await tmdbFetch<{ results?: unknown }>(
    `/watch/providers/${type}`,
    { watch_region: canonRegion },
  );
  // An entry without a name or logo is dropped rather than thrown on (the sort
  // reads the name).
  const providers = (Array.isArray(r.results) ? (r.results as WatchProvider[]) : [])
    .filter((p) => p && p.logo_path && typeof p.provider_name === "string")
    .sort((a, b) => a.provider_name.localeCompare(b.provider_name));

  await setCache(key, providers, TTL.GENRES);
  return providers;
}

// Both top-rated lists, through the one paged-list loader.
function loadTopRated(mediaType: "movie" | "tv"): Promise<PagedList> {
  return mediaType === "movie"
    ? loadPagedList<RawMovie>({
        key: "movies:top_rated",
        path: "/movie/top_rated",
        pages: TOP_PAGES,
        keep: (r) => (r.vote_count ?? 0) >= TOP_MIN_VOTES_MOVIE,
        normalize: normalizeMovie,
      })
    : loadPagedList<RawTV>({
        key: "tv:top_rated",
        path: "/tv/top_rated",
        pages: TOP_PAGES,
        keep: (r) => (r.vote_count ?? 0) >= TOP_MIN_VOTES_TV,
        normalize: normalizeTV,
      });
}

export async function getTopRatedMovies(): Promise<TmdbMedia[]> {
  return (await loadTopRated("movie")).items;
}

export async function getTopRatedTV(): Promise<TmdbMedia[]> {
  return (await loadTopRated("tv")).items;
}

/**
 * The top-rated list with whether it is complete: false after a failed page,
 * during the all-pages-failed backoff, or when the load threw. Never throws;
 * a cache hit is complete.
 */
export async function getTopRatedWithStatus(mediaType: "movie" | "tv"): Promise<PagedList> {
  try {
    return await loadTopRated(mediaType);
  } catch (err) {
    console.error(`[tmdb] top-rated ${mediaType} list failed:`, err instanceof Error ? err.message : err);
    return { items: [], complete: false };
  }
}

// A title's suggestions and whether they are a complete answer: both
// /recommendations and /similar answered with a results array (a cache hit is
// complete). `failure` is the first reason one did not.
interface SuggestionList {
  items: TmdbMedia[];
  complete: boolean;
  failure?: unknown;
}

// The ONE standalone suggestions loader: cache-first, both endpoints fetched
// together, cached only when COMPLETE. A partial list (one endpoint failed) is
// served but never cached: pinned for the 7-day DETAILS TTL it would leave a
// degraded rail, and a degraded edge list in the For You graph, for the week.
// An empty complete answer isn't cached either (searchMulti's guard).
function loadSuggestions(type: "movie" | "tv", id: number): Promise<SuggestionList> {
  const key = suggestionsKey(type, id);
  return coalesce(key, async (): Promise<SuggestionList> => {
    const cached = await getCache<TmdbMedia[]>(key);
    if (cached) return { items: cached, complete: true };

    const [similar, recommended] = await Promise.allSettled([
      tmdbFetch<PagedResponse<RawMovie & RawTV>>(`/${type}/${id}/similar`),
      tmdbFetch<PagedResponse<RawMovie & RawTV>>(`/${type}/${id}/recommendations`),
    ]);
    const resultsOf = (r: PromiseSettledResult<PagedResponse<RawMovie & RawTV>>) =>
      r.status === "fulfilled" ? r.value.results : undefined;
    const items = type === "movie"
      ? mergeSuggestionPages<RawMovie>(resultsOf(recommended), resultsOf(similar), id, normalizeMovie)
      : mergeSuggestionPages<RawTV>(resultsOf(recommended), resultsOf(similar), id, normalizeTV);
    // A page that answered without a results array is a malformed page, not an
    // empty one — the loadPagedList rule.
    const complete = [recommended, similar].every((r) => r.status === "fulfilled" && Array.isArray(r.value.results));
    if (complete && items.length > 0) await setCache(key, items, TTL.DETAILS);
    const rejected = [recommended, similar].find((r) => r.status === "rejected");
    const failure = complete
      ? undefined
      : rejected?.status === "rejected" ? rejected.reason : new Error(`TMDB ${type}:${id} suggestions answered without a results list`);
    return { items, complete, failure };
  });
}

// Slices AFTER coalesce so every caller shares one fetch and one cache row
// regardless of the limit it asked for. slice() copies, so a narrow caller can
// never truncate the array a wide one is holding.
export async function getMovieSuggestions(
  id: number,
  limit: number = SUGGESTIONS_RAIL_LIMIT,
): Promise<TmdbMedia[]> {
  return (await loadSuggestions("movie", id)).items.slice(0, limit);
}

export async function getTVSuggestions(
  id: number,
  limit: number = SUGGESTIONS_RAIL_LIMIT,
): Promise<TmdbMedia[]> {
  return (await loadSuggestions("tv", id)).items.slice(0, limit);
}

/**
 * A title's whole suggestion list (SUGGESTIONS_CACHE_MAX wide) as an answer or a
 * failure, for the For You graph (guardrail 40). "ok" only for a complete
 * answer — both endpoints, or the cache; a partial or failed fetch is "failed",
 * never a list to stamp. An empty "ok" is TMDB saying it has nothing similar.
 */
export async function getSuggestionsResult(type: "movie" | "tv", id: number): Promise<UpstreamResult<TmdbMedia[]>> {
  let list: SuggestionList;
  try {
    list = await loadSuggestions(type, id);
  } catch (err) {
    return upstreamFailed(err);
  }
  return list.complete ? upstreamOk(list.items.slice()) : upstreamFailed(list.failure);
}

export async function getMovieCollection(collectionId: number): Promise<TmdbMedia[]> {
  const key = `collection:${collectionId}`;
  // ?.length (not truthiness): an already-pinned empty row heals on the next
  // read instead of serving [] for the rest of its 7-day TTL.
  const cached = await getCache<TmdbMedia[]>(key);
  if (cached?.length) return cached;

  const r = await tmdbFetch<{ id: number; parts?: RawMovie[] }>(`/collection/${collectionId}`);
  // parts can be absent on a degraded response — every sibling helper guards
  // its results array; an unguarded .filter threw here. And never cache an
  // empty result: a transient empty would suppress the collection row for the
  // full DETAILS TTL (the searchMulti/suggestions convention).
  const result = (r.parts ?? [])
    .filter((p) => p.id != null && p.id > 0 && p.poster_path)
    .sort((a, b) => (a.release_date ?? "").localeCompare(b.release_date ?? ""))
    .map(normalizeMovie);

  if (result.length > 0) await setCache(key, result, TTL.DETAILS);
  return result;
}

export interface PagedResult {
  items: TmdbMedia[];
  totalPages: number;
}

// Upper-bound to TMDB's own page depth (mirrors the totalPages clamp) —
// otherwise an arbitrary page number mints an unbounded number of distinct
// TmdbCache rows and upstream calls for the same shared TMDB_READ_TOKEN.
function clampPage(page: number): number {
  return Math.min(Math.max(1, page), MAX_TMDB_PAGE);
}

// One page of a TMDB list, cache-first under `key` — the body behind the
// popular and discover page readers.
async function loadResultPage<R extends { id: number }>(
  key: string,
  path: string,
  params: Record<string, string>,
  page: number,
  normalize: (r: R) => TmdbMedia,
): Promise<PagedResult> {
  const cached = await getCache<PagedResult>(key);
  if (cached) return cached;

  const r = await tmdbFetch<PagedResponse<R>>(path, { ...params, page: String(page) });
  const result: PagedResult = {
    items: (Array.isArray(r.results) ? r.results : []).filter((item) => item && item.id != null && item.id > 0).map(normalize),
    totalPages: totalPagesOf(r.total_pages, page),
  };
  // Don't cache an empty page — a transiently-empty/erroring upstream response
  // would otherwise suppress real results for the full DISCOVER TTL (mirrors
  // searchMulti's negative-cache guard).
  if (result.items.length > 0) await setCache(key, result, TTL.DISCOVER);
  syncTmdbMediaCore(result.items).catch((err) => console.error("[tmdb] TmdbMediaCore sync failed:", err));
  return result;
}

export async function getPopularMoviesPage(page: number): Promise<PagedResult> {
  const p = clampPage(page);
  return loadResultPage<RawMovie>(`movies:popular:page:${p}`, "/movie/popular", {}, p, normalizeMovie);
}

export async function getPopularTVPage(page: number): Promise<PagedResult> {
  const p = clampPage(page);
  return loadResultPage<RawTV>(`tv:popular:page:${p}`, "/tv/popular", {}, p, normalizeTV);
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

// ALLOWED_DISCOVER_SORT is shared by movies and TV, but /discover/tv only sorts by
// first_air_date, name/original_name, popularity and vote_*. The web filter-bar's
// Newest/Oldest send release_date.* (iOS primary_release_date.*) for BOTH media
// types, so translate to the media type's own field — before the cache key too, so
// equivalent sorts share one row. A sort TV can't express (revenue) falls back to
// popularity in the asked direction. The movie side maps first_air_date.* to
// primary_release_date.*.
function discoverSortFor(mediaType: "movie" | "tv", sortBy: string): string {
  const dot = sortBy.lastIndexOf(".");
  const field = sortBy.slice(0, dot);
  const dir = sortBy.slice(dot + 1);
  if (mediaType === "tv") {
    if (field === "release_date" || field === "primary_release_date") return `first_air_date.${dir}`;
    if (field === "original_title") return `original_name.${dir}`;
    // TV can't sort by revenue: keep the direction on the closest field.
    if (field === "revenue") return `popularity.${dir}`;
    return sortBy;
  }
  if (field === "first_air_date") return `primary_release_date.${dir}`;
  return sortBy;
}

// Normalize the remaining free-text discover filters up front so junk values reach
// neither TMDB nor the cache key (an unvalidated string baked into discoverKey() lets
// an authenticated user manufacture arbitrary distinct TmdbCache rows). genreId is a
// digit list joined by , or |; minVoteCount is a non-negative integer; watchRegion is a
// 2-letter ISO country code.
function sanitizeDiscoverFilters(filters: DiscoverFilters): DiscoverFilters {
  const genreId = filters.genreId && /^[\d|,]+$/.test(filters.genreId) ? filters.genreId : undefined;
  const keywordId = filters.keywordId && /^[\d|,]+$/.test(filters.keywordId) ? filters.keywordId : undefined;
  const companyId = filters.companyId && /^[\d|,]+$/.test(filters.companyId) ? filters.companyId : undefined;
  const networkId = filters.networkId && /^[\d|,]+$/.test(filters.networkId) ? filters.networkId : undefined;
  const certification = isCertificationCap(filters.certification) ? filters.certification : undefined;
  const minVoteCount = filters.minVoteCount && /^\d+$/.test(filters.minVoteCount) ? filters.minVoteCount : undefined;
  const watchProvider = filters.watchProvider && /^[\d|]+$/.test(filters.watchProvider) ? filters.watchProvider : undefined;
  // watch_region only reaches TMDB inside the `if (filters.watchProvider)` branch below,
  // so without a provider the region is a pure cache-key input — 676 accepted codes would
  // each mint a distinct TmdbCache row (and an identical upstream call) for the same
  // response. Drop it when there is no provider so they collapse to one canonical key.
  const rawRegion = filters.watchRegion && /^[A-Za-z]{2}$/.test(filters.watchRegion) ? filters.watchRegion.toUpperCase() : undefined;
  const watchRegion = watchProvider ? rawRegion : undefined;
  // Clamp minRating to its canonical numeric form here so distinct junk strings ("abc",
  // "xyz") collapse to one cache key instead of minting a new TmdbCache row each.
  let minRating: string | undefined;
  if (filters.minRating) {
    const n = parseFloat(filters.minRating);
    minRating = isNaN(n) ? undefined : String(Math.min(10, Math.max(0, n)));
  }
  const normYear = (v: string | undefined): string | undefined => {
    if (!v) return undefined;
    const n = parseInt(v, 10);
    return isNaN(n) || n < 1888 || n > 2100 ? undefined : String(n);
  };
  return {
    ...filters,
    sortBy: allowedDiscoverSort(filters.sortBy),
    genreId,
    keywordId,
    companyId,
    networkId,
    certification,
    minVoteCount,
    watchProvider,
    watchRegion,
    minRating,
    fromYear: normYear(filters.fromYear),
    toYear: normYear(filters.toYear),
  };
}

// The /discover params every media type shares. Every filter was already
// validated/normalized (or dropped) by sanitizeDiscoverFilters, and sortBy is
// allowlisted at entry — no re-parsing needed.
function discoverParams(filters: DiscoverFilters): Record<string, string> {
  const params: Record<string, string> = {
    include_adult: "false",
    sort_by: filters.sortBy ?? "popularity.desc",
  };
  if (filters.genreId)       params["with_genres"] = filters.genreId;
  if (filters.keywordId)     params["with_keywords"] = filters.keywordId;
  if (filters.companyId)     params["with_companies"] = filters.companyId;
  if (filters.minRating)     params["vote_average.gte"] = filters.minRating;
  if (filters.minVoteCount)  params["vote_count.gte"] = filters.minVoteCount;
  if (filters.watchProvider) { params["with_watch_providers"] = filters.watchProvider; params["watch_region"] = filters.watchRegion ?? "US"; }
  return params;
}

export async function discoverMoviesPage(filters: DiscoverFilters, page: number): Promise<PagedResult> {
  const p = clampPage(page);
  // Normalize free-text filters up front so junk values reach neither TMDB nor the cache key.
  filters = sanitizeDiscoverFilters(filters);
  // A TV network means nothing for movies; dropped so it cannot mint a distinct cache key.
  filters = { ...filters, networkId: undefined };
  filters = { ...filters, sortBy: discoverSortFor("movie", filters.sortBy ?? "popularity.desc") };

  const params = discoverParams(filters);
  // US certification cap. TMDB drops titles with no US rating once this is set.
  if (filters.certification) { params["certification_country"] = "US"; params["certification.lte"] = filters.certification; }
  if (filters.fromYear)      params["primary_release_date.gte"] = `${filters.fromYear}-01-01`;
  if (filters.toYear)        params["primary_release_date.lte"] = `${filters.toYear}-12-31`;
  return loadResultPage<RawMovie>(`${discoverKey("movie", filters)}:page:${p}`, "/discover/movie", params, p, normalizeMovie);
}

export async function discoverTVPage(filters: DiscoverFilters, page: number): Promise<PagedResult> {
  const p = clampPage(page);
  // Normalize free-text filters up front so junk values reach neither TMDB nor the cache key.
  filters = sanitizeDiscoverFilters(filters);
  // TMDB cannot cap a TV discover by rating; dropped so it cannot mint a distinct cache key.
  filters = { ...filters, certification: undefined };
  filters = { ...filters, sortBy: discoverSortFor("tv", filters.sortBy ?? "popularity.desc") };

  const params = discoverParams(filters);
  if (filters.networkId)     params["with_networks"] = filters.networkId;
  if (filters.fromYear)      params["first_air_date.gte"] = `${filters.fromYear}-01-01`;
  if (filters.toYear)        params["first_air_date.lte"] = `${filters.toYear}-12-31`;
  return loadResultPage<RawTV>(`${discoverKey("tv", filters)}:page:${p}`, "/discover/tv", params, p, normalizeTV);
}
