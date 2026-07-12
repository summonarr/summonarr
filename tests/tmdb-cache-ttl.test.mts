// Unit tests for libraryDetailsTtl (src/lib/tmdb-cache.ts) — the age-scaled
// cache TTL for per-title detail/ratings rows. Fresh releases churn (ratings
// pour in, digital-release dates land), so they refresh in days; back-catalog
// titles barely change, so they hold for a month. The buckets:
//
//   age < 1  →  3 days      age < 3 →  7 days
//   age < 7  → 14 days      else    → 30 days
//
// Age is computed against new Date().getFullYear() AT CALL TIME, so every
// fixture derives its year from the current year — hardcoded years would make
// the suite rot annually. An unknown/unparseable release date falls into the
// oldest bucket (30 days): with no evidence of freshness, cache longest.
//
// The rest of tmdb-cache.ts is prisma-bound (getCache/setCache/getCacheMany)
// and deliberately untested here.
import { test } from "node:test";
import assert from "node:assert/strict";
import { libraryDetailsTtl } from "../src/lib/tmdb-cache.ts";

const DAY = 24 * 60 * 60; // TTLs are in seconds

// Release date N calendar years before the current year. Mid-year day keeps
// the fixture obviously date-shaped; only the first 4 chars matter.
function releasedYearsAgo(age: number): string {
  return `${new Date().getFullYear() - age}-06-15`;
}

test("age 0 (released this calendar year) → 3 days", () => {
  assert.equal(libraryDetailsTtl(releasedYearsAgo(0)), 3 * DAY);
});

test("age 1 → 7 days (lower edge of the 7-day bucket)", () => {
  assert.equal(libraryDetailsTtl(releasedYearsAgo(1)), 7 * DAY);
});

test("age 2 → 7 days (upper edge of the 7-day bucket)", () => {
  assert.equal(libraryDetailsTtl(releasedYearsAgo(2)), 7 * DAY);
});

test("age 3 → 14 days (lower edge of the 14-day bucket)", () => {
  assert.equal(libraryDetailsTtl(releasedYearsAgo(3)), 14 * DAY);
});

test("age 6 → 14 days (upper edge of the 14-day bucket)", () => {
  assert.equal(libraryDetailsTtl(releasedYearsAgo(6)), 14 * DAY);
});

test("age 7 → 30 days (the ≥7 boundary)", () => {
  assert.equal(libraryDetailsTtl(releasedYearsAgo(7)), 30 * DAY);
});

test("deep back-catalog (age 25) → 30 days", () => {
  assert.equal(libraryDetailsTtl(releasedYearsAgo(25)), 30 * DAY);
});

test("null releaseDate → 30 days", () => {
  assert.equal(libraryDetailsTtl(null), 30 * DAY);
});

test("undefined releaseDate → 30 days", () => {
  assert.equal(libraryDetailsTtl(undefined), 30 * DAY);
});

test("empty-string releaseDate → 30 days", () => {
  assert.equal(libraryDetailsTtl(""), 30 * DAY);
});

test("unparseable releaseDate → 30 days", () => {
  assert.equal(libraryDetailsTtl("TBA"), 30 * DAY);
  assert.equal(libraryDetailsTtl("coming soon"), 30 * DAY);
});

test("only the leading 4 chars are parsed as the year — trailing junk is ignored", () => {
  const y = new Date().getFullYear();
  assert.equal(libraryDetailsTtl(`${y}-99-99 director's cut`), 3 * DAY);
  assert.equal(libraryDetailsTtl(String(y - 10)), 30 * DAY); // bare year, no month/day
});

test("PINS CURRENT BEHAVIOR: a future-dated release (negative age) gets the freshest bucket", () => {
  // age = currentYear - futureYear < 0 < 1 → 3 days. Upcoming titles are the
  // fastest-changing rows of all, so the shortest TTL is the right outcome.
  assert.equal(libraryDetailsTtl(releasedYearsAgo(-1)), 3 * DAY);
});
