// The 365-day activity calendar's grid, worked out without React so the
// calendar can memoize it and the unit suite can drive it
// (tests/activity-calendar-grid.test.mts). No clock: the window ends on the
// `todayIso` the server sends (guardrail 16).

export interface CalendarDayCount {
  day: string;
  count: number;
}

export interface CalendarCell {
  date: string;
  // 0 = Sunday: the row the day sits in.
  dow: number;
  count: number;
}

export interface CalendarModel {
  // The 365 days, oldest first.
  days: CalendarCell[];
  // The same days in Sunday-first columns; the first is padded above by `days[0].dow` blanks.
  weeks: CalendarCell[][];
  // Month names over the columns they start in, spaced so two never collide.
  monthLabels: { label: string; weekIndex: number }[];
  // Indexes (into `days`) of the clickable days, oldest first.
  activeIdx: number[];
  dayIndex: Map<string, number>;
  // The colour scale's top, floored at 1 so the maths never divides by zero.
  max: number;
  // The real busiest day: 0 when there were no plays at all.
  peak: number;
  totalPlays: number;
  activeDays: number;
}

// Maps a day's play count to an accent wash whose strength scales with
// intensity (count/max), so the heatmap follows the chosen accent. Count 0
// renders a faint fg tint — strong enough (7%) to keep the grid visible on the
// white light-theme card, where 2.5% was ~1.05:1 and vanished.
//
// The ramp has a 30% FLOOR for any activity: with the old 12% floor a 1–3-play
// day on a server whose busiest day is 40 landed at 12–18% accent, which over
// either theme's card is within ~0.01 L of the 7%-of-fg zero cell — so the
// typical active day on a home server read as empty. The legend swatches call
// the same function, so they follow the floor automatically.
export function cellBg(count: number, max: number): string {
  if (count === 0) return "color-mix(in oklab, var(--ds-fg) 7%, transparent)";
  const intensity = max > 0 ? count / max : 0;
  return `color-mix(in oklab, var(--ds-accent) ${(30 + intensity * 60).toFixed(1)}%, transparent)`;
}

// The 365 day keys ending on `todayIso`. That is the statistics zone's date at
// UTC midnight (zonedTodayIso), so this UTC date walk yields that zone's day
// keys, the same days the data is bucketed by.
function windowDays(todayIso: string): { date: string; dow: number }[] {
  const today = new Date(todayIso);
  const days: { date: string; dow: number }[] = [];
  // An unreadable `today` yields an empty calendar, never a thrown RangeError.
  if (Number.isNaN(today.getTime())) return days;
  for (let i = 364; i >= 0; i--) {
    const d = new Date(today);
    d.setUTCDate(d.getUTCDate() - i);
    days.push({ date: d.toISOString().split("T")[0], dow: d.getUTCDay() });
  }
  return days;
}

function spacedMonthLabels(weeks: CalendarCell[][], locale: string): { label: string; weekIndex: number }[] {
  const labels: { label: string; weekIndex: number }[] = [];
  let lastMonth = -1;
  weeks.forEach((week, wi) => {
    const firstDay = week[0];
    if (!firstDay) return;
    const date = new Date(firstDay.date);
    const month = date.getUTCMonth();
    if (month === lastMonth) return;
    labels.push({ label: date.toLocaleString(locale, { month: "short", timeZone: "UTC" }), weekIndex: wi });
    lastMonth = month;
  });
  // A month whose first week sits right before the next month's (the partial
  // week a 365-day window opens on) would print on top of its neighbour at
  // 9.5px — "OctNov". Keep the later label; the dropped month is still the
  // cells themselves.
  return labels.filter((m, i) => {
    const next = labels[i + 1];
    return !next || next.weekIndex - m.weekIndex >= 3;
  });
}

