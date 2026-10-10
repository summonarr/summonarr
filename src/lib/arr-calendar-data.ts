// Admin → Calendar: the data half. One live /api/v3/calendar read per
// configured Radarr and Sonarr instance for the window asked (guardrail 32 —
// every instance; a failed one is named, never read as "nothing airing").
// Series TMDB ids Sonarr didn't send are filled from the cached tvdb→tmdb map
// so entries can link to Summonarr's own pages, and series posters come from
// the TMDB core cache (Sonarr's artwork is TheTVDB's, which the CSP blocks).
import { arrErrorMessage, arrFetch, resolveTvdbToTmdb } from "./arr";
import { configuredArrCfg, enabledArrInstances, type ArrInstanceRef, type ArrService } from "./arr-admin";
import { radarrCalendarEntries, sonarrCalendarEntries, sortCalendarEntries, type CalendarEntry } from "./arr-calendar";
import { settleLimit } from "./concurrency";
import { forgetWarnOnChange, warnOnChange } from "./log-dedup";
import { prisma } from "./prisma";

export interface CalendarReport {
  instances: ArrInstanceRef[];
  errors: Array<{ service: ArrService; instance: string; error: string }>;
  entries: CalendarEntry[];
}

const CONCURRENCY = 4;

const DAY_MS = 86_400_000;

async function readInstance(inst: ArrInstanceRef, start: Date, end: Date, unmonitored: boolean, nowMs: number): Promise<CalendarEntry[]> {
  const cfg = await configuredArrCfg(inst.service, inst.slug);
  // A movie's release date is a calendar DATE (midnight UTC), while the window
  // is the viewer's local days: pad Radarr's by a day either side so a date on
  // the window's edge in any time zone comes back; the page keeps the ones
  // inside its own days.
  const from = inst.service === "radarr" ? new Date(start.getTime() - DAY_MS) : start;
  const to = inst.service === "radarr" ? new Date(end.getTime() + DAY_MS) : end;
  const q = new URLSearchParams({ start: from.toISOString(), end: to.toISOString(), unmonitored: String(unmonitored) });
  if (inst.service === "sonarr") {
    q.set("includeSeries", "true");
    q.set("includeEpisodeFile", "false");
    q.set("includeEpisodeImages", "false");
  }
  const raw = await arrFetch<unknown>(cfg, `/api/v3/calendar?${q.toString()}`, { quietErrors: true });
  return inst.service === "radarr"
    ? radarrCalendarEntries(inst.slug, raw, from.getTime(), to.getTime(), nowMs)
    : sonarrCalendarEntries(inst.slug, raw, nowMs);
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
  const report: CalendarReport = { instances, errors: [], entries: [] };
  settled.forEach((s, i) => {
    const inst = instances[i];
    // The page re-reads as the admin pages through weeks: a down instance is
    // one condition, logged once until it changes (guardrail 7b).
    const logKey = `arr-calendar:${inst.service}:${inst.slug}`;
    if (s.status === "fulfilled") {
      report.entries.push(...s.value);
      forgetWarnOnChange(logKey);
      return;
    }
    const error = arrErrorMessage(s.reason);
    report.errors.push({ service: inst.service, instance: inst.slug, error });
    warnOnChange(logKey, error, `[arr-calendar] ${inst.service} instance "${inst.slug}" calendar read failed: ${error}`);
  });
  await fillSeriesIds(report.entries);
  sortCalendarEntries(report.entries);
  return report;
}
