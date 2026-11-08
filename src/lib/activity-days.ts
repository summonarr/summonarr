// The admin Activity `?days=` window, parsed ONE way for the server pages, the
// stats/transcode API routes and the filter bar. Pure and zero-import so the
// "use client" filter bar can share it: when it parsed the raw string itself,
// `?days=0` rendered 30 days of data while the bar highlighted "Custom: 0".
// The `source` / `mediaType` filters live here for the same reason: the pages
// and the stats/calendar/transcode routes each carried their own copy.

export const ACTIVITY_DEFAULT_DAYS = 30;
export const ACTIVITY_MIN_DAYS = 1;
export const ACTIVITY_MAX_DAYS = 3650;

/** Clamp a raw `days` value to the window the pages actually query. */
export function parseActivityDays(raw: string | null | undefined): number {
  const n = parseInt(raw ?? "", 10) || ACTIVITY_DEFAULT_DAYS;
  return Math.min(Math.max(n, ACTIVITY_MIN_DAYS), ACTIVITY_MAX_DAYS);
}

export type ActivitySource = "plex" | "jellyfin";
export type ActivityMediaType = "MOVIE" | "TV";

/** The recognised `source` value, or undefined. Exact match: `Plex` is not `plex`. */
export function parseActivitySource(raw: string | null | undefined): ActivitySource | undefined {
  return raw === "plex" || raw === "jellyfin" ? raw : undefined;
}

/** The recognised `mediaType` value, or undefined. */
export function parseActivityMediaType(raw: string | null | undefined): ActivityMediaType | undefined {
  return raw === "MOVIE" || raw === "TV" ? raw : undefined;
}

// Whitelisted BEFORE either value reaches an aggregate: the activity cache key is
// built from them while the SQL filter ignores anything else, so an unknown value
// minted its own key, ran the full uncached scan under a slot nothing would reuse,
// and evicted real entries from the shared activity cache on its way out.
export function parseActivitySourceMediaType(params: { get(name: string): string | null }): {
  source?: ActivitySource;
  mediaType?: ActivityMediaType;
} {
  return {
    source: parseActivitySource(params.get("source")),
    mediaType: parseActivityMediaType(params.get("mediaType")),
  };
}

/** A search param as Next hands it to a page: a repeated key arrives as an array. */
export type PageParam = string | string[] | undefined;

/** The first value of a page search param (a repeated `?a=1&a=2` reads "1"). */
export function firstParam(value: PageParam): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

/** `days` / `source` / `mediaType` for an Activity server page. */
export function parseActivityFilters(sp: { days?: PageParam; source?: PageParam; mediaType?: PageParam }): {
  days: number;
  source?: ActivitySource;
  mediaType?: ActivityMediaType;
} {
  return {
    days: parseActivityDays(firstParam(sp.days)),
    source: parseActivitySource(firstParam(sp.source)),
    mediaType: parseActivityMediaType(firstParam(sp.mediaType)),
  };
}
