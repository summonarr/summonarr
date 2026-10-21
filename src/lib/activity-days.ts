// The admin Activity `?days=` window, parsed ONE way for the server pages, the
// stats/transcode API routes and the filter bar. Pure and zero-import so the
// "use client" filter bar can share it: when it parsed the raw string itself,
// `?days=0` rendered 30 days of data while the bar highlighted "Custom: 0".

export const ACTIVITY_DEFAULT_DAYS = 30;
export const ACTIVITY_MIN_DAYS = 1;
export const ACTIVITY_MAX_DAYS = 3650;

/** Clamp a raw `days` value to the window the pages actually query. */
export function parseActivityDays(raw: string | null | undefined): number {
  const n = parseInt(raw ?? "", 10) || ACTIVITY_DEFAULT_DAYS;
  return Math.min(Math.max(n, ACTIVITY_MIN_DAYS), ACTIVITY_MAX_DAYS);
}
