// The pure half of the Activity line charts (activity-charts.tsx): which point
// a pointer or a key is on, what the tooltip says about it, and where the
// tooltip fits on screen. No React, no DOM, no clock, so the unit suite drives
// it directly (tests/activity-chart-math.test.mts).

/** The data index nearest a pointer at `clientX` over a chart spanning [left, left + width]. */
export function nearestIndex(clientX: number, left: number, width: number, count: number): number {
  if (count < 2 || !(width > 0)) return 0;
  const t = Math.max(0, Math.min(1, (clientX - left) / width));
  return Math.round(t * (count - 1));
}

/** Where `index` sits along the chart, 0..1 (the snapped point, not the pointer). */
export function indexFraction(index: number, count: number): number {
  return count < 2 ? 0 : index / (count - 1);
}

/** The index an arrow/Home/End key moves to, or null when the key isn't one. */
export function keyedIndex(key: string, current: number | null, count: number): number | null {
  if (count <= 0) return null;
  const last = count - 1;
  switch (key) {
    case "ArrowLeft":
    case "ArrowDown":
      return current === null ? last : Math.max(0, current - 1);
    case "ArrowRight":
    case "ArrowUp":
      return current === null ? 0 : Math.min(last, current + 1);
    case "Home":
      return 0;
    case "End":
      return last;
    default:
      return null;
  }
}

/** Sum, min, max and mean of a series, read once per series (not per hover). */
export interface SeriesStats {
  total: number;
  min: number;
  max: number;
  avg: number;
}

export function seriesStats(data: readonly number[]): SeriesStats {
  let total = 0;
  let min = Infinity;
  let max = -Infinity;
  for (const v of data) {
    total += v;
    if (v < min) min = v;
    if (v > max) max = v;
  }
  if (data.length === 0) return { total: 0, min: 0, max: 0, avg: 0 };
  return { total, min, max, avg: total / data.length };
}

/**
 * Where point `i` sits in its series, for the tooltip: its share of the total
 * (a fraction), how far it is from the mean and from the previous point (both
 * fractions; null when there is nothing to compare against), and the raw
 * change from the previous point.
 */
export interface PointDetail {
  share: number;
  vsAvg: number | null;
  delta: number | null;
  vsPrev: number | null;
}

export function pointDetail(data: readonly number[], i: number, stats: SeriesStats): PointDetail {
  const value = data[i] ?? 0;
  const prev = i > 0 && i - 1 < data.length ? data[i - 1] : null;
  return {
    share: stats.total > 0 ? value / stats.total : 0,
    vsAvg: stats.avg > 0 ? (value - stats.avg) / stats.avg : null,
    delta: prev !== null ? value - prev : null,
    vsPrev: prev !== null && prev !== 0 ? (value - prev) / prev : null,
  };
}

/** Up, down or level: the colour and arrow a signed change gets. */
export function trendOf(n: number): "up" | "down" | "flat" {
  return n > 0 ? "up" : n < 0 ? "down" : "flat";
}

/**
 * The fixed-position top-left of a tooltip `size` wide and high, centred on
 * `anchor.x` and `gap` above `anchor.top` — or `gap` below `anchor.bottom`
 * when it doesn't fit above but does below. Kept `margin` inside the viewport
 * horizontally by its REAL width (a wide tooltip is never cut off by an edge).
 */
export function placeTooltip(
  anchor: { x: number; top: number; bottom: number },
  size: { w: number; h: number },
  viewport: { w: number; h: number },
  gap: number,
  margin = 8,
): { left: number; top: number; below: boolean } {
  const half = size.w / 2;
  const minX = margin + half;
  const maxX = Math.max(minX, viewport.w - margin - half);
  const left = Math.min(Math.max(anchor.x, minX), maxX) - half;
  const above = anchor.top - gap - size.h;
  const below = above < margin && anchor.bottom + gap + size.h <= viewport.h - margin;
  return { left, top: below ? anchor.bottom + gap : above, below };
}

/** The "x,y x,y …" list an SVG polyline takes, x stepping evenly across `width`. */
export function polylinePoints(data: readonly number[], width: number, yFor: (v: number) => number): string {
  const step = data.length > 1 ? width / (data.length - 1) : 0;
  return data.map((v, i) => `${(i * step).toFixed(2)},${yFor(v).toFixed(2)}`).join(" ");
}

/** The 7 × 24 heatmap cell an arrow / Home / End key moves to, or null for any other key. */
export function heatmapKeyTarget(key: string, r: number, c: number): { r: number; c: number } | null {
  switch (key) {
    case "ArrowLeft":
      return { r, c: Math.max(0, c - 1) };
    case "ArrowRight":
      return { r, c: Math.min(23, c + 1) };
    case "ArrowUp":
      return { r: Math.max(0, r - 1), c };
    case "ArrowDown":
      return { r: Math.min(6, r + 1), c };
    case "Home":
      return { r, c: 0 };
    case "End":
      return { r, c: 23 };
    default:
      return null;
  }
}

/**
 * The drill-down query for heatmap cell (row r, hour c). Matrix rows are
 * Mon-first (0=Mon..6=Sun) and Postgres DOW is 0=Sun..6=Sat, so the day is
 * (r + 1) % 7 — the inverse of the (dow + 6) % 7 fold that builds the matrix
 * (toHeatmapMatrix). The scope matches getHeatmapCellDetail's: `days` for the
 * admin grid, `userId` (all history) for a person's.
 */
export function heatmapDetailQuery(
  base: { userId?: string; source?: string; mediaType?: string; days?: number },
  r: number,
  c: number,
): string {
  const params = new URLSearchParams({ mode: "hour", dow: String((r + 1) % 7), hour: String(c) });
  if (base.userId) params.set("userId", base.userId);
  if (base.source) params.set("source", base.source);
  if (base.mediaType) params.set("mediaType", base.mediaType);
  if (base.days) params.set("days", String(base.days));
  return params.toString();
}
