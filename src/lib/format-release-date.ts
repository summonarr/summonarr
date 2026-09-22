// "Digital <date>" for the detail pages' metadata line.
//
// MDBList's released_digital is a DATE-ONLY string ("2024-05-01"), which
// `new Date` parses as UTC midnight. Formatting it in the server's local zone
// (any TZ west of UTC — a US-zoned compose stack, `next dev` on a US laptop)
// renders the PREVIOUS day, so the date is formatted in UTC, the same
// convention wrapped-view / activity-calendar / my-stats-view already use.
// Returns null for a missing or unparseable value so the caller's
// `.filter(Boolean)` drops it instead of printing "Digital Invalid Date".
export function formatDigitalRelease(value: string | null | undefined): string | null {
  if (!value) return null;
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return null;
  return `Digital ${date.toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric", timeZone: "UTC" })}`;
}
