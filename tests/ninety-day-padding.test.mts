// getPlayStatsForServerUsers' 90-day playsByDay series: the SQL cutoff is a
// rolling `now - 90d`, which spans 91 calendar days (both edges partial).
// Padding to 90 keys dropped the oldest partial day's rows — fetched, then
// never charted. getPlayHistoryStatsUncached pads the same way; this pins the
// per-user bundle. The days are the statistics time zone's, like the SQL day
// buckets. No DB: $queryRawUnsafe is shadowed.
import { test } from "node:test";
import assert from "node:assert/strict";

process.env.TOKEN_ENCRYPTION_KEY = "ab".repeat(32);

const { prisma } = await import("../src/lib/prisma.ts");
const { shadowPrismaModel, shadowPrismaClientMethod } = await import("./_helpers.mts");
const { getPlayStatsForServerUsers } = await import("../src/lib/play-history.ts");
const { invalidateStatsTimeZone } = await import("../src/lib/stats-time-zone-data.ts");
const { zonedDayKey } = await import("../src/lib/stats-time-zone.ts");

let statsZone = "UTC";
shadowPrismaModel(prisma, "setting", {
  findUnique: async () => ({ value: statsZone }),
  findMany: async () => [],
});

shadowPrismaClientMethod(prisma, "$queryRawUnsafe", async (sql: string, ...params: unknown[]) => {
  // The playsByDay aggregate: the only query binding a cutoff that also sums
  // hours per day. Its last two params are the cutoff and the zone.
  if (sql.includes(`FILTER (WHERE "watched" = true)`) && sql.includes(`"startedAt" >=`)) {
    const cutoff = params[params.length - 2] as Date;
    const zone = params[params.length - 1] as string;
    return [
      { day: zonedDayKey(cutoff, zone), count: 3n, hours: 1.5 },
      { day: zonedDayKey(new Date(), zone), count: 1n, hours: 0.5 },
    ];
  }
  return [];
});
shadowPrismaModel(prisma, "playHistory", { count: async () => 0, findMany: async () => [] });

test("playsByDay keeps the oldest partial day of the rolling 90-day window", async () => {
  statsZone = "UTC";
  invalidateStatsTimeZone();
  const stats = await getPlayStatsForServerUsers(["msu-1"]);
  const dayKey = (d: Date) => d.toISOString().slice(0, 10);
  const cutoffKey = dayKey(new Date(Date.now() - 90 * 24 * 60 * 60 * 1000));
  const series = stats.playsByDay;
  assert.equal(series.length, 91, "91 days: today and the 90 before it");
  assert.equal(series[0].day, cutoffKey, "the series starts on the cutoff's day");
  assert.equal(series[0].count, 3, "the oldest partial day's plays are charted, not dropped");
  assert.equal(series[series.length - 1].day, dayKey(new Date()));
  assert.equal(series.reduce((n, r) => n + r.count, 0), 4);
});

test("the padded days are the statistics zone's, so the rows' day buckets land on them", async () => {
  // Whichever far-off zone is on a different date from UTC right now: the
  // series must end on THAT zone's today, where the bucketed rows sit.
  const now = new Date();
  const zone = ["Pacific/Kiritimati", "Pacific/Pago_Pago"].find(
    (z) => zonedDayKey(now, z) !== now.toISOString().slice(0, 10),
  )!;
  statsZone = zone;
  invalidateStatsTimeZone();
  try {
    const stats = await getPlayStatsForServerUsers(["msu-2"]);
    assert.equal(stats.timeZone, zone, "the bundle names the zone it bucketed in");
    const series = stats.playsByDay;
    assert.equal(series[series.length - 1].day, zonedDayKey(new Date(), zone), "the series ends on the zone's today");
    assert.equal(series.reduce((n, r) => n + r.count, 0), 4, "both bucketed rows are charted");
  } finally {
    statsZone = "UTC";
    invalidateStatsTimeZone();
  }
});
