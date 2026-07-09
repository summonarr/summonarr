// Unit tests for per-media-type request-quota resolution (src/lib/quota.ts).
// Pure leaf module; `now` is injectable so the window math is deterministic.
import { test } from "node:test";
import assert from "node:assert/strict";
import { resolveUserQuota, parseQuotaLimit, type UserQuotaOverrides } from "../src/lib/quota.ts";

const NONE: UserQuotaOverrides = {
  movieQuotaLimit: null,
  movieQuotaDays: null,
  tvQuotaLimit: null,
  tvQuotaDays: null,
};

test("per-user override wins and defines a rolling N-day window", () => {
  const now = new Date(2026, 0, 15, 12, 0, 0);
  const overrides: UserQuotaOverrides = { ...NONE, movieQuotaLimit: 3, movieQuotaDays: 5 };
  const q = resolveUserQuota("MOVIE", overrides, 10, "week", now);
  assert.equal(q.limit, 3);
  assert.equal(q.windowLabel, "5 days");
  assert.equal(q.since.getTime(), now.getTime() - 5 * 86_400_000);
});

test("override with null/zero days defaults to a 7-day window", () => {
  const now = new Date(2026, 0, 15, 12, 0, 0);
  const q = resolveUserQuota("TV", { ...NONE, tvQuotaLimit: 2, tvQuotaDays: 0 }, 10, "week", now);
  assert.equal(q.limit, 2);
  assert.equal(q.windowLabel, "7 days");
  assert.equal(q.since.getTime(), now.getTime() - 7 * 86_400_000);
});

test("global fallback windows: day / week / month", () => {
  const now = new Date(2026, 0, 15, 12, 0, 0); // Thu 2026-01-15

  const day = resolveUserQuota("MOVIE", NONE, 5, "day", now);
  assert.equal(day.limit, 5);
  assert.equal(day.windowLabel, "day");
  assert.equal(day.since.getTime(), new Date(2026, 0, 15).getTime());

  const month = resolveUserQuota("MOVIE", NONE, 5, "month", now);
  assert.equal(month.windowLabel, "month");
  assert.equal(month.since.getTime(), new Date(2026, 0, 1).getTime());

  // ISO week starts Monday. 2026-01-15 is a Thursday → Monday 2026-01-12.
  const week = resolveUserQuota("MOVIE", NONE, 5, "week", now);
  assert.equal(week.windowLabel, "week");
  assert.equal(week.since.getTime(), new Date(2026, 0, 12).getTime());
});

test("global quota is per media type (movie override doesn't affect TV)", () => {
  const now = new Date(2026, 0, 15, 12, 0, 0);
  const overrides: UserQuotaOverrides = { ...NONE, movieQuotaLimit: 3, movieQuotaDays: 5 };
  // TV has no override → falls back to the global window/limit.
  const tv = resolveUserQuota("TV", overrides, 10, "week", now);
  assert.equal(tv.limit, 10);
  assert.equal(tv.windowLabel, "week");
});

test("parseQuotaLimit coerces junk to 0 (disabled), never NaN", () => {
  assert.equal(parseQuotaLimit("5"), 5);
  assert.equal(parseQuotaLimit("0"), 0);
  assert.equal(parseQuotaLimit(""), 0);
  assert.equal(parseQuotaLimit("abc"), 0);
  assert.equal(parseQuotaLimit("-3"), 0);
  assert.equal(parseQuotaLimit(null), 0);
  assert.equal(parseQuotaLimit(undefined), 0);
});
