// Admin → Download Queue's filtering, as pure functions (download-queue.tsx,
// use-queue-filters.ts): which rows show, the per-tab counts and the stat
// cards, each in one pass. No React; tested in tests/queue-filters.test.mts.
import type { QueueItem } from "@/lib/arr-queue";

export type QueueService = "radarr" | "sonarr";
export type QueueFilter = "all" | "attention" | QueueService;

/** What a row needs for filtering — a QueueItem has more. */
type Row = Pick<QueueItem, "service" | "instance" | "attention" | "mediaTitle" | "title">;

/**
 * The filters that actually apply. A choice whose control is gone — an
 * instance no longer listed (or no instance picker: one instance), a service
 * whose tab is gone — applies nothing, instead of hiding every row behind a
 * control the admin can't see to clear.
 */
export function effectiveQueueFilters(
  chosen: { filter: QueueFilter; instance: string },
  instances: ReadonlyArray<{ service: QueueService; slug: string }>,
): { filter: QueueFilter; instance: string } {
  const services = new Set(instances.map((i) => i.service));
  const filter = chosen.filter === "radarr" || chosen.filter === "sonarr" ? (services.has(chosen.filter) ? chosen.filter : "all") : chosen.filter;
  const instance =
    chosen.instance !== "all" && instances.length > 1 && instances.some((i) => `${i.service}:${i.slug}` === chosen.instance)
      ? chosen.instance
      : "all";
  return { filter, instance };
}

const inTab = (r: Row, filter: QueueFilter) => filter === "all" || (filter === "attention" ? r.attention : r.service === filter);

/** The rows the table shows: the tab, the instance, and the title text. */
export function filterQueueRows<T extends Row>(rows: readonly T[], f: { filter: QueueFilter; instance: string; query: string }): T[] {
  const q = f.query.trim().toLowerCase();
  return rows.filter(
    (r) =>
      inTab(r, f.filter) &&
      (f.instance === "all" || `${r.service}:${r.instance}` === f.instance) &&
      (!q || r.mediaTitle.toLowerCase().includes(q) || r.title.toLowerCase().includes(q)),
  );
}

/** Rows per tab, in one pass. */
export function queueTabCounts(rows: readonly Row[]): Record<QueueFilter, number> {
  const counts: Record<QueueFilter, number> = { all: 0, attention: 0, radarr: 0, sonarr: 0 };
  for (const r of rows) {
    counts.all++;
    if (r.attention) counts.attention++;
    counts[r.service]++;
  }
  return counts;
}

/** The stat cards, in one pass: downloads, how many are downloading, flagged, bytes left. */
export function queueStats(items: ReadonlyArray<Pick<QueueItem, "phase" | "attention" | "sizeLeft">>): {
  total: number;
  downloading: number;
  attention: number;
  sizeLeft: number;
} {
  const stats = { total: 0, downloading: 0, attention: 0, sizeLeft: 0 };
  for (const i of items) {
    stats.total++;
    if (i.phase === "downloading") stats.downloading++;
    if (i.attention) stats.attention++;
    stats.sizeLeft += i.sizeLeft;
  }
  return stats;
}
