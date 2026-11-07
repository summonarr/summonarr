// The statistics time zone (src/lib/stats-time-zone.ts + -data.ts): which zone
// the play-history aggregates bucket hours and days in. The setting when it
// names a valid zone, else the server process's own zone (TZ), else UTC.
import { test } from "node:test";
import assert from "node:assert/strict";

process.env.TOKEN_ENCRYPTION_KEY = "ab".repeat(32);

const warns: string[] = [];
console.warn = (...a: unknown[]) => { warns.push(a.map(String).join(" ")); };

const { prisma } = await import("../src/lib/prisma.ts");
const { shadowPrismaModel } = await import("./_helpers.mts");
const {
  STATS_TIME_ZONE_KEY,
  dayKeysBetween,
  normalizeTimeZone,
  processTimeZone,
  resolveStatsTimeZone,
  zoneShortLabel,
  zonedDayKey,
  zonedMidnightSql,
  zonedTimestampSql,
  zonedTodayIso,
} = await import("../src/lib/stats-time-zone.ts");
const { getStatsTimeZone, invalidateStatsTimeZone } = await import("../src/lib/stats-time-zone-data.ts");

// Runs `fn` with the process in `tz` (Node applies a TZ change at runtime).
function withTz<T>(tz: string | undefined, fn: () => T): T {
  const prev = process.env.TZ;
  if (tz === undefined) delete process.env.TZ;
  else process.env.TZ = tz;
  try {
    return fn();
  } finally {
    if (prev === undefined) delete process.env.TZ;
    else process.env.TZ = prev;
  }
}

async function withTzAsync<T>(tz: string, fn: () => Promise<T>): Promise<T> {
  const prev = process.env.TZ;
  process.env.TZ = tz;
  try {
    return await fn();
  } finally {
    if (prev === undefined) delete process.env.TZ;
    else process.env.TZ = prev;
  }
}

test("normalizeTimeZone keeps a zone Intl knows by name, in its canonical spelling", () => {
  assert.equal(normalizeTimeZone("America/New_York"), "America/New_York");
  assert.equal(normalizeTimeZone("  america/new_york "), "America/New_York", "trimmed, case-insensitive");
  assert.equal(normalizeTimeZone("UTC"), "UTC");
  assert.equal(normalizeTimeZone("Etc/UTC"), "UTC");
  assert.equal(normalizeTimeZone("US/Eastern"), "America/New_York", "a link resolves to its zone");
  assert.equal(normalizeTimeZone("Etc/GMT+5"), "Etc/GMT+5", "tzdata's own names, sign as tzdata means it");
});

test("normalizeTimeZone refuses non-zones and the bare offsets Postgres would read backwards", () => {
  for (const bad of ["", "   ", "Mars/Olympus_Mons", "America/New York", "+05:00", "-0500", "+00:00", "Z", "x".repeat(65), null, undefined, 5]) {
    assert.equal(normalizeTimeZone(bad), null, JSON.stringify(bad));
  }
});

test("the process zone is TZ when it is a usable zone, else UTC", () => {
  assert.equal(withTz("Asia/Tokyo", processTimeZone), "Asia/Tokyo");
  assert.equal(withTz("UTC", processTimeZone), "UTC");
  // An unknown TZ leaves Intl with no zone (or Etc/Unknown): never a name to bind.
  assert.equal(withTz("Not/AZone", processTimeZone), "UTC");
  assert.equal(withTz("", processTimeZone), "UTC");
});

test("resolveStatsTimeZone: a valid stored zone wins; unset or invalid falls back to the process zone, then UTC", () => {
  assert.equal(resolveStatsTimeZone("Europe/Berlin", "Asia/Tokyo"), "Europe/Berlin");
  assert.equal(resolveStatsTimeZone(null, "Asia/Tokyo"), "Asia/Tokyo", "unset");
  assert.equal(resolveStatsTimeZone("", "Asia/Tokyo"), "Asia/Tokyo", "cleared");
  assert.equal(resolveStatsTimeZone("Mars/Olympus_Mons", "Asia/Tokyo"), "Asia/Tokyo", "an invalid stored value");
  assert.equal(resolveStatsTimeZone("+05:00", "Asia/Tokyo"), "Asia/Tokyo", "an offset written around the route");
  assert.equal(resolveStatsTimeZone("Mars/Olympus_Mons", "Not/AZone"), "UTC", "nothing usable at all");
  assert.equal(withTz("Australia/Sydney", () => resolveStatsTimeZone(undefined)), "Australia/Sydney", "the default fallback is the process zone");
});

