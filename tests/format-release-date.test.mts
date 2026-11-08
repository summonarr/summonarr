// formatReleaseDate renders a date-only string on the day it names, in any
// server timezone (the detail pages used to print the previous day west of UTC).
import { test } from "node:test";
import assert from "node:assert/strict";
import { formatReleaseDate, upcomingCutoffDate } from "../src/lib/format-release-date.ts";

test("a date-only value renders its own calendar day regardless of the process TZ", () => {
  const prev = process.env.TZ;
  try {
    for (const tz of ["America/Los_Angeles", "UTC", "Asia/Tokyo"]) {
      process.env.TZ = tz;
      assert.equal(formatReleaseDate("2024-05-01"), "May 1, 2024", tz);
      // TMDB's release_dates carry a UTC-midnight timestamp — same day.
      assert.equal(formatReleaseDate("2024-05-01T00:00:00.000Z"), "May 1, 2024", tz);
    }
  } finally {
    if (prev === undefined) delete process.env.TZ;
    else process.env.TZ = prev;
  }
});

test("missing or unparseable values are dropped, never 'Invalid Date'", () => {
  assert.equal(formatReleaseDate(null), null);
  assert.equal(formatReleaseDate(undefined), null);
  assert.equal(formatReleaseDate(""), null);
  assert.equal(formatReleaseDate("not a date"), null);
});

// The Upcoming cutoff trails UTC by 12 hours: TMDB dates are local, the server
// is UTC, and cutting at the UTC date dropped a same-day release every evening
// west of UTC (02:00Z on the 7th is 9pm on the 6th in New York).
test("upcomingCutoffDate keeps a same-day release listed through the evening west of UTC", () => {
  const evening = Date.parse("2026-11-07T02:00:00Z");
  assert.equal(upcomingCutoffDate(evening), "2026-11-06");
  // The page and the route filter with `releaseDate >= cutoff`.
  assert.ok("2026-11-06" >= upcomingCutoffDate(evening), "a title dated the 6th is still upcoming");
  assert.ok(!("2026-11-05" >= upcomingCutoffDate(evening)), "the day before is not");
});

test("upcomingCutoffDate moves to the UTC date at noon UTC", () => {
  assert.equal(upcomingCutoffDate(Date.parse("2026-11-07T11:59:59Z")), "2026-11-06");
  assert.equal(upcomingCutoffDate(Date.parse("2026-11-07T12:00:00Z")), "2026-11-07");
});

test("the Upcoming page and GET /api/upcoming share ONE list, cut at upcomingCutoffDate, never the bare UTC date", async () => {
  const { readFileSync } = await import("node:fs");
  for (const file of ["src/app/(app)/upcoming/page.tsx", "src/app/api/upcoming/route.ts"]) {
    const src = readFileSync(file, "utf8");
    assert.match(src, /await loadUpcomingTitles\(\)/, `${file}: reads the shared list`);
    assert.doesNotMatch(src, /upcomingCacheItem|new Date\(\)\.toISOString\(\)\.slice\(0, 10\)/, file);
  }
  const lib = readFileSync("src/lib/upcoming-list.ts", "utf8");
  // One cutoff, computed once, used by the cache query and the list filter.
  assert.equal((lib.match(/upcomingCutoffDate\(/g) ?? []).length, 1);
  assert.match(lib, /releaseDate: \{ gte: today \}/);
  assert.match(lib, /interleaveUpcoming\(\[\.\.\.cached, \.\.\.movies, \.\.\.tv\], today\)/);
  assert.doesNotMatch(lib, /new Date\(\)\.toISOString\(\)\.slice\(0, 10\)/);
});
