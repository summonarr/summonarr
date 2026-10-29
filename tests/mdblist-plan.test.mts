// Unit tests for src/lib/mdblist-plan.ts — the MDBList plan table and the pure
// budget rules mdblist.ts applies. Pinned here:
//   - the plan table matches MDBList's supporter page (2026-10-28), and an
//     unknown or blank stored value reads as "auto";
//   - the budget takes the LOWER of the account's reported remaining and the
//     admin's own cap, with "auto" adding no cap of its own and an unknown
//     limit meaning no cap at all (MDBList's 429 is then the only stop);
//   - background callers stop at the 25% reserve, pages at zero;
//   - a late reply carrying an older (higher) remaining never hands requests
//     back, a new day resets our own count, and a stale report stops counting;
//   - X-RateLimit-* parsing rejects garbage and falls back to the next UTC
//     midnight for a missing or absurd reset;
//   - a limit error pauses for Retry-After when given, else until midnight
//     (daily), the next 5-minute boundary (window), or the old hour (other).
import { test } from "node:test";
import assert from "node:assert/strict";

const plan = await import("../src/lib/mdblist-plan.ts");
const {
  MDBLIST_PLANS,
  MDBLIST_PLAN_CHOICES,
  BACKGROUND_RESERVE_FRACTION,
  DEFAULT_PAUSE_MS,
  budgetAllows,
  emptyUsage,
  isMdblistPlanSetting,
  mdblistBudget,
  mdblistLimitKind,
  mdblistPauseUntil,
  nextUtcMidnight,
  parseMdblistPlanSetting,
  parseRetryAfter,
  parseUsageHeaders,
  planDailyRequests,
  planForDailyLimit,
  recordReport,
  recordSent,
} = plan;

const T0 = Date.UTC(2026, 9, 28, 7, 27, 30); // 07:27:30 UTC
const MIDNIGHT = Date.UTC(2026, 9, 29, 0, 0, 0);
const MIN = 60_000;

function headers(map: Record<string, string>): (name: string) => string | null {
  return (name) => map[name] ?? null;
}

test("the plan table is MDBList's supporter page, in order", () => {
  assert.deepEqual(
    MDBLIST_PLANS.map((p) => [p.id, p.dailyRequests]),
    [
      ["free", 1_000],
      ["basic", 10_000],
      ["standard", 25_000],
      ["plus", 100_000],
      ["vip5", 250_000],
      ["vip10", 500_000],
      ["vip15", 1_000_000],
      ["vip20", 1_500_000],
    ],
  );
  assert.deepEqual(MDBLIST_PLAN_CHOICES, ["auto", "free", "basic", "standard", "plus", "vip5", "vip10", "vip15", "vip20"]);
  assert.equal(BACKGROUND_RESERVE_FRACTION, 0.25);
  assert.equal(planDailyRequests("plus"), 100_000);
  assert.equal(planForDailyLimit(100_000), "plus");
  assert.equal(planForDailyLimit(12_345), null, "a limit no plan has is not given a plan name");
  assert.equal(planForDailyLimit(null), null);
});

test("the stored setting: known values pass, anything else reads as auto", () => {
  assert.equal(isMdblistPlanSetting("plus"), true);
  assert.equal(isMdblistPlanSetting("auto"), true);
  assert.equal(isMdblistPlanSetting("Plus"), false, "case matters — the route stores the exact id");
  assert.equal(isMdblistPlanSetting("gold"), false);
  assert.equal(parseMdblistPlanSetting("vip10"), "vip10");
  assert.equal(parseMdblistPlanSetting(" plus "), "plus");
  assert.equal(parseMdblistPlanSetting("gold"), "auto");
  assert.equal(parseMdblistPlanSetting(""), "auto");
  assert.equal(parseMdblistPlanSetting(null), "auto");
  assert.equal(parseMdblistPlanSetting(undefined), "auto");
});

