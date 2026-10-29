// MDBList's plans, the daily request limit each one buys, and the rules for how
// much of that limit Summonarr may spend. Pure and import-free so the rules are
// unit-tested on their own (tests/mdblist-plan.test.mts); mdblist.ts holds the
// live state and makes the calls.
//
// The table is MDBList's own supporter page (mdblist.memberful.com/join, read
// 2026-10-28). The Patreon page lists the same names with prices only. Only the
// daily request count matters here: Summonarr reads public lists, so the list
// and item allowances don't apply.
//
// Facts from MDBList's API docs (api.mdblist.com/schema/):
// - The limit is per ACCOUNT, shared by every API key and app on it.
// - It resets at 00:00 UTC. Successful replies carry X-RateLimit-Limit,
//   X-RateLimit-Remaining and X-RateLimit-Reset (a Unix timestamp in seconds).
// - Every plan is also limited to 1,000 reads per FIXED 5-minute window
//   (:00, :05, …).
// - Either limit answers 429 with Retry-After (seconds). The error text tells
//   them apart: "Daily API limit exceeded!" or "API rate limit exceeded!".
// - Not documented: whether a 200-id batch POST counts as 1 request or 200.
//   The budget below uses MDBList's own remaining count whenever a reply has
//   carried one, so it is right either way.

export const MDBLIST_PLANS = [
  { id: "free", dailyRequests: 1_000 },
  { id: "basic", dailyRequests: 10_000 },
  { id: "standard", dailyRequests: 25_000 },
  { id: "plus", dailyRequests: 100_000 },
  { id: "vip5", dailyRequests: 250_000 },
  { id: "vip10", dailyRequests: 500_000 },
  { id: "vip15", dailyRequests: 1_000_000 },
  { id: "vip20", dailyRequests: 1_500_000 },
] as const;

export type MdblistPlanId = (typeof MDBLIST_PLANS)[number]["id"];
// "auto": use the limit MDBList reports, with no cap of our own.
export type MdblistPlanSetting = "auto" | MdblistPlanId;

export const MDBLIST_PLAN_SETTING_KEY = "mdblistPlan";

export const MDBLIST_PLAN_CHOICES: readonly MdblistPlanSetting[] = [
  "auto",
  ...MDBLIST_PLANS.map((p) => p.id),
];

export function isMdblistPlanSetting(value: string): value is MdblistPlanSetting {
  return (MDBLIST_PLAN_CHOICES as readonly string[]).includes(value);
}

// A missing, blank or unknown stored value reads as "auto": the safe default is
// MDBList's own number, never a guessed plan.
export function parseMdblistPlanSetting(raw: string | null | undefined): MdblistPlanSetting {
  const value = raw?.trim() ?? "";
  return isMdblistPlanSetting(value) ? value : "auto";
}

export function planDailyRequests(id: MdblistPlanId): number {
  const plan = MDBLIST_PLANS.find((p) => p.id === id);
  return plan ? plan.dailyRequests : MDBLIST_PLANS[0].dailyRequests;
}

// The plan whose limit is exactly this number, for naming what MDBList reports.
export function planForDailyLimit(limit: number | null): MdblistPlanId | null {
  if (limit === null) return null;
  return MDBLIST_PLANS.find((p) => p.dailyRequests === limit)?.id ?? null;
}

// Background jobs (the daily pre-warm, the ratings sync, For You) stop while
// less than this share of the day's limit is left, so pages people open still
// get ratings late in the day.
export const BACKGROUND_RESERVE_FRACTION = 0.25;

const DAY_MS = 24 * 60 * 60 * 1000;

export function utcDayStart(now: number): number {
  return Math.floor(now / DAY_MS) * DAY_MS;
}

export function nextUtcMidnight(now: number): number {
  return utcDayStart(now) + DAY_MS;
}

// What MDBList last said about the account's day.
export interface MdblistUsageReport {
  limit: number;
  remaining: number;
  // When MDBList's day ends (ms). The report describes nothing after it.
  resetAt: number;
}

export interface MdblistUsage {
  report: MdblistUsageReport | null;
  // Requests sent since that report arrived, not yet covered by a newer one.
  sentSinceReport: number;
  // Summonarr's own count for the current UTC day. Lives in memory, so a
  // restart starts it again at zero; MDBList's report corrects it on the next
  // successful reply.
  day: number;
  sentToday: number;
}

export function emptyUsage(now: number): MdblistUsage {
  return { report: null, sentSinceReport: 0, day: utcDayStart(now), sentToday: 0 };
}

function rollDay(u: MdblistUsage, now: number): MdblistUsage {
  const day = utcDayStart(now);
  return u.day === day ? u : { ...u, day, sentToday: 0 };
}

// One request is about to go out.
export function recordSent(u: MdblistUsage, now: number): MdblistUsage {
  const rolled = rollDay(u, now);
  return { ...rolled, sentToday: rolled.sentToday + 1, sentSinceReport: rolled.sentSinceReport + 1 };
}

// A reply arrived carrying a report. Replies can land out of order, so within
// one day a report with MORE remaining than the one held is an older answer
// arriving late: it is ignored rather than handing requests back.
export function recordReport(u: MdblistUsage, report: MdblistUsageReport, now: number): MdblistUsage {
  const rolled = rollDay(u, now);
  const held = rolled.report;
  if (held && held.resetAt === report.resetAt && held.limit === report.limit && report.remaining > held.remaining) {
    return rolled;
  }
  return { ...rolled, report, sentSinceReport: 0 };
}

