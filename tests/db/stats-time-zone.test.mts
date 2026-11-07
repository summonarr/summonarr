// The statistics time zone against a REAL Postgres: the unit suite checks the
// SQL text and its binds, but only Postgres can show that
// (("startedAt" AT TIME ZONE 'UTC') AT TIME ZONE $zone) puts a play on the
// zone's wall clock, and that the zone's midnights bound the drill-downs and
// the history filter on exactly the same day.
import { test, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { prisma, resetDb, daysAgo, closeDb } from "./_harness.mts";
import {
  clearActivityCache,
  getActivityCalendar,
  getHeatmapCellDetail,
  getPlayHistoryStats,
  getPlayStatsForServerUsers,
  getPlayYearsForServerUsers,
  getWrappedForServerUsers,
} from "@/lib/play-history.ts";
import { databaseKnowsTimeZone, invalidateStatsTimeZone } from "@/lib/stats-time-zone-data.ts";
import { STATS_TIME_ZONE_KEY, normalizeTimeZone, zonedDayKey } from "@/lib/stats-time-zone.ts";
import { composeWhere, parsePlayHistoryFilters } from "@/lib/play-history-filters.ts";

const NY = "America/New_York";

before(resetDb);
beforeEach(async () => {
  await resetDb();
  clearActivityCache();
  invalidateStatsTimeZone();
});
after(async () => {
  invalidateStatsTimeZone();
  await closeDb();
});

async function useZone(zone: string): Promise<void> {
  await prisma.setting.upsert({
    where: { key: STATS_TIME_ZONE_KEY },
    update: { value: zone },
    create: { key: STATS_TIME_ZONE_KEY, value: zone },
  });
  invalidateStatsTimeZone();
  clearActivityCache();
}

let sid = 0;
async function viewer(): Promise<string> {
  const u = await prisma.mediaServerUser.create({
    data: { source: "plex", sourceUserId: `tz-${++sid}`, username: `tz${sid}` },
    select: { id: true },
  });
  return u.id;
}
async function play(userId: string, startedAt: Date, over: Record<string, unknown> = {}) {
  await prisma.playHistory.create({
    data: {
      source: "plex",
      mediaServerUserId: userId,
      startedAt,
      stoppedAt: new Date(startedAt.getTime() + 3_600_000),
      duration: 7200,
      playDuration: 3600,
      watched: true,
      mediaType: "MOVIE",
      tmdbId: 100,
      title: "Movie A",
      sourceSessionId: `tz-s${++sid}`,
      ...over,
    } as Parameters<typeof prisma.playHistory.create>[0]["data"],
  });
}

// Thursday 15 January 2026, 02:30 UTC is Wednesday 14 January, 21:30 in New
// York (EST, UTC-5, in winter).
const WINTER_PLAY = new Date("2026-01-15T02:30:00Z");

test("a play at 02:30 UTC lands in hour 21 of the previous day for America/New_York (winter)", async () => {
  const msu = await viewer();
  await play(msu, WINTER_PLAY);

  const utc = await getPlayStatsForServerUsers([msu], "UTC");
  assert.deepEqual(utc.userHeatmap, [{ dow: 4, hour: 2, count: 1 }], "in UTC: Thursday, 02:00");

  const ny = await getPlayStatsForServerUsers([msu], NY);
  assert.equal(ny.timeZone, NY);
  assert.deepEqual(ny.userHeatmap, [{ dow: 3, hour: 21, count: 1 }], "in New York: Wednesday, 21:00");

  const w = await getWrappedForServerUsers([msu], 2026, NY);
  assert.equal(w.timeZone, NY);
  assert.deepEqual(w.biggestDay, { day: "2026-01-14", plays: 1, hours: 1 });
  assert.equal(w.primeDow, 3);
  assert.equal(w.primeHour, 21);
  assert.deepEqual(w.busiestMonth, { month: "2026-01", plays: 1 });
});

test("the year is the zone's: 03:00 UTC on 1 January is New Year's Eve in New York", async () => {
  const msu = await viewer();
  await play(msu, new Date("2026-01-01T03:00:00Z"));
  assert.deepEqual(await getPlayYearsForServerUsers([msu], "UTC"), [2026]);
  assert.deepEqual(await getPlayYearsForServerUsers([msu], NY), [2025]);
  assert.equal((await getWrappedForServerUsers([msu], 2025, NY)).totals.plays, 1, "counted in New York's 2025");
  assert.equal((await getWrappedForServerUsers([msu], 2026, NY)).totals.plays, 0, "and not in its 2026");
  assert.deepEqual((await getWrappedForServerUsers([msu], 2025, NY)).biggestDay?.day, "2025-12-31");
});

test("the drill-downs read the setting's zone: the day and hour cells hold exactly the bucket's plays", async () => {
  const msu = await viewer();
  await play(msu, WINTER_PLAY);
  await play(msu, new Date("2026-01-15T05:30:00Z")); // 00:30 on the 15th in New York
  await useZone(NY);

  assert.equal((await getHeatmapCellDetail({ mode: "day", day: "2026-01-14" })).totalPlays, 1, "the 14th in New York");
  assert.equal((await getHeatmapCellDetail({ mode: "day", day: "2026-01-15" })).totalPlays, 1, "the 15th in New York");
  assert.equal((await getHeatmapCellDetail({ mode: "hour", dow: 3, hour: 21, userId: msu })).totalPlays, 1);
  assert.equal((await getHeatmapCellDetail({ mode: "hour", dow: 4, hour: 2, userId: msu })).totalPlays, 0, "not the UTC cell");

  // A DST day is 23 hours long: 8 March 2026 runs 05:00Z to 04:00Z the next day.
  await play(msu, new Date("2026-03-09T03:59:00Z"));
  await play(msu, new Date("2026-03-09T04:01:00Z"));
  clearActivityCache();
  assert.equal((await getHeatmapCellDetail({ mode: "day", day: "2026-03-08" })).totalPlays, 1, "spring-forward day ends at 04:00Z");
});

test("the history's fromDay/toDay filter bounds the same day as the calendar cell", async () => {
  const msu = await viewer();
  await play(msu, WINTER_PLAY);
  await play(msu, new Date("2026-01-14T04:59:00Z")); // 23:59 on the 13th in New York
  await play(msu, new Date("2026-01-15T05:00:00Z")); // midnight starting the 15th
  const count = async (fromDay: string, toDay: string, zone: string) => {
    const { whereSql, binds } = composeWhere(parsePlayHistoryFilters(new URLSearchParams({ fromDay, toDay }), zone));
    const rows = await prisma.$queryRawUnsafe<{ n: bigint }[]>(
      `SELECT COUNT(*)::bigint AS n FROM "PlayHistory" h WHERE 1=1 ${whereSql}`,
      ...binds,
    );
    return Number(rows[0].n);
  };
  assert.equal(await count("2026-01-14", "2026-01-14", NY), 1, "only the evening play is New York's 14th");
  assert.equal(await count("2026-01-13", "2026-01-15", NY), 3);
  assert.equal(await count("2026-01-14", "2026-01-14", "UTC"), 1, "in UTC the 14th holds the 04:59Z play");
});

test("the rolling statistics and the calendar bucket in the setting's zone, as Intl reads the same instant", async () => {
  const msu = await viewer();
  // 02:30 UTC two days ago: the previous evening in New York, EST or EDT alike.
  const at = daysAgo(2);
  at.setUTCHours(2, 30, 0, 0);
  await play(msu, at);
  await useZone(NY);

  const parts = new Intl.DateTimeFormat("en-US", { timeZone: NY, weekday: "short", hour: "numeric", hourCycle: "h23" })
    .formatToParts(at);
  const hour = Number(parts.find((p) => p.type === "hour")!.value);
  const dow = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"].indexOf(parts.find((p) => p.type === "weekday")!.value);

  const stats = await getPlayHistoryStats({ days: 7 });
  assert.equal(stats.timeZone, NY);
  assert.deepEqual(stats.heatmap, [{ dow, hour, count: 1 }]);
  assert.deepEqual(stats.playsByHour, [{ hour, count: 1 }]);
  const day = zonedDayKey(at, NY);
  assert.equal(stats.playsByDay.find((d) => d.count > 0)?.day, day);
  assert.equal(stats.playsByDay.at(-1)?.day, zonedDayKey(new Date(), NY), "the series ends on New York's today");
  assert.deepEqual(await getActivityCalendar(), [{ day, count: 1 }]);
});

test("the settings check knows what Postgres knows", async () => {
  assert.equal(await databaseKnowsTimeZone(NY), true);
  assert.equal(await databaseKnowsTimeZone("utc"), true, "case-insensitive, as Postgres matches zone names");
  assert.equal(await databaseKnowsTimeZone("Mars/Olympus_Mons"), false);
  // Intl stores its canonical spelling, which can be an older alias.
  assert.equal(await databaseKnowsTimeZone(normalizeTimeZone("Asia/Kolkata")!), true);
});
