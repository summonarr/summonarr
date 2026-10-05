
export type MediaType = "movie" | "tv";

// All optional badge/rating fields are undefined when not yet attached rather than false/null so
// callers can distinguish "not fetched yet" from "fetched and absent".
export interface TmdbMedia {
  id: number;
  mediaType: MediaType;
  title: string;
  overview: string;
  posterPath: string | null;
  backdropPath: string | null;
  releaseDate: string | null;
  releaseYear: string | null;
  voteAverage: number;
  voteCount?: number;
  certification?: string;
  plexAvailable?: boolean;
  jellyfinAvailable?: boolean;
  arrPending?: boolean;
  // 4K-instance state, only populated when the viewer has 4K access (see getShow4kVisibility).
  // arr4kAvailable = the 4K Radarr/Sonarr has the file; arr4kPending = wanted but not yet fetched.
  arr4kPending?: boolean;
  arr4kAvailable?: boolean;
  // Per-instance availability for ALL configured Radarr/Sonarr instances
  // (multi-instance support), keyed by instance slug ("" = default, "4k", named).
  // Additive superset of arrPending/arr4k* — a named-instance UI reads this map.
  // Populated by attachArrPending; absent ⇒ no instance rows for this title.
  arrInstances?: Record<string, { pending: boolean; available: boolean }>;
  requested?: boolean;
  requestedByMe?: boolean;
  // Admin-blacklisted: the title is shown but cannot be requested (the request POST
  // 403s). Set by attachAllAvailability; absent ⇒ requestable.
  blacklisted?: boolean;
  imdbId?: string | null;
  imdbRating?: string | null;
  imdbVotes?: string | null;
  rottenTomatoes?: string | null;
  metacritic?: string | null;
  rtAudienceScore?: string | null;
  traktRating?: string | null;
  letterboxdRating?: string | null;
  mdblistScore?: string | null;
  malRating?: string | null;
  rogerEbertRating?: string | null;
  releasedDigital?: string | null;
  // Movies only, from TMDB release types 4/5 (home-release-dates.ts). Absent ⇒
  // not fetched yet (a row cached before these existed); null ⇒ TMDB has none.
  digitalReleaseDate?: string | null;
  physicalReleaseDate?: string | null;
  trailerUrl?: string | null;

  trailerKey?: string | null;
  collectionId?: number | null;
  collectionName?: string | null;

  seasons?: TmdbSeason[];

  genres?: string[];
  // Same genres as `genres`, but with TMDB ids retained so native clients can
  // deep-link into filtered browse. `genres` (names) stays for back-compat.
  genreList?: { id: number; name: string }[];
  studios?: string[];
  tagline?: string | null;
  status?: string | null;
  runtime?: number | null;
  numberOfSeasons?: number | null;
  numberOfEpisodes?: number | null;

  // Extended detail metadata (populated on the single-title detail path).
  originalTitle?: string | null;
  originalLanguage?: string | null;
  spokenLanguages?: string[];
  productionCountries?: string[];
  // ISO 3166-1 codes for the same origin data (productionCountries holds
  // DISPLAY names) — the anime auto-route predicate matches "JP" against these.
  originCountryCodes?: string[];
  // ISO codes for `productionCountries`, index-aligned, so the detail page can
  // name the country in the viewer's language — ONLY through
  // localizedProductionCountry below, which keeps TMDB's English name where Intl
  // disagrees with it. Absent on rows cached before it existed.
  productionCountryCodes?: string[];
  homepage?: string | null;
  budget?: number | null;
  revenue?: number | null;
  keywords?: string[];
  // Same keywords as `keywords`, but with TMDB ids retained so native clients can
  // deep-link into filtered browse. `keywords` (names) stays for back-compat.
  keywordList?: { id: number; name: string }[];
  watchProviders?: { type: "stream" | "rent" | "buy"; name: string; logoPath: string | null }[];
  tvdbId?: number | null;
  // TV cadence
  lastAirDate?: string | null;
  inProduction?: boolean | null;
  tvType?: string | null;
  nextEpisodeAirDate?: string | null;

