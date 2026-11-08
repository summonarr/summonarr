// Small helpers the aggregate builders share: running a statement fan-out under
// the pool cap, and padding a daily series.
import { mapLimit } from "./concurrency";
import { dayKeysBetween, zonedDayKey } from "./stats-time-zone";

// In-flight statement cap for an aggregate fan-out. The pg pool holds five
// connections (prisma.ts); an uncached load used to issue every statement at
// once and hold all five until the batch drained, so the 5s play-history
// poller (its resolve transaction waits at most 10s for a connection) and
// every other request queued behind it. Three leaves two free.
export const STATS_STATEMENT_CONCURRENCY = 3;

type TaskResults<T extends Record<string, () => Promise<unknown>>> = {
  [K in keyof T]: Awaited<ReturnType<T[K]>>;
};

// Runs NAMED statements at most STATS_STATEMENT_CONCURRENCY at a time and
// returns their results under the same names, so adding, removing or
// reordering one can't misalign the others. They start in the order the object
// lists them (mapLimit keeps input order).
export async function runCapped<T extends Record<string, () => Promise<unknown>>>(
  tasks: T,
): Promise<TaskResults<T>> {
  const names = Object.keys(tasks);
  const results = await mapLimit(names, STATS_STATEMENT_CONCURRENCY, (name) => tasks[name]());
  // Each name maps to its own task's result, which the mapped type spells out.
  return Object.fromEntries(names.map((name, i) => [name, results[i]])) as TaskResults<T>;
}

// Postgres GROUP BY day omits zero-play days; the AreaChart needs an entry per
// day in the window so gaps render as 0 instead of collapsing the x-axis. The
// windows are a rolling `since` cutoff, so the series runs from the cutoff's day
// to today's, both in the statistics zone like the SQL day buckets: `days + 1`
// days (both edges partial), give or take one when a DST change falls inside.
export function padDailySeries<T extends { day: string }>(
  rows: T[],
  since: Date,
  timeZone: string,
  fill: (day: string) => T,
): T[] {
  const byDay = new Map(rows.map((r) => [r.day, r]));
  return dayKeysBetween(zonedDayKey(since, timeZone), zonedDayKey(new Date(), timeZone)).map(
    (day) => byDay.get(day) ?? fill(day),
  );
}

// A COUNT(*)::bigint (or an absent row's) as a number.
export const count = (n: bigint | number | null | undefined): number => Number(n ?? 0);
// Rounded to one decimal place, the figures' display precision.
export const round1 = (n: number): number => Math.round(n * 10) / 10;
