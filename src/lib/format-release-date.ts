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
