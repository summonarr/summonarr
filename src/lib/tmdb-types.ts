
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
  requested?: boolean;
  requestedByMe?: boolean;
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
  trailerUrl?: string | null;

  trailerKey?: string | null;
  collectionId?: number | null;
  collectionName?: string | null;

  seasons?: TmdbSeason[];

  genres?: string[];
  studios?: string[];
  tagline?: string | null;
  status?: string | null;
  runtime?: number | null;
  numberOfSeasons?: number | null;
  numberOfEpisodes?: number | null;
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
  imdbRating?: string | null;
  rottenTomatoes?: string | null;
  rtAudienceScore?: string | null;
  metacritic?: string | null;
  traktRating?: string | null;
  letterboxdRating?: string | null;
  mdblistScore?: string | null;
  malRating?: string | null;
  rogerEbertRating?: string | null;
}

export interface PersonDetails {
  id: number;
  name: string;
  profilePath: string | null;
  knownForDepartment: string;
  credits: PersonCredit[];
}

export interface Genre {
  id: number;
  name: string;
}

export interface DiscoverFilters {
  genreId?: string;
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