  // Why the For You engine picked this title: the strongest seed (something the
  // viewer watched or watchlisted) that surfaced it, and how many seeds agreed.
  // Set ONLY on the recommendation read path (getUserRecommendations); every
  // other discovery surface leaves it undefined, which is how the UI knows not
  // to render a "Because you watched…" line outside /for-you.
  recommendedBecause?: {
    tmdbId: number;
    title: string;
    mediaType: MediaType;
    // TRENDING never appears here: fallback rows carry no reason title, so the
    // read path's all-four-non-null gate keeps this object absent for them —
    // they surface through fromTrendingFallback below instead.
    source: "WATCH_HISTORY" | "WATCHLIST" | "REQUEST" | "TRENDING";
    seedCount: number;
    // EVERY seed that surfaced it, strongest first (the fields above are the
    // first entry), capped at MAX_REASON_SEEDS — seedCount is the true total.
    // Absent on rows written before the list was stored.
    seeds?: {
      tmdbId: number;
      title: string;
      mediaType: MediaType;
      source: "WATCH_HISTORY" | "WATCHLIST" | "REQUEST";
    }[];
  };

  // Set on cold-start fallback rows only (reasonSource TRENDING): the title is
  // here because it is popular right now, not because the engine matched it to
  // the viewer's taste. The UI labels it honestly and withholds match chips.
  fromTrendingFallback?: boolean;

  // How strongly the For You engine rates this pick, as a band rather than a
  // raw score — the score is a sum of seed weights whose magnitude depends on
  // how much history a viewer has, so it is meaningless to show and impossible
  // to compare between people. Set alongside recommendedBecause on the
  // recommendation read path only; absent means "not in a labelled band", which
  // is the majority of a 200-title shelf and renders no chip.
  matchTier?: "top" | "strong";
}

export interface TmdbSeason {
  seasonNumber: number;
  episodeCount: number;
  airDate: string | null;
  posterPath: string | null;
  name: string;
  overview: string;
}

export interface TmdbEpisode {
  episodeNumber: number;
  seasonNumber: number;
  name: string;
  overview: string;
  airDate: string | null;
  stillPath: string | null;
  runtime: number | null;
  voteAverage: number;
}

export interface CastMember {
  id: number;
  name: string;
  character: string;
  profilePath: string | null;
}

export interface PersonCredit {
  id: number;
  mediaType: MediaType;
  title: string;
  posterPath: string | null;
  releaseYear: string;
  character: string;
  voteAverage: number;
  plexAvailable?: boolean;
  jellyfinAvailable?: boolean;
  arrPending?: boolean;
  requested?: boolean;
  requestedByMe?: boolean;
  blacklisted?: boolean;
  imdbRating?: string | null;
  rottenTomatoes?: string | null;
  rtAudienceScore?: string | null;
  metacritic?: string | null;
  traktRating?: string | null;
  letterboxdRating?: string | null;
  mdblistScore?: string | null;
  malRating?: string | null;
  rogerEbertRating?: string | null;
  imdbId?: string | null;
  imdbVotes?: string | null;
  // Set by getEnrichedPerson so a filmography card can request without a token round-trip.
  requestToken?: string;
}

export interface PersonDetails {
  id: number;
  name: string;
  profilePath: string | null;
  knownForDepartment: string;
  biography: string;
  birthday: string | null;
  deathday: string | null;
  placeOfBirth: string | null;
  credits: PersonCredit[];
}

export interface Genre {
  id: number;
  name: string;
}

export interface DiscoverFilters {
  genreId?: string;
  keywordId?: string;
  minRating?: string;
  minVoteCount?: string;
  fromYear?: string;
  toYear?: string;
  sortBy?: string;
  watchProvider?: string;
  watchRegion?: string;
}

export interface WatchProvider {
  provider_id: number;
  provider_name: string;
  logo_path: string | null;
}

const IMAGE_BASE = "https://image.tmdb.org/t/p";

// Paths that don't start with "/" are invalid TMDB paths (e.g. empty strings from older cache rows)
export function posterUrl(path: string | null, size: "w342" | "w500" | "original" = "w342") {
  return path && path.startsWith("/") ? `${IMAGE_BASE}/${size}${path}` : null;
}

