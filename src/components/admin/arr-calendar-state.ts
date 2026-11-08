// The Admin → Calendar page's reading of what the server sends
// (arr-calendar.tsx): the calendar report, checked before it is drawn, and a
// Search's answer turned into the cell's state. Pure — the unit suite drives
// it (tests/arr-calendar-state.test.mts).

import { check, v, type Infer, type Schema } from "@/lib/validate";
import type { FetchJsonResult } from "@/lib/client/fetch-json";
import type { CalendarEntry } from "@/lib/arr-calendar";

const Service = v.literal("radarr", "sonarr");

// Every field the page reads from an entry. Typed as the server's
// CalendarEntry, so a field added there and not here fails to compile (the
// checked copy keeps only the fields declared).
export const CalendarEntrySchema: Schema<CalendarEntry> = v.object({
  key: v.string(),
  service: Service,
  instance: v.string(),
  kind: v.literal("episode", "cinema", "physical", "digital"),
  date: v.string(),
  arrId: v.int(),
  episodeId: v.nullable(v.int()),
  title: v.string(),
  year: v.nullable(v.int()),
  tmdbId: v.nullable(v.int()),
  tvdbId: v.nullable(v.int()),
  posterPath: v.nullable(v.string()),
  seasonNumber: v.nullable(v.int()),
  episodeNumber: v.nullable(v.int()),
  episodeTitle: v.nullable(v.string()),
  finaleType: v.nullable(v.string()),
  network: v.nullable(v.string()),
  monitored: v.boolean(),
  hasFile: v.boolean(),
  status: v.literal("downloaded", "downloading", "missing", "airing", "aired", "unmonitored", "upcoming", "released"),
  progress: v.nullable(v.number()),
  attention: v.boolean(),
});

/**
 * GET /api/admin/arr/calendar's answer (and a snapshot of it): the instances
 * read, the ones that failed (`kind` is shown through isArrErrorKind, so an
 * unknown one reads as "other"), the entries, and the server's clock.
 */
export const CalendarReportSchema = v.object({
  instances: v.array(v.object({ service: Service, slug: v.string(), name: v.string() })),
  errors: v.array(v.object({ service: Service, instance: v.string(), kind: v.string() })),
  entries: v.array(CalendarEntrySchema),
  now: v.string(),
});

export type CalendarReport = Infer<typeof CalendarReportSchema>;

/** One Search button's state. */
export type SearchState =
  | { phase: "busy" }
  | { phase: "started" }
  | { phase: "nothing" }
  | { phase: "failed"; message: string };

const NothingMissing = v.object({ nothingMissing: v.optional(v.boolean()) });

/**
 * What a Search's answer leaves on the cell. The search is re-judged live on
 * the server: only the route's nothing-missing 409 means "nothing left to look
 * for" — its other 409s (an episode id no longer on the series after a Sonarr
 * refresh, the arr's own refusal) are failures with the route's own message,
 * and the Search button stays. No answer at all (a hang, a dropped connection)
 * fails with `fallback`, so the spinner always ends.
 */
export function searchOutcome(res: FetchJsonResult<unknown>, fallback: string): SearchState {
  if (res.ok) return { phase: "started" };
  if (res.kind === "http") {
    const body = check(NothingMissing, res.body);
    if (res.status === 409 && body.ok && body.value.nothingMissing === true) return { phase: "nothing" };
    return { phase: "failed", message: res.error || fallback };
  }
  return { phase: "failed", message: fallback };
}
