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

test("ISO week window on a Sunday maps to the preceding Monday (getDay()===0 branch)", () => {
  // JS getDay() puts Sunday at 0; without the special-case, getDay()-1 = -1
  // would make `since` land on *tomorrow* — a future window that silently
  // disables quotas every Sunday. 2026-01-18 is a Sunday; ISO week start is
  // Monday 2026-01-12.
  const now = new Date(2026, 0, 18, 12, 0, 0);
  const q = resolveUserQuota("MOVIE", NONE, 5, "week", now);
  assert.equal(q.windowLabel, "week");
  assert.equal(q.since.getTime(), new Date(2026, 0, 12).getTime());
});

test("ISO week window crossing a month/year boundary rolls the Date back correctly", () => {
  // Thursday 2026-01-01 → day offset 3 → new Date(2026, 0, -2), which the Date
  // constructor rolls over to Monday 2025-12-29.
  const now = new Date(2026, 0, 1, 12, 0, 0);
  const q = resolveUserQuota("MOVIE", NONE, 5, "week", now);
  assert.equal(q.windowLabel, "week");
  assert.equal(q.since.getTime(), new Date(2025, 11, 29).getTime());
});

test("explicit per-user override of 0 disables the quota via the override path", () => {
  // The guard is `ovLimit != null`, not `ovLimit > 0`: a stored 0 is a
  // deliberate per-user quota-disable and must NOT fall through to the global
  // limit.
  const now = new Date(2026, 0, 15, 12, 0, 0);
  const q = resolveUserQuota("MOVIE", { ...NONE, movieQuotaLimit: 0 }, 10, "week", now);
  assert.equal(q.limit, 0);
  assert.equal(q.windowLabel, "7 days");
  assert.equal(q.since.getTime(), now.getTime() - 7 * 86_400_000);
});

test("negative or null override days fall back to the 7-day default window", () => {
  const now = new Date(2026, 0, 15, 12, 0, 0);

  const negative = resolveUserQuota(
    "MOVIE",
    { ...NONE, movieQuotaLimit: 3, movieQuotaDays: -2 },
    10,
    "week",
    now,
  );
  assert.equal(negative.limit, 3);
  assert.equal(negative.windowLabel, "7 days");
  assert.equal(negative.since.getTime(), now.getTime() - 7 * 86_400_000);

  const nullDays = resolveUserQuota(
    "TV",
    { ...NONE, tvQuotaLimit: 4, tvQuotaDays: null },
    10,
    "week",
    now,
  );
  assert.equal(nullDays.limit, 4);
  assert.equal(nullDays.windowLabel, "7 days");
  assert.equal(nullDays.since.getTime(), now.getTime() - 7 * 86_400_000);
});

test("unknown/corrupt globalPeriod string falls through to the week window", () => {
  // A corrupted `quotaPeriod` Setting must not throw or disable quotas — the
  // default branch of globalWindow deliberately treats anything unrecognized
  // as "week".
  const now = new Date(2026, 0, 15, 12, 0, 0); // Thu → Monday 2026-01-12
  const monday = new Date(2026, 0, 12).getTime();

  const fortnight = resolveUserQuota("MOVIE", NONE, 5, "fortnight", now);
  assert.equal(fortnight.windowLabel, "week");
  assert.equal(fortnight.since.getTime(), monday);

  const empty = resolveUserQuota("MOVIE", NONE, 5, "", now);
  assert.equal(empty.windowLabel, "week");
  assert.equal(empty.since.getTime(), monday);
});

test("parseQuotaLimit numeric edge forms follow parseInt semantics", () => {
  assert.equal(parseQuotaLimit("5.9"), 5); // truncates, never rounds up
  assert.equal(parseQuotaLimit(" 7"), 7); // leading whitespace tolerated
  assert.equal(parseQuotaLimit("1e3"), 1); // parseInt stops at 'e' — NOT 1000
  assert.equal(parseQuotaLimit("Infinity"), 0); // non-digit prefix → NaN → 0
});
