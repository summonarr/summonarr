// Admin → Missing: its dates, for the viewer's locale. Pure; every value is a
// server-supplied ISO string (no clock reads — guardrail 16).
//
//   day   — a RELEASE date (Radarr's physical/digital release): a calendar day
//           the arr stores as midnight UTC, so it is formatted in UTC — the day
//           Radarr recorded, not shifted by the viewer's offset.
//   aired — an AIR time (Sonarr's airDateUtc, a series' last airing): a real
//           instant, so it is formatted in the viewer's own time zone — in UTC
//           an episode airing at 21:00 in New York showed the next day.
//
// `timeZone` is the viewer's own unless given: the page never passes one, the
// tests pin one so their expectations don't depend on the machine's zone.
//
// A value that isn't a date reads as a dash, like a missing one: the strings
// come from Radarr/Sonarr, and Intl throws a RangeError on an Invalid Date —
// one malformed row would otherwise take the whole table down with it.

const NO_DATE = "—";

/** Formats an ISO string with `fmt`; null, empty or unparseable → a dash. */
function formatIso(fmt: Intl.DateTimeFormat, iso: string | null): string {
  if (!iso) return NO_DATE;
  const at = new Date(iso);
  return Number.isNaN(at.getTime()) ? NO_DATE : fmt.format(at);
}

/** A calendar day stored as midnight UTC, shown on that UTC day for every viewer. */
export function utcDayFormatter(locale: string): (iso: string | null) => string {
  const fmt = new Intl.DateTimeFormat(locale, { dateStyle: "medium", timeZone: "UTC" });
  return (iso) => formatIso(fmt, iso);
}

export function missingDateFormatters(locale: string, timeZone?: string) {
  const aired = new Intl.DateTimeFormat(locale, { dateStyle: "medium", ...(timeZone ? { timeZone } : {}) });
  return {
    day: utcDayFormatter(locale),
    aired: (iso: string | null) => formatIso(aired, iso),
  };
}