test("day keys are the zone's calendar: 02:30 UTC on 15 Jan is the 14th in New York, the 15th in Tokyo", () => {
  const at = new Date("2026-01-15T02:30:00Z");
  assert.equal(zonedDayKey(at, "UTC"), "2026-01-15");
  assert.equal(zonedDayKey(at, "America/New_York"), "2026-01-14");
  assert.equal(zonedDayKey(at, "Asia/Tokyo"), "2026-01-15");
  assert.equal(zonedTodayIso(at, "America/New_York"), "2026-01-14T00:00:00.000Z");
});

test("dayKeysBetween walks calendar days, inclusive, across a DST change and a month end", () => {
  assert.deepEqual(dayKeysBetween("2026-03-07", "2026-03-09"), ["2026-03-07", "2026-03-08", "2026-03-09"]);
  assert.deepEqual(dayKeysBetween("2026-10-31", "2026-11-02"), ["2026-10-31", "2026-11-01", "2026-11-02"]);
  assert.deepEqual(dayKeysBetween("2026-02-27", "2026-03-01"), ["2026-02-27", "2026-02-28", "2026-03-01"]);
  assert.deepEqual(dayKeysBetween("2026-05-02", "2026-05-01"), []);
});

test("zoneShortLabel: UTC stays UTC, a zone shows its place", () => {
  assert.equal(zoneShortLabel("UTC"), "UTC");
  assert.equal(zoneShortLabel("America/New_York"), "New York");
  assert.equal(zoneShortLabel("America/Argentina/Buenos_Aires"), "Buenos Aires");
  assert.equal(zoneShortLabel("EST5EDT"), "EST5EDT");
});

test("the SQL helpers bind the zone and compare the bare column", () => {
  assert.equal(zonedTimestampSql(`"startedAt"`, "$3"), `(("startedAt" AT TIME ZONE 'UTC') AT TIME ZONE $3::text)`);
  assert.equal(zonedMidnightSql("$1::date", "$2"), `(((($1::date)::timestamp) AT TIME ZONE $2::text) AT TIME ZONE 'UTC')`);
});

// ── the setting reader ──────────────────────────────────────────────────────

let stored: string | null = null;
let reads = 0;
let failRead = false;
shadowPrismaModel(prisma, "setting", {
  findUnique: async (a: { where: { key: string } }) => {
    reads++;
    assert.equal(a.where.key, STATS_TIME_ZONE_KEY);
    if (failRead) throw new Error("db down");
    return stored === null ? null : { key: a.where.key, value: stored };
  },
});

test("getStatsTimeZone reads the setting, caches it, and drops the memo on invalidate", async () => {
  stored = "Europe/Paris";
  invalidateStatsTimeZone();
  reads = 0;
  assert.equal(await getStatsTimeZone(), "Europe/Paris");
  assert.equal(await getStatsTimeZone(), "Europe/Paris");
  assert.equal(reads, 1, "one read serves the cache window");
  stored = "Asia/Kolkata";
  assert.equal(await getStatsTimeZone(), "Europe/Paris", "still the cached value");
  invalidateStatsTimeZone();
  assert.equal(await getStatsTimeZone(), normalizeTimeZone("Asia/Kolkata"));
  assert.equal(reads, 2);
});

test("getStatsTimeZone: unset or invalid stored values fall back to the process zone", async () => {
  await withTzAsync("America/Chicago", async () => {
    stored = null;
    invalidateStatsTimeZone();
    assert.equal(await getStatsTimeZone(), "America/Chicago", "unset");
    stored = "Mars/Olympus_Mons";
    invalidateStatsTimeZone();
    assert.equal(await getStatsTimeZone(), "America/Chicago", "an invalid stored value");
  });
});

test("getStatsTimeZone: a failed read falls back to the process zone with one warning, and is not cached", async () => {
  warns.length = 0;
  failRead = true;
  try {
    invalidateStatsTimeZone();
    const zone = await withTzAsync("UTC", () => getStatsTimeZone());
    assert.equal(zone, "UTC");
    await withTzAsync("UTC", () => getStatsTimeZone());
    assert.equal(warns.length, 1, "the unchanged failure warns once (7b)");
    assert.match(warns[0], /^\[stats-time-zone\] Could not read statsTimeZone; using UTC: db down$/);
  } finally {
    failRead = false;
  }
  stored = "Asia/Tokyo";
  assert.equal(await getStatsTimeZone(), "Asia/Tokyo", "the next read after a failure goes to the database");
});
