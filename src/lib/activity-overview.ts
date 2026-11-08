// Pure builders behind the Activity overview's KPI strip, heatmap sentence,
// stream/media mixes, chart axis and Plex reachability chips. Zero-import, so
// the unit suite loads it directly (tests/activity-overview.test.mts).

export type KpiDelta = { text: string; dir: "up" | "down" | "flat" } | null;

/**
 * Change versus the previous period for a KPI cell: `newLabel` when the
 * previous period had nothing, otherwise a rounded percentage with an
 * up/down/flat arrow. Compare UNROUNDED values: rounding hours first read a
 * 0.4h previous period as "new" and 1.4h → 1.6h as +100%. `complete` =
 * stats.prevPeriod.complete: false when play history doesn't cover the previous
 * window (tracking began, or retention purged, inside it), so a delta would
 * compare against a gap. None is shown then.
 */
export function kpiDelta(newLabel: string, current: number, previous: number, complete: boolean): KpiDelta {
  if (!complete) return null;
  if (previous === 0 && current === 0) return null;
  if (previous === 0) return { text: newLabel, dir: "up" };
  const pct = Math.round(((current - previous) / previous) * 100);
  if (pct === 0) return { text: "0%", dir: "flat" };
  return { text: `${Math.abs(pct)}%`, dir: pct > 0 ? "up" : "down" };
}

/** The busiest cell of a day×hour matrix (first one wins a tie), or null when every cell is 0. */
export function heatmapPeak(matrix: readonly (readonly number[])[]): { row: number; hour: number; value: number } | null {
  let peak: { row: number; hour: number; value: number } | null = null;
  for (let row = 0; row < matrix.length; row++) {
    const cells = matrix[row];
    for (let hour = 0; hour < cells.length; hour++) {
      if (cells[hour] > (peak?.value ?? 0)) peak = { row, hour, value: cells[hour] };
    }
  }
  return peak;
}

/**
 * Indices of up to five evenly spaced axis labels over `n` points — never more
 * than there are points, or a custom 2–4 day window prints the same date twice.
 * None for fewer than two points.
 */
export function axisLabelIndices(n: number): number[] {
  if (n <= 1) return [];
  const count = Math.min(5, n);
  const out: number[] = [];
  for (let i = 0; i < count; i++) out.push(Math.round((i / (count - 1)) * (n - 1)));
  return out;
}

export interface MixRow {
  label: string;
  color: string;
  value: string;
  pct: number;
}

/** A share list, largest first, each row's percentage of the total rounded. */
export function buildMix<R extends { count: number }>(
  rows: readonly R[],
  describe: (row: R) => { label: string; color: string },
  formatCount: (n: number) => string,
): MixRow[] {
  const total = rows.reduce((a, r) => a + r.count, 0);
  return [...rows]
    .sort((a, b) => b.count - a.count)
    .map((r) => ({
      ...describe(r),
      value: formatCount(r.count),
      pct: total > 0 ? Math.round((r.count / total) * 100) : 0,
    }));
}

/**
 * The calendar's totals. Its rows are GROUP BY date over the last 365 days, so
 * every row already has count > 0 — activeDays is the row count, total their
 * sum. (A consecutive-day "streak" can't be derived without the empty days.)
 */
export function calendarTotals(rows: readonly { count: number }[]): { totalPlays: number; activeDays: number } {
  let totalPlays = 0;
  let activeDays = 0;
  for (const d of rows) {
    totalPlays += d.count;
    if (d.count > 0) activeDays++;
  }
  return { totalPlays, activeDays };
}

export interface PlexReachabilityChip {
  instance: string;
  name: string;
  reachable: boolean | null;
}

/**
 * Each Plex server's reachability chip, worked out PER SERVER against its OWN
 * url and token: an unconfigured named server stays "unknown" (no chip) instead
 * of borrowing the default server's answer. The stored flag is trusted only
 * while the poller that maintains it runs (`trackingLive`: play history and the
 * Plex source on); otherwise it is stale. A malformed snapshot reads as unknown.
 *
 * `keys` names each instance's three Setting keys; `settings` holds the url and
 * reachability values, `tokenKeys` the admin-token keys that are non-empty.
 */
export function plexReachability(
  instances: readonly { slug: string; name: string }[],
  keys: (slug: string) => { url: string; token: string; reachable: string },
  settings: ReadonlyMap<string, string>,
  tokenKeys: ReadonlySet<string>,
  trackingLive: boolean,
): PlexReachabilityChip[] {
  return instances.map((inst) => {
    const k = keys(inst.slug);
    const configured = !!settings.get(k.url) && tokenKeys.has(k.token);
    let reachable: boolean | null = null;
    const raw = settings.get(k.reachable);
    if (configured && trackingLive && raw) {
      try {
        const parsed: unknown = JSON.parse(raw);
        const flag = parsed && typeof parsed === "object" ? (parsed as { reachable?: unknown }).reachable : undefined;
        if (typeof flag === "boolean") reachable = flag;
      } catch { /* leave null = unknown */ }
    }
    // The registry names the default instance "Default", which would render
    // "Default unreachable" on a single-server deployment where it has always
    // said "Plex" (guardrail 35). Label the default bare, qualify named servers.
    const name = inst.slug === "" ? "Plex" : `Plex (${inst.name})`; // brand + server name, not translated
    return { instance: inst.slug, name, reachable };
  });
}