// `clickable`: whether days with plays are interactive (the calendar has a
// drill-down); only then are they collected into `activeIdx`.
export function buildCalendarModel(
  data: readonly CalendarDayCount[],
  todayIso: string,
  locale: string,
  clickable: boolean,
): CalendarModel {
  const countMap = new Map<string, number>();
  let peak = 0;
  let totalPlays = 0;
  let activeDays = 0;
  for (const d of data) {
    countMap.set(d.day, d.count);
    if (d.count > peak) peak = d.count;
    totalPlays += d.count;
    if (d.count > 0) activeDays += 1;
  }

  const days: CalendarCell[] = windowDays(todayIso).map((d) => ({ ...d, count: countMap.get(d.date) ?? 0 }));
  const activeIdx: number[] = [];
  if (clickable) {
    days.forEach((d, i) => {
      if (d.count > 0) activeIdx.push(i);
    });
  }

  const weeks: CalendarCell[][] = [];
  let currentWeek: CalendarCell[] = [];
  for (const day of days) {
    if (day.dow === 0 && currentWeek.length > 0) {
      weeks.push(currentWeek);
      currentWeek = [];
    }
    currentWeek.push(day);
  }
  if (currentWeek.length > 0) weeks.push(currentWeek);

  return {
    days,
    weeks,
    monthLabels: spacedMonthLabels(weeks, locale),
    activeIdx,
    dayIndex: new Map(days.map((d, i) => [d.date, i])),
    max: Math.max(peak, 1),
    peak,
    totalPlays,
    activeDays,
  };
}

// ArrowUp/ArrowDown: the active day nearest to `target` that lies strictly in
// direction `dir` from `from` (indexes into the day list, where ±1 is the cell
// above/below — past the top or bottom of a column it carries on into the
// neighbouring one), or null at the edge. Days with no plays aren't
// interactive, so they're skipped.
export function nearestActive(active: readonly number[], from: number, target: number, dir: 1 | -1): number | null {
  let best: number | null = null;
  for (const i of active) {
    if (dir === 1 ? i <= from : i >= from) continue;
    if (best === null || Math.abs(i - target) < Math.abs(best - target)) best = i;
  }
  return best;
}

// ArrowLeft/ArrowRight: the nearest WEEK column in direction `dir` that has an
// active day, and in it the same weekday, else the nearest one (the upper on a
// tie). Searching by raw index distance let a day one row up in the same column
// (distance 6) beat the same weekday two weeks over (distance 14), so a
// horizontal key moved vertically. `firstDow` is the first day's weekday: the
// blanks that pad the first column.
export function horizontalTarget(active: readonly number[], from: number, dir: 1 | -1, firstDow: number): number | null {
  const column = (i: number) => Math.floor((i + firstDow) / 7);
  const row = (i: number) => (i + firstDow) % 7;
  const fromColumn = column(from);
  const fromRow = row(from);
  let best: number | null = null;
  let bestColumnDistance = 0;
  let bestRowDistance = 0;
  for (const i of active) {
    const c = column(i);
    if (dir === 1 ? c <= fromColumn : c >= fromColumn) continue;
    const columnDistance = Math.abs(c - fromColumn);
    const rowDistance = Math.abs(row(i) - fromRow);
    const closer =
      best === null ||
      columnDistance < bestColumnDistance ||
      (columnDistance === bestColumnDistance &&
        (rowDistance < bestRowDistance || (rowDistance === bestRowDistance && i < best)));
    if (closer) {
      best = i;
      bestColumnDistance = columnDistance;
      bestRowDistance = rowDistance;
    }
  }
  return best;
}

// Where a navigation key moves the focus, or undefined when the key isn't one.
// null means the key is handled but there is nowhere to go (an edge).
export function calendarKeyTarget(
  key: string,
  model: Pick<CalendarModel, "activeIdx" | "days">,
  from: number,
): number | null | undefined {
  const { activeIdx, days } = model;
  const firstDow = days[0]?.dow ?? 0;
  switch (key) {
    case "ArrowUp": return nearestActive(activeIdx, from, from - 1, -1);
    case "ArrowDown": return nearestActive(activeIdx, from, from + 1, 1);
    case "ArrowLeft": return horizontalTarget(activeIdx, from, -1, firstDow);
    case "ArrowRight": return horizontalTarget(activeIdx, from, 1, firstDow);
    case "Home": return activeIdx[0] ?? null;
    case "End": return activeIdx[activeIdx.length - 1] ?? null;
    default: return undefined;
  }
}