test("nothing known: auto has no limit of its own; a picked plan caps our own count", () => {
  const u = emptyUsage(T0);
  assert.deepEqual(mdblistBudget("auto", u, T0), { limit: null, remaining: null, reserve: 0 });
  assert.equal(budgetAllows(mdblistBudget("auto", u, T0), true), true, "unknown ⇒ no cap; MDBList's 429 is the stop");

  let sent = u;
  for (let i = 0; i < 740; i++) sent = recordSent(sent, T0);
  const free = mdblistBudget("free", sent, T0);
  assert.deepEqual(free, { limit: 1_000, remaining: 260, reserve: 250 });
  assert.equal(budgetAllows(free, true), true, "260 left > 250 reserve");
  for (let i = 0; i < 10; i++) sent = recordSent(sent, T0);
  const atReserve = mdblistBudget("free", sent, T0);
  assert.equal(atReserve.remaining, 250);
  assert.equal(budgetAllows(atReserve, true), false, "background stops AT the reserve, not below it");
  assert.equal(budgetAllows(atReserve, false), true, "a page may still spend it");
});

test("MDBList's report is the account's truth; the remaining counts down from it", () => {
  let u = emptyUsage(T0);
  u = recordSent(u, T0);
  u = recordReport(u, { limit: 100_000, remaining: 60_000, resetAt: MIDNIGHT }, T0);
  assert.equal(u.sentSinceReport, 0, "a report covers every request sent before it");
  u = recordSent(u, T0);
  u = recordSent(u, T0);
  const b = mdblistBudget("auto", u, T0);
  assert.deepEqual(b, { limit: 100_000, remaining: 59_998, reserve: 25_000 });
});

test("the lower limit wins: a smaller picked plan caps our own count, a bigger one changes nothing", () => {
  let u = emptyUsage(T0);
  for (let i = 0; i < 24_000; i++) u = recordSent(u, T0);
  u = recordReport(u, { limit: 100_000, remaining: 40_000, resetAt: MIDNIGHT }, T0);

  // Plus account, other apps used 36k, we used 24k. Picking Standard (25k)
  // keeps Summonarr under 25k of its own: 1k left, under the 6,250 reserve.
  const standard = mdblistBudget("standard", u, T0);
  assert.deepEqual(standard, { limit: 25_000, remaining: 1_000, reserve: 6_250 });
  assert.equal(budgetAllows(standard, true), false);
  assert.equal(budgetAllows(standard, false), true);

  // Picking more than the account has: MDBList's number is the limit.
  const vip = mdblistBudget("vip20", u, T0);
  assert.deepEqual(vip, { limit: 100_000, remaining: 40_000, reserve: 25_000 });
});

test("the account running dry stops pages too, whatever the plan says", () => {
  let u = emptyUsage(T0);
  u = recordReport(u, { limit: 1_000, remaining: 0, resetAt: MIDNIGHT }, T0);
  const b = mdblistBudget("vip20", u, T0);
  assert.equal(b.remaining, 0);
  assert.equal(budgetAllows(b, false), false);
});

test("a late reply with MORE remaining is an older answer and is ignored", () => {
  let u = emptyUsage(T0);
  u = recordReport(u, { limit: 10_000, remaining: 500, resetAt: MIDNIGHT }, T0);
  u = recordSent(u, T0);
  const late = recordReport(u, { limit: 10_000, remaining: 520, resetAt: MIDNIGHT }, T0);
  assert.equal(late.report?.remaining, 500);
  assert.equal(late.sentSinceReport, 1, "the request still in flight stays counted");
  const newer = recordReport(u, { limit: 10_000, remaining: 499, resetAt: MIDNIGHT }, T0);
  assert.equal(newer.report?.remaining, 499);
  assert.equal(newer.sentSinceReport, 0);
});

test("a new UTC day: the report is stale and our own count starts again", () => {
  let u = emptyUsage(T0);
  u = recordReport(u, { limit: 1_000, remaining: 0, resetAt: MIDNIGHT }, T0);
  for (let i = 0; i < 5; i++) u = recordSent(u, T0);
  const nextDay = MIDNIGHT + 10 * MIN;
  const b = mdblistBudget("auto", u, nextDay);
  assert.deepEqual(b, { limit: 1_000, remaining: 1_000, reserve: 250 }, "the account limit is remembered, the spend is not");
  const sentNextDay = recordSent(u, nextDay);
  assert.equal(sentNextDay.sentToday, 1);
  assert.equal(mdblistBudget("auto", sentNextDay, nextDay).remaining, 999);
});

