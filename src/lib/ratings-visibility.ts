// Per-source rating-badge visibility (pure helpers — safe for server and client).
// The admin hides sources via the `ratingsHiddenSources` Setting (a JSON array
// of the keys below); RatingsBar consumes them through the client provider in
// components/media/ratings-visibility.tsx.

export const RATING_SOURCES = [
  { key: "imdb", label: "IMDb" },
  { key: "rottenTomatoes", label: "Rotten Tomatoes" },
  { key: "rtAudience", label: "RT Audience" },
  { key: "metacritic", label: "Metacritic" },
  { key: "trakt", label: "Trakt" },
  { key: "letterboxd", label: "Letterboxd" },
  { key: "mdblist", label: "MDBList" },
  { key: "mal", label: "MyAnimeList" },
  { key: "rogerEbert", label: "Roger Ebert" },
  { key: "tmdb", label: "TMDB" },
  { key: "jellyfin", label: "Jellyfin" },
] as const;

export type RatingSourceKey = (typeof RATING_SOURCES)[number]["key"];

// Defensive parse of the Setting value — anything malformed means "hide nothing".
export function parseHiddenRatingSources(raw: string | null | undefined): string[] {
  if (!raw) return [];
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    const valid = new Set<string>(RATING_SOURCES.map((s) => s.key));
    return parsed.filter((v): v is string => typeof v === "string" && valid.has(v));
  } catch {
    return [];
  }
}
