// A release date for the detail pages' Release dates section.
//
// MDBList's released_digital and the TMDB dates are DATE-ONLY strings
// ("2024-05-01"), which `new Date` parses as UTC midnight. Formatting them in
// the server's local zone (any TZ west of UTC — a US-zoned compose stack,
// `next dev` on a US laptop) renders the PREVIOUS day, so the date is formatted
// in UTC, the same convention wrapped-view / activity-calendar / my-stats-view
// already use. Returns null for a missing or unparseable value so the caller
// drops it instead of printing "Invalid Date".
export function formatReleaseDate(value: string | null | undefined, locale: string = "en-US"): string | null {
  if (!value) return null;
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return null;
  return date.toLocaleDateString(locale, { month: "short", day: "numeric", year: "numeric", timeZone: "UTC" });
}

// How far the Upcoming lists' "today" trails the UTC clock. TMDB release dates
// are bare local dates and the server runs in UTC (the image sets no TZ), so
// cutting at the UTC date dropped a title releasing TODAY from Upcoming every
// evening west of UTC — from about 4–8pm across the Americas. Trailing by 12
// hours keeps a same-day release listed through the evening there; the cost is
// that a title lingers until noon UTC the day after its release.
export const UPCOMING_CUTOFF_LAG_MS = 12 * 60 * 60 * 1000;

// The earliest release date ("YYYY-MM-DD") the Upcoming page and GET
// /api/upcoming still list. One helper so the page and the route keep
// returning the same list. Server-side only in practice (it reads the clock).
export function upcomingCutoffDate(now: number = Date.now()): string {
  return new Date(now - UPCOMING_CUTOFF_LAG_MS).toISOString().slice(0, 10);
}