test("X-RateLimit-* headers: parsed when sane, rejected when not", () => {
  // A reset that is NOT midnight, so a parser that dropped the header and fell
  // back to midnight could not pass by coincidence (a real Unix timestamp is
  // ~1.79 billion — the first version capped header numbers at one billion).
  const reset = String((MIDNIGHT - 3_600_000) / 1000);
  assert.deepEqual(
    parseUsageHeaders(headers({ "x-ratelimit-limit": "100000", "x-ratelimit-remaining": "95790", "x-ratelimit-reset": reset }), T0),
    { limit: 100_000, remaining: 95_790, resetAt: MIDNIGHT - 3_600_000 },
  );
  assert.equal(parseUsageHeaders(headers({}), T0), null, "no headers, no report");
  assert.equal(parseUsageHeaders(headers({ "x-ratelimit-limit": "1000" }), T0), null);
  assert.equal(parseUsageHeaders(headers({ "x-ratelimit-limit": "abc", "x-ratelimit-remaining": "5" }), T0), null);
  assert.equal(parseUsageHeaders(headers({ "x-ratelimit-limit": "0", "x-ratelimit-remaining": "0" }), T0), null);
  assert.equal(parseUsageHeaders(headers({ "x-ratelimit-limit": "-5", "x-ratelimit-remaining": "1" }), T0), null);
  // remaining above the limit is clamped; a missing reset is the next midnight.
  assert.deepEqual(
    parseUsageHeaders(headers({ "x-ratelimit-limit": "1000", "x-ratelimit-remaining": "5000" }), T0),
    { limit: 1_000, remaining: 1_000, resetAt: MIDNIGHT },
  );
  // A reset in the past or days away is garbage: next midnight stands in.
  for (const bad of [String(T0 / 1000 - 60), String(T0 / 1000 + 5 * 86_400), "soon"]) {
    assert.equal(
      parseUsageHeaders(headers({ "x-ratelimit-limit": "1000", "x-ratelimit-remaining": "10", "x-ratelimit-reset": bad }), T0)?.resetAt,
      MIDNIGHT,
      bad,
    );
  }
});

test("limit errors: MDBList's two texts are told apart", () => {
  assert.equal(mdblistLimitKind("Daily API limit exceeded!"), "daily");
  assert.equal(mdblistLimitKind("API rate limit exceeded!"), "window");
  assert.equal(mdblistLimitKind("API limit reached! Upgrade your plan."), "other");
  assert.equal(mdblistLimitKind(null), "other");
});

test("pause length: Retry-After wins; else midnight, the next 5-minute window, or the hour", () => {
  assert.equal(parseRetryAfter("120", T0), 120_000);
  assert.equal(parseRetryAfter(new Date(T0 + 90_000).toUTCString(), T0), 90_000);
  assert.equal(parseRetryAfter("0", T0), null);
  assert.equal(parseRetryAfter("later", T0), null);
  assert.equal(parseRetryAfter(null, T0), null);

  assert.equal(mdblistPauseUntil({ kind: "window", retryAfter: "150", reset: null, now: T0 }), T0 + 150_000);
  assert.equal(mdblistPauseUntil({ kind: "daily", retryAfter: "600", reset: null, now: T0 }), T0 + 600_000);

  // No Retry-After.
  assert.equal(
    mdblistPauseUntil({ kind: "window", retryAfter: null, reset: null, now: T0 }),
    Date.UTC(2026, 9, 28, 7, 30, 0),
    "fixed windows: 07:27:30 waits for 07:30, not an hour",
  );
  assert.equal(mdblistPauseUntil({ kind: "daily", retryAfter: null, reset: null, now: T0 }), MIDNIGHT);
  assert.equal(
    mdblistPauseUntil({ kind: "daily", retryAfter: null, reset: String((MIDNIGHT - 3_600_000) / 1000), now: T0 }),
    MIDNIGHT - 3_600_000,
    "MDBList's own reset time beats our midnight",
  );
  assert.equal(mdblistPauseUntil({ kind: "other", retryAfter: null, reset: null, now: T0 }), T0 + DEFAULT_PAUSE_MS);
  assert.equal(DEFAULT_PAUSE_MS, 60 * MIN);

  // Bounds: never under a second, never past a day and an hour.
  assert.equal(mdblistPauseUntil({ kind: "other", retryAfter: "999999999", reset: null, now: T0 }), T0 + 25 * 60 * MIN);
  assert.equal(nextUtcMidnight(T0), MIDNIGHT);
});
