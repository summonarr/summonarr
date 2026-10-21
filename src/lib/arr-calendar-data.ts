// Admin → Calendar: the data half. One live /api/v3/calendar read per
// configured Radarr and Sonarr instance for the window asked (guardrail 32 —
// every instance; a failed one is named, never read as "nothing airing"),
// alongside a bounded read of the same instance's download queue so a title
// already on its way reads "downloading", not "missing" with a Search button.
// Series TMDB ids Sonarr didn't send are filled from the cached tvdb→tmdb map
// so entries can link to Summonarr's own pages, and series posters come from
// the TMDB core cache (Sonarr's artwork is TheTVDB's, which the CSP blocks).
import { arrErrorKind, arrErrorMessage, arrFetch, resolveTvdbToTmdb, type ArrCfg } from "./arr";
import type { ArrErrorKind } from "./arr-error-kind";
import { configuredArrCfg, enabledArrInstances, type ArrInstanceRef, type ArrService } from "./arr-admin";
import {
  applyCalendarQueue,
  calendarFetchWindow,
  calendarPath,
  calendarQueue,
  radarrCalendarEntries,
  sonarrCalendarEntries,
  sortCalendarEntries,
  type CalendarEntry,
} from "./arr-calendar";
import { settleLimit } from "./concurrency";
import { forgetWarnOnChange, warnOnChange } from "./log-dedup";
import { prisma } from "./prisma";

export interface CalendarReport {
  instances: ArrInstanceRef[];
  errors: Array<{ service: ArrService; instance: string; error: string; kind: ArrErrorKind }>;
  entries: CalendarEntry[];
  /** The server's clock when the report was made: the page's "today" follows it, not the page's first render. */
  now: string;
}

const CONCURRENCY = 4;

// The queue is read only to mark what is downloading, so it is bounded well
// below the Download Queue page's 40 pages: past 1,000 records a title further
// down simply keeps its own status.
export const QUEUE_PAGE_SIZE = 250;
export const MAX_QUEUE_PAGES = 4;

// Exported for its bounds pin (tests/arr-projection-bounds.test.mts).
export async function readQueue(cfg: ArrCfg): Promise<unknown[]> {
  const records: unknown[] = [];
  for (let page = 1; page <= MAX_QUEUE_PAGES; page++) {
    // Unknown items (no title matched) are left out by default — nothing on a
    // calendar could be one.
    const res = await arrFetch<{ records?: unknown; totalRecords?: unknown }>(
      cfg, `/api/v3/queue?page=${page}&pageSize=${QUEUE_PAGE_SIZE}`, { quietErrors: true },
    );
    const batch = Array.isArray(res?.records) ? res.records : [];
    // At most a page's worth per page (an honest arr never sends more), appended
    // one by one: a spread push of a hostile page past ~125k records throws
    // RangeError, and an uncapped page would let one answer outgrow the page cap.
    for (const r of batch.slice(0, QUEUE_PAGE_SIZE)) records.push(r);
    const total = typeof res?.totalRecords === "number" ? res.totalRecords : 0;
    if (batch.length === 0 || page * QUEUE_PAGE_SIZE >= total) break;
  }
  return records;
}

async function readInstance(inst: ArrInstanceRef, start: Date, end: Date, unmonitored: boolean, nowMs: number): Promise<CalendarEntry[]> {
  const cfg = await configuredArrCfg(inst.service, inst.slug);
  const { from, to } = calendarFetchWindow(inst.service, start, end);
  // Read in parallel and never rejecting: a queue that can't be read leaves
  // every status as the calendar has it.
  const queued = readQueue(cfg).then((records) => ({ records }), (err: unknown) => ({ err }));
  const raw = await arrFetch<unknown>(cfg, calendarPath(inst.service, from, to, unmonitored), { quietErrors: true });
  const entries = inst.service === "radarr"
    ? radarrCalendarEntries(inst.slug, raw, from.getTime(), to.getTime(), nowMs)
    : sonarrCalendarEntries(inst.slug, raw, nowMs);
  const queue = await queued;
  // One condition per instance, re-derived on every page load (guardrail 7b).
  // Logged only once the calendar itself was read — a down instance is
  // reported by loadCalendar, not twice.
  const logKey = `arr-calendar:queue:${inst.service}:${inst.slug}`;
  if ("records" in queue) {
    applyCalendarQueue(entries, calendarQueue(inst.service, queue.records));
    forgetWarnOnChange(logKey);
  } else {
    const error = arrErrorMessage(queue.err);
    warnOnChange(logKey, error, `[arr-calendar] ${inst.service} instance "${inst.slug}" queue read failed, statuses shown without downloads: ${error}`);
  }
  return entries;
}

