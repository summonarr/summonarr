// The geometry of /admin/stats' stacked monthly columns (stats-ui.tsx
// MonthChart): each month's total, its column height against the busiest
// month, and each series' share of the column. Pure and directive-free
// (tests/stats-month-columns.test.mts).

export interface MonthSeries {
  key: string;
  label: string;
  color: string;
  /** One value per month, in the months' order; a missing one is 0. */
  values: readonly number[];
}

export interface MonthColumn {
  month: string;
  /** The month is still filling up: drawn faded and marked, not read as a drop. */
  partial: boolean;
  /** The first column and every January carry the year under the month. */
  showYear: boolean;
  total: number;
  /** The column's height, % of the plot. An empty month keeps a 1% sliver, a month with anything at least 2%. */
  heightPct: number;
  /** Each series with something this month, in the series' order: its share of the column. */
  segments: Array<{ key: string; color: string; pct: number }>;
}

export const monthValue = (s: MonthSeries, i: number): number => s.values[i] ?? 0;

export function monthColumns(months: readonly string[], series: readonly MonthSeries[], currentMonth: string): MonthColumn[] {
  const totals = months.map((_, i) => series.reduce((sum, s) => sum + monthValue(s, i), 0));
  const max = Math.max(1, ...totals);
  return months.map((month, i) => {
    const total = totals[i];
    return {
      month,
      partial: month === currentMonth,
      showYear: i === 0 || month.endsWith("-01"),
      total,
      heightPct: Math.max((total / max) * 100, total > 0 ? 2 : 1),
      segments: series
        .filter((s) => monthValue(s, i) > 0)
        .map((s) => ({ key: s.key, color: s.color, pct: (monthValue(s, i) / Math.max(total, 1)) * 100 })),
    };
  });
}