// A non-negative whole number of at most ten digits — enough for any request
// count and for a Unix timestamp in seconds — or null.
function headerInt(raw: string | null): number | null {
  if (raw === null) return null;
  const value = raw.trim();
  return /^\d{1,10}$/.test(value) ? Number(value) : null;
}

// Longest believable gap between now and the end of MDBList's day: a reset
// further out is garbled, so the next UTC midnight stands in for it.
const MAX_RESET_AHEAD_MS = DAY_MS + 60 * 60 * 1000;

function resetFromHeader(raw: string | null, now: number): number | null {
  const n = headerInt(raw);
  if (n === null) return null;
  const ms = n * 1000;
  return ms > now && ms <= now + MAX_RESET_AHEAD_MS ? ms : null;
}

// The X-RateLimit-* headers of a reply, or null when they are absent or don't
// make sense. A missing or garbled reset falls back to the next UTC midnight,
// which is when MDBList says the day ends.
export function parseUsageHeaders(get: (name: string) => string | null, now: number): MdblistUsageReport | null {
  const limit = headerInt(get("x-ratelimit-limit"));
  const remaining = headerInt(get("x-ratelimit-remaining"));
  if (limit === null || remaining === null || limit < 1) return null;
  return {
    limit,
    remaining: Math.min(remaining, limit),
    resetAt: resetFromHeader(get("x-ratelimit-reset"), now) ?? nextUtcMidnight(now),
  };
}

export interface MdblistBudget {
  // The day's limit Summonarr budgets against, or null while nothing is known
  // ("auto" before MDBList has reported). Null means no cap of our own; MDBList's
  // 429 is then the only stop.
  limit: number | null;
  // Requests left today under that limit, or null when the limit is unknown.
  remaining: number | null;
  // What background jobs leave untouched.
  reserve: number;
}

// How much Summonarr may still send today.
//
// Two limits can apply and the lower one wins:
// - the ACCOUNT's, from MDBList's report (every app on the account draws on it);
// - the plan the admin picked, which caps Summonarr's OWN requests. Picking a
//   lower plan than the account has keeps the rest for other apps.
export function mdblistBudget(plan: MdblistPlanSetting, u: MdblistUsage, now: number): MdblistBudget {
  const usage = rollDay(u, now);
  const reportedLimit = usage.report?.limit ?? null;
  const current = usage.report !== null && now < usage.report.resetAt ? usage.report : null;

  // The account's remaining: MDBList's own count when it is for today, else
  // the limit minus what we have sent since midnight (other apps unknown).
  const accountRemaining =
    current !== null ? current.remaining - usage.sentSinceReport
    : reportedLimit !== null ? reportedLimit - usage.sentToday
    : null;

  const ownCap = plan === "auto" ? null : planDailyRequests(plan);
  const ownRemaining = ownCap === null ? null : ownCap - usage.sentToday;

  const limit =
    ownCap === null ? reportedLimit
    : reportedLimit === null ? ownCap
    : Math.min(ownCap, reportedLimit);

  const candidates = [accountRemaining, ownRemaining].filter((n): n is number => n !== null);
  const remaining = candidates.length > 0 ? Math.max(0, Math.min(...candidates)) : null;
  const reserve = limit === null ? 0 : Math.ceil(limit * BACKGROUND_RESERVE_FRACTION);
  return { limit, remaining, reserve };
}

// Whether a call may go out under the budget. A page someone opened may use the
// day down to nothing; a background job stops at the reserve.
export function budgetAllows(budget: MdblistBudget, background: boolean): boolean {
  if (budget.remaining === null) return true;
  return background ? budget.remaining > budget.reserve : budget.remaining > 0;
}

// ── How long to pause after a limit error ──────────────────────────────────

export type MdblistLimitKind = "daily" | "window" | "other";

export function mdblistLimitKind(errorText: string | null | undefined): MdblistLimitKind {
  const text = (errorText ?? "").toLowerCase();
  if (text.includes("daily")) return "daily";
  if (text.includes("rate limit")) return "window";
  return "other";
}

// The pause when MDBList gives no hint of its own (no Retry-After, no
// recognisable error text).
export const DEFAULT_PAUSE_MS = 60 * 60 * 1000;
const WINDOW_MS = 5 * 60 * 1000;
const MIN_PAUSE_MS = 1_000;
const MAX_PAUSE_MS = DAY_MS + 60 * 60 * 1000;

// Retry-After as a delay in ms: either whole seconds or an HTTP date.
export function parseRetryAfter(raw: string | null, now: number): number | null {
  if (raw === null) return null;
  const value = raw.trim();
  if (/^\d{1,9}$/.test(value)) {
    const ms = Number(value) * 1000;
    return ms > 0 ? ms : null;
  }
  const at = Date.parse(value);
  if (!Number.isFinite(at)) return null;
  const ms = at - now;
  return ms > 0 ? ms : null;
}

export function mdblistPauseUntil(input: {
  kind: MdblistLimitKind;
  retryAfter: string | null;
  reset: string | null;
  now: number;
}): number {
  const { kind, now } = input;
  const retry = parseRetryAfter(input.retryAfter, now);
  let until: number;
  if (retry !== null) {
    until = now + retry;
  } else if (kind === "daily") {
    until = resetFromHeader(input.reset, now) ?? nextUtcMidnight(now);
  } else if (kind === "window") {
    // Fixed windows start at :00, :05, … UTC, so the next one starts at the
    // next multiple of five minutes.
    until = Math.floor(now / WINDOW_MS) * WINDOW_MS + WINDOW_MS;
  } else {
    until = now + DEFAULT_PAUSE_MS;
  }
  return Math.min(Math.max(until, now + MIN_PAUSE_MS), now + MAX_PAUSE_MS);
}
