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
// `timeZone` is the viewer's own unless given (the tests pin one).
export function missingDateFormatters(locale: string, timeZone?: string) {
  const day = new Intl.DateTimeFormat(locale, { dateStyle: "medium", timeZone: "UTC" });
  const aired = new Intl.DateTimeFormat(locale, { dateStyle: "medium", ...(timeZone ? { timeZone } : {}) });
  return {
    day: (iso: string | null) => (iso ? day.format(new Date(iso)) : "—"),
    aired: (iso: string | null) => (iso ? aired.format(new Date(iso)) : "—"),
  };
}