// Cosmetic enrichment: a failure leaves the entry unlinked / without a poster.
async function fillSeriesIds(entries: CalendarEntry[]): Promise<void> {
  const tvdbIds = [...new Set(entries.filter((e) => e.service === "sonarr" && e.tmdbId === null && e.tvdbId !== null).map((e) => e.tvdbId as number))];
  if (tvdbIds.length > 0) {
    try {
      const { map } = await resolveTvdbToTmdb(tvdbIds);
      for (const e of entries) if (e.tmdbId === null && e.tvdbId !== null) e.tmdbId = map.get(e.tvdbId) ?? null;
    } catch (err) {
      console.warn("[arr-calendar] tvdb→tmdb lookup failed:", err instanceof Error ? err.message : err);
    }
  }
  const needPoster = [...new Set(entries.filter((e) => e.posterPath === null && e.tmdbId !== null).map((e) => `${e.service}:${e.tmdbId}`))];
  if (needPoster.length === 0) return;
  const movieIds = needPoster.filter((k) => k.startsWith("radarr:")).map((k) => Number(k.slice(7)));
  const tvIds = needPoster.filter((k) => k.startsWith("sonarr:")).map((k) => Number(k.slice(7)));
  try {
    const rows = await prisma.tmdbMediaCore.findMany({
      where: { OR: [{ mediaType: "MOVIE", tmdbId: { in: movieIds } }, { mediaType: "TV", tmdbId: { in: tvIds } }] },
      select: { tmdbId: true, mediaType: true, posterPath: true },
    });
    const posters = new Map(rows.filter((r) => r.posterPath).map((r) => [`${r.mediaType === "MOVIE" ? "radarr" : "sonarr"}:${r.tmdbId}`, r.posterPath as string]));
    for (const e of entries) if (e.posterPath === null && e.tmdbId !== null) e.posterPath = posters.get(`${e.service}:${e.tmdbId}`) ?? null;
  } catch (err) {
    console.warn("[arr-calendar] poster lookup failed:", err instanceof Error ? err.message : err);
  }
}

export async function loadCalendar(start: Date, end: Date, unmonitored: boolean, now: Date): Promise<CalendarReport> {
  const instances = await enabledArrInstances();
  const nowMs = now.getTime();
  const settled = await settleLimit(instances, CONCURRENCY, (inst) => readInstance(inst, start, end, unmonitored, nowMs));
  const report: CalendarReport = { instances, errors: [], entries: [], now: now.toISOString() };
  settled.forEach((s, i) => {
    const inst = instances[i];
    // The page re-reads as the admin pages through weeks: a down instance is
    // one condition, logged once until it changes (guardrail 7b).
    const logKey = `arr-calendar:${inst.service}:${inst.slug}`;
    if (s.status === "fulfilled") {
      // One by one, never a spread push: each list is capped (MAX_CALENDAR_ENTRIES),
      // and a spread of an upstream-sized one throws RangeError (guardrail 5i).
      for (const e of s.value) report.entries.push(e);
      forgetWarnOnChange(logKey);
      return;
    }
    const error = arrErrorMessage(s.reason);
    report.errors.push({ service: inst.service, instance: inst.slug, error, kind: arrErrorKind(s.reason) });
    warnOnChange(logKey, error, `[arr-calendar] ${inst.service} instance "${inst.slug}" calendar read failed: ${error}`);
  });
  await fillSeriesIds(report.entries);
  sortCalendarEntries(report.entries);
  return report;
}
