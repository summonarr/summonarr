// getPlayStatsForServerUsers' 90-day playsByDay series: the SQL cutoff is a
// rolling `now - 90d`, which spans 91 UTC calendar days (both edges partial).
// Padding to 90 keys dropped the oldest partial day's rows — fetched, then
// never charted. getPlayHistoryStatsUncached already pads to `days + 1`; this
// pins the same for the per-user bundle. No DB: $queryRawUnsafe is shadowed.
import { test } from "node:test";
import assert from "node:assert/strict";

process.env.TOKEN_ENCRYPTION_KEY = "ab".repeat(32);

const { prisma } = await import("../src/lib/prisma.ts");
const { shadowPrismaModel, shadowPrismaClientMethod } = await import("./_helpers.mts");
const { getPlayStatsForServerUsers } = await import("../src/lib/play-history.ts");

const dayKey = (d: Date) => d.toISOString().slice(0, 10);

shadowPrismaClientMethod(prisma, "$queryRawUnsafe", async (sql: string, ...params: unknown[]) => {
  // The playsByDay aggregate: the only query binding a cutoff that also sums hours per day.
  if (sql.includes(`FILTER (WHERE "watched" = true)`) && sql.includes(`"startedAt" >=`)) {
    const cutoff = params[params.length - 1] as Date;
    return [
      { day: dayKey(cutoff), count: 3n, hours: 1.5 },
      { day: dayKey(new Date()), count: 1n, hours: 0.5 },
    ];
  }
  return [];
});
shadowPrismaModel(prisma, "playHistory", { count: async () => 0, findMany: async () => [] });

test("playsByDay keeps the oldest partial day of the rolling 90-day window", async () => {
  const stats = await getPlayStatsForServerUsers(["msu-1"]);
  const cutoffKey = dayKey(new Date(Date.now() - 90 * 24 * 60 * 60 * 1000));
  const series = stats.playsByDay;
  assert.equal(series.length, 91, "91 UTC days: today and the 90 before it");
  assert.equal(series[0].day, cutoffKey, "the series starts on the cutoff's UTC day");
  assert.equal(series[0].count, 3, "the oldest partial day's plays are charted, not dropped");
  assert.equal(series[series.length - 1].day, dayKey(new Date()));
  assert.equal(series.reduce((n, r) => n + r.count, 0), 4);
});