export function backdropUrl(path: string | null, size: "w780" | "original" = "w780") {
  return path && path.startsWith("/") ? `${IMAGE_BASE}/${size}${path}` : null;
}

export function stillUrl(path: string | null, size: "w185" | "w300" | "original" = "w300") {
  return path && path.startsWith("/") ? `${IMAGE_BASE}/${size}${path}` : null;
}

// ISO code → display name in `locale` (English by default), or null when Intl
// has no name for the code — callers put their own fallback behind `??`.
// Intl.DisplayNames exists in both Node and the browser, but call these from
// SERVER code only when rendering: Node's and the browser's ICU data can word a
// name differently, which would be a hydration mismatch (guardrail 16).
// One formatter per (type, locale), built lazily and reused.
const _displayNames = new Map<string, Intl.DisplayNames>();
function displayName(type: "language" | "region", code: string, locale: string): string | null {
  try {
    let dn = _displayNames.get(`${type}:${locale}`);
    if (!dn) {
      dn = new Intl.DisplayNames([locale], { type });
      _displayNames.set(`${type}:${locale}`, dn);
    }
    const name = dn.of(type === "region" ? code.toUpperCase() : code);
    // Intl echoes an unknown code back unchanged. That is not a name: returned
    // as one it defeated every `?? fallback` behind these helpers, and the
    // detail pages showed a bare "XC" where TMDB had "Czechoslovakia".
    if (!name || name === code || name === code.toUpperCase()) return null;
    // Several languages write language names in lower case ("français",
    // "español"); these are shown as standalone labels, so start upper-case.
    return name.charAt(0).toLocaleUpperCase(locale) + name.slice(1);
  } catch {
    return null; // a malformed code (Intl throws RangeError) has no name either
  }
}

export function languageName(code: string | null | undefined, locale = "en"): string | null {
  return code ? displayName("language", code, locale) : null;
}

export function regionName(code: string | null | undefined, locale = "en"): string | null {
  return code ? displayName("region", code, locale) : null;
}

// ICU re-targets a deprecated region code at its successor state (SU → RU,
// YU/CS → RS, AN → CW, BU → MM, ZR → CD, TP → TL), so Intl names such a code
// after a DIFFERENT country than TMDB files under it. True for those codes, and
// for one Intl cannot canonicalize at all.
function regionCodeRetargeted(code: string): boolean {
  const tag = `und-${code.toUpperCase()}`;
  try {
    return Intl.getCanonicalLocales(tag)[0] !== tag;
  } catch {
    return true;
  }
}

/**
 * The production country at `index` as the detail pages name it.
 *
 * TMDB's own `production_countries[].name` is the authoritative label, and an
 * English viewer gets it unchanged (guardrail 40a: the English path is
 * byte-identical to the cached payload). Another language gets Intl's name for
 * the ISO code ONLY when Intl and TMDB agree on which country the code denotes:
 * - a code Intl has no name for (TMDB's "XC" Czechoslovakia, "XG" East Germany)
 *   keeps TMDB's English name;
 * - a code ICU has re-targeted at a successor ("SU" → Russia, "YU" → Serbia,
 *   "AN" → Curaçao, "BU" → Myanmar, "ZR" → Congo) keeps TMDB's English name,
 *   unless Intl's English name already matches TMDB's;
 * - everything else is translated — including where the two merely WORD one
 *   country differently ("United States of America" vs "United States").
 * Returns null when there is nothing to show, so the row is omitted. Server
 * code only (see displayName).
 */
export function localizedProductionCountry(
  media: Pick<TmdbMedia, "productionCountries" | "productionCountryCodes">,
  locale: string,
  index = 0,
): string | null {
  const tmdbName = media.productionCountries?.[index] ?? null;
  const code = media.productionCountryCodes?.[index];
  if (!code || locale === "en") return tmdbName;
  if (tmdbName !== null) {
    const english = regionName(code, "en");
    if (english === null) return tmdbName;
    if (english !== tmdbName && regionCodeRetargeted(code)) return tmdbName;
  }
  return regionName(code, locale) ?? tmdbName;
}
