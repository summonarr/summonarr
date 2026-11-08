// Admin → Missing (missing-report.tsx): what the lists show and how a list's
// key reads. Pure, no "use client", so the unit suite drives it
// (tests/missing-report-rules.test.mts).
import { v } from "@/lib/validate";
import type { Mode, ReportKey, Service } from "@/components/admin/use-missing-reports";

export type MovieSort = "recent" | "oldest" | "title";
export type SeriesSort = "recent" | "most" | "title";

const KEY_PARTS: Record<ReportKey, { service: Service; mode: Mode }> = {
  "sonarr:missing": { service: "sonarr", mode: "missing" },
  "sonarr:cutoff": { service: "sonarr", mode: "cutoff" },
  "radarr:missing": { service: "radarr", mode: "missing" },
  "radarr:cutoff": { service: "radarr", mode: "cutoff" },
};

/** The service a list belongs to. */
export const serviceOf = (key: ReportKey): Service => KEY_PARTS[key].service;
/** Which of the service's two lists it is. */
export const modeOf = (key: ReportKey): Mode => KEY_PARTS[key].mode;

export type Filters = { showUnmonitored: boolean; instance: string; query: string };
type Filterable = { title: string; instance: string; monitored?: boolean };

export function applyFilters<T extends Filterable>(rows: readonly T[], f: Filters): T[] {
  const q = f.query.trim().toLowerCase();
  return rows.filter((r) =>
    (f.showUnmonitored || r.monitored !== false) &&
    (f.instance === "all" || r.instance === f.instance) &&
    (!q || r.title.toLowerCase().includes(q)),
  );
}

/**
 * The instance filter that applies to the list on screen: the admin's pick
 * while the list still has that instance and offers the picker (two or more
 * instances), else every instance. A refresh can drop the picked instance (it
 * was removed or renamed in settings) or leave one, which hides the picker:
 * keeping the pick would filter out every row with no control left to clear it.
 */
export function shownInstance(picked: string, instances: ReadonlyArray<{ slug: string }> | undefined): string {
  if (picked === "all" || !instances || instances.length < 2) return "all";
  return instances.some((i) => i.slug === picked) ? picked : "all";
}

/** Unmonitored titles among the rows the instance and title filters leave — the population the sibling cards count. */
export function unmonitoredCount(rows: ReadonlyArray<Filterable>, f: Omit<Filters, "showUnmonitored">): number {
  return applyFilters(rows, { ...f, showUnmonitored: true }).filter((r) => r.monitored === false).length;
}

/** A missing-movies list in the admin's order; the server sends the default ("recent"). */
export function sortMovies<T extends { title: string; releasedAt: string }>(rows: T[], sort: MovieSort, locale: string): T[] {
  if (sort === "oldest") rows.sort((a, b) => a.releasedAt.localeCompare(b.releasedAt));
  else if (sort === "title") rows.sort((a, b) => a.title.localeCompare(b.title, locale));
  return rows;
}

/** A missing-series list in the admin's order; the server sends the default ("recent"). */
export function sortSeries<T extends { title: string; missing: number }>(rows: T[], sort: SeriesSort, locale: string): T[] {
  if (sort === "most") rows.sort((a, b) => b.missing - a.missing || a.title.localeCompare(b.title, locale));
  else if (sort === "title") rows.sort((a, b) => a.title.localeCompare(b.title, locale));
  return rows;
}

/** GET /api/admin/missing/episodes: one series' missing episodes. */
export const MissingEpisodesAnswer = v.object({
  episodes: v.array(v.object({ seasonNumber: v.int(), episodeNumber: v.int(), title: v.string(), airDateUtc: v.string() })),
});
