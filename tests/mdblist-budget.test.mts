// Integration tests for the MDBList plan budget, pause and breaker in
// src/lib/mdblist.ts (the pure rules are in tests/mdblist-plan.test.mts).
// Pinned here, against a scripted fetch:
//   - every reply's X-RateLimit-* report is kept and shown (the Test button's
//     reply included), named by the plan its limit matches;
//   - a background call stops at the 25% reserve with ZERO fetches while a page
//     may still call, and says so once per day (guardrail 7b);
//   - the saved plan setting caps Summonarr's own requests, and a save applies
//     at once through invalidateMdblistPlanCache;
//   - a limit 429 pauses for exactly Retry-After (a 5-minute window no longer
//     costs an hour), and a daily one until MDBList's reset;
//   - the transport breaker: five timeouts in a row — singles and batches
//     alike, and a reply that stalls MID-BODY — pause every call for an hour,
//     and any response clears the count (seen live 2026-10-28);
//   - the pause and usage are PROCESS-wide (guardrail 27a): a cache-busted
//     second import of mdblist.ts and of omdb.ts sees the first one's pause.
//
// ORDER-DEPENDENT: the state is process-wide with no reset export, so the tests
// walk it forward with the mocked clock. Each file runs in its own process.
//
// No DB or network: prisma.setting / prisma.tmdbCache are shadowed, fetch is
// scripted, and dns/promises.lookup is stubbed.
import { test, beforeEach, mock } from "node:test";
import assert from "node:assert/strict";
import dns from "node:dns/promises";

process.env.TOKEN_ENCRYPTION_KEY = "ab".repeat(32);

const T0 = Date.UTC(2026, 9, 28, 7, 27, 30);
mock.timers.enable({ apis: ["Date"], now: T0 });
let clockNow = T0;
function advanceClock(ms: number): void {
  clockNow += ms;
  mock.timers.setTime(clockNow);
}
const MIDNIGHT = Date.UTC(2026, 9, 29, 0, 0, 0);
const HOUR_MS = 60 * 60 * 1000;

const fakeLookup = async () => [{ address: "93.184.216.34", family: 4 }];
(dns as { lookup: unknown }).lookup = fakeLookup;
if ((dns as { lookup: unknown }).lookup !== fakeLookup) {
  throw new Error("could not stub dns.lookup — aborting before a real DNS query can leave the process");
}

const warns: string[] = [];
const errors: string[] = [];
console.warn = (...args: unknown[]) => { warns.push(args.map(String).join(" ")); };
console.error = (...args: unknown[]) => { errors.push(args.map(String).join(" ")); };

const { prisma } = await import("../src/lib/prisma.ts");
const { shadowPrismaModel } = await import("./_helpers.mts");
const mdblist = await import("../src/lib/mdblist.ts");
const {
  fetchAndCacheMdblistForTmdb,
  fetchMdblistBatch,
  getMdblistUsageSnapshot,
  invalidateMdblistPlanCache,
  isMdblistQuotaLocked,
  mdblistPause,
  testMdblistConnection,
} = mdblist;

let planValue: string | null = null;
let omdbKey: string | null = "test-omdb-key";
const settingValues: Record<string, () => string | null> = {
  mdblistApiKey: () => "test-mdblist-key",
  mdblistPlan: () => planValue,
  omdbApiKey: () => omdbKey,
};
shadowPrismaModel(prisma, "setting", {
  findUnique: async (args: { where: { key: string } }) => {
    const value = settingValues[args.where.key]?.() ?? null;
    return value === null ? null : { key: args.where.key, value };
  },
});
shadowPrismaModel(prisma, "tmdbCache", {
  findUnique: async () => null,
  findMany: async () => [],
  upsert: async (args: { create: unknown }) => args.create,
  deleteMany: async () => ({ count: 0 }),
});

const fetchCalls: URL[] = [];
let respond: (url: URL) => Response = () => {
  throw new Error("unexpected fetch — script a responder for this test");
};
globalThis.fetch = (async (input: RequestInfo | URL) => {
  const url = new URL(String(input));
  fetchCalls.push(url);
  return respond(url);
}) as typeof fetch;

function json(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...headers } });
}
function usageHeaders(limit: number, remaining: number, resetAt = MIDNIGHT): Record<string, string> {
  return {
    "x-ratelimit-limit": String(limit),
    "x-ratelimit-remaining": String(remaining),
    "x-ratelimit-reset": String(Math.floor(resetAt / 1000)),
  };
}
// The shape safe-fetch turns into SafeFetchError("timeout").
function timeoutError(): Error {
  const err = new Error("The operation was aborted due to timeout");
  err.name = "TimeoutError";
  return err;
}
const title = { id: 1, title: "x", year: 2020, ratings: [{ source: "imdb", value: 7.5 }] };
const single = (id: number, background = false) =>
  fetchAndCacheMdblistForTmdb(id, "movie", `mdblist:tmdb:movie:${id}`, null, { background });

beforeEach(() => {
  fetchCalls.length = 0;
  warns.length = 0;
  errors.length = 0;
});

test("MDBList's usage report is kept from every reply — the Test button's too — and named by its plan", async () => {
  respond = () => json({ title: "Breaking Bad" }, 200, usageHeaders(100_000, 95_790));
  assert.equal(await testMdblistConnection(), "Breaking Bad");

  const snap = await getMdblistUsageSnapshot();
  assert.equal(snap.plan, "auto");
  assert.equal(snap.reportedLimit, 100_000);
  assert.equal(snap.reportedPlan, "plus");
  assert.equal(snap.usedToday, 4_210);
  assert.equal(snap.limit, 100_000);
  assert.equal(snap.remaining, 95_790);
  assert.equal(snap.reserve, 25_000);
  assert.equal(snap.backgroundStopped, false);
  assert.equal(snap.pausedUntil, null);
});

test("a background call stops at the reserve with zero fetches; a page still calls; one log line per day", async () => {
  // One request above the reserve: the background call goes out, and its reply
  // brings the account down to exactly the reserve. A page load seeds the
  // report first so the gate sees 25,001 left.
  respond = () => json(title, 200, usageHeaders(100_000, 25_001));
  await single(10);
  respond = () => json(title, 200, usageHeaders(100_000, 25_000));
  assert.equal((await single(11, true)).found, true, "25,001 left > 25,000 reserve: background may call");
  assert.equal(fetchCalls.length, 2);

  assert.equal(mdblistPause({ background: true }), "reserve");
  assert.equal(mdblistPause(), null, "a page is not held back by the reserve");
  assert.equal(isMdblistQuotaLocked({ background: true }), true, "For You reads MDBList as not answering");

  const refused = await single(12, true);
  assert.deepEqual(refused, { found: false, keyConfigured: true, quotaExhausted: true, transient: true });
  assert.equal((await fetchMdblistBatch([{ id: 13 }, { id: 14 }], "movie", { background: true })).size, 0);
  assert.equal(fetchCalls.length, 2, "background refusals send nothing");

  assert.equal((await single(15)).found, true, "a page still gets ratings");
  assert.equal(fetchCalls.length, 3);
  assert.equal(warns.filter((w) => w.includes("background jobs stop")).length, 1, "said once, not per refusal");
  assert.equal((await getMdblistUsageSnapshot()).backgroundStopped, true);
});

test("the ratings helpers carry the background flag to MDBList (For You and the ratings sync go through them)", async () => {
  // Still at the reserve from the test above. With no OMDb key the fallback
  // returns without a request, so every fetch here would be MDBList's.
  omdbKey = null;
  try {
    const { attachRatingsUnified, fetchUnifiedRatings } = await import("../src/lib/omdb-availability.ts");
    const item = {
      id: 16, mediaType: "movie" as const, title: "", overview: "", posterPath: null, backdropPath: null,
      releaseDate: null, releaseYear: null, voteAverage: 0,
    };
    await attachRatingsUnified([item], { blocking: true, deferToAfter: false, background: true });
    await fetchUnifiedRatings(17, "movie", null, null, { background: true });
    assert.equal(fetchCalls.length, 0, "a background batch, probe and single all stop at the reserve");

    respond = () => json(title);
    await attachRatingsUnified([{ ...item, id: 18 }], { blocking: true, deferToAfter: false });
    assert.ok(fetchCalls.length > 0, "the same call from a page still reaches MDBList");
    assert.ok(fetchCalls.every((u) => u.hostname === "api.mdblist.com"));
  } finally {
    omdbKey = "test-omdb-key";
  }
});

test("a background walk of several pages stops BETWEEN pages once a reply reaches the reserve", async () => {
  // A new report (a different reset time, so it is not mistaken for a late
  // reply): one request above the 25,000 reserve.
  const reset = MIDNIGHT - 60_000;
  respond = () => json(title, 200, usageHeaders(100_000, 25_001, reset));
  await single(19);
  assert.equal(mdblistPause({ background: true }), null, "25,001 left: the walk may start");

  omdbKey = null;
  try {
    const { attachRatingsUnified } = await import("../src/lib/omdb-availability.ts");
    const items = Array.from({ length: 201 }, (_, i) => ({
      id: 20_000 + i, mediaType: "movie" as const, title: "", overview: "", posterPath: null, backdropPath: null,
      releaseDate: null, releaseYear: null, voteAverage: 0,
    }));
    fetchCalls.length = 0;
    // Page 1's reply brings the account down to the reserve.
    respond = () => json([], 200, usageHeaders(100_000, 25_000, reset));
    await attachRatingsUnified(items, { blocking: true, deferToAfter: false, background: true });
    assert.equal(fetchCalls.length, 1, "page 2 and the single-title probe never went out");
  } finally {
    omdbKey = "test-omdb-key";
  }
});

test("the saved plan caps Summonarr's own count, and a save applies at once", async () => {
  // A new UTC day: the report is stale (its limit is remembered), our count is 0.
  advanceClock(MIDNIGHT - clockNow + 60_000);
  assert.equal(mdblistPause({ background: true }), null, "a new day lifts the reserve");

  // The clock jump expired the 30s memo: read it fresh while still on auto.
  assert.equal((await getMdblistUsageSnapshot()).plan, "auto");
  planValue = "free";
  // Before the memo is dropped, the old choice is still in force.
  assert.equal((await getMdblistUsageSnapshot()).plan, "auto");
  invalidateMdblistPlanCache();
  assert.equal((await getMdblistUsageSnapshot()).plan, "free");

  // Free = 1,000 a day for Summonarr: background stops at 750 of our own.
  respond = () => json(title);
  for (let i = 0; i < 749; i++) await single(1_000 + i);
  assert.equal(mdblistPause({ background: true }), null, "251 left");
  await single(2_000);
  assert.equal(mdblistPause({ background: true }), "reserve", "250 left of the 1,000 picked");
  const snap = await getMdblistUsageSnapshot();
  assert.equal(snap.limit, 1_000, "the lower of Free and the account's 100,000");
  assert.equal(snap.remaining, 250);

  fetchCalls.length = 0;
  assert.equal((await single(2_001, true)).found, false);
  assert.equal(fetchCalls.length, 0);

  planValue = null; // back to auto
  invalidateMdblistPlanCache();
  assert.equal((await single(2_002, true)).found, true, "auto: the account's 100,000 applies again");
});

test("a 5-minute-window 429 pauses for exactly Retry-After, not an hour", async () => {
  respond = () => json({ error: "API rate limit exceeded!" }, 429, { "retry-after": "120" });
  const tripped = await single(3_000);
  assert.deepEqual(tripped, { found: false, keyConfigured: true, quotaExhausted: true, transient: true });
  assert.equal(isMdblistQuotaLocked(), true);
  assert.equal((await getMdblistUsageSnapshot()).pausedUntil, new Date(clockNow + 120_000).toISOString());
  assert.ok(warns.some((w) => w.includes("API rate limit exceeded!") && w.includes("2 min")), "the warn names MDBList's text and the real length");

  fetchCalls.length = 0;
  respond = () => json(title);
  assert.equal((await single(3_001)).found, false);
  assert.equal(fetchCalls.length, 0, "paused: nothing goes out");
  advanceClock(119_999);
  assert.equal(isMdblistQuotaLocked(), true);
  advanceClock(1);
  assert.equal(isMdblistQuotaLocked(), false);
  assert.equal((await single(3_002)).found, true);
});

test("a daily-limit 429 without Retry-After pauses until MDBList's reset", async () => {
  const reset = clockNow + 5 * HOUR_MS;
  respond = () => json({ error: "Daily API limit exceeded!" }, 429, { "x-ratelimit-reset": String(Math.floor(reset / 1000)) });
  assert.equal((await fetchMdblistBatch([{ id: 4_000 }], "movie")).size, 0);
  assert.equal((await getMdblistUsageSnapshot()).pausedUntil, new Date(reset).toISOString());
  advanceClock(5 * HOUR_MS);
  assert.equal(isMdblistQuotaLocked(), false);
});

test("the breaker: five timeouts in a row, singles and batches mixed, pause every call for an hour", async () => {
  respond = () => { throw timeoutError(); };
  for (let i = 0; i < 2; i++) await single(5_000 + i);
  await fetchMdblistBatch([{ id: 5_100 }], "movie");
  await fetchMdblistBatch([{ id: 5_101 }], "tv");
  assert.equal(isMdblistQuotaLocked(), false, "four timeouts are a blip");

  await single(5_002);
  assert.equal(isMdblistQuotaLocked(), true, "the fifth in a row is a reachability verdict");
  assert.ok(warns.some((w) => w.includes("5 consecutive transport failures (timeout)") && w.includes("60 min")));

  fetchCalls.length = 0;
  assert.equal((await fetchMdblistBatch([{ id: 5_200 }], "movie")).size, 0);
  assert.equal(fetchCalls.length, 0, "no page waits out another timeout");
  advanceClock(HOUR_MS);
  assert.equal(isMdblistQuotaLocked(), false);
});

test("any response clears the count — a 502 in the middle means no trip", async () => {
  respond = () => { throw timeoutError(); };
  for (let i = 0; i < 4; i++) await single(6_000 + i);
  respond = () => new Response("bad gateway", { status: 502 });
  await single(6_100);
  respond = () => { throw timeoutError(); };
  for (let i = 0; i < 4; i++) await single(6_200 + i);
  assert.equal(isMdblistQuotaLocked(), false, "4 + 4 is not 5 in a row");
});

test("a reply that stalls MID-BODY counts as a failure too (the body is read inside the timeout)", async () => {
  // The count stands at 4 from the test above; one clean reply resets it.
  respond = () => json(title);
  await single(7_000);
  respond = () =>
    new Response(new ReadableStream({ pull(controller) { controller.error(timeoutError()); } }), { status: 200 });
  for (let i = 0; i < 4; i++) await single(7_100 + i);
  assert.equal(isMdblistQuotaLocked(), false);
  await single(7_200);
  assert.equal(isMdblistQuotaLocked(), true, "headers arriving is not an answer; the body stalled five times");
});

test("guardrail 27a: a second copy of mdblist.ts (another chunk) sees the same pause and usage", async () => {
  // A specifier in a variable, as tests/session-revocation.test.mts does: a
  // literal "?chunk=" path is not a module TypeScript can resolve.
  const pageSpecifier = "../src/lib/mdblist.ts?chunk=page";
  const other: typeof import("../src/lib/mdblist.ts") = await import(pageSpecifier);
  assert.notEqual(other, mdblist, "the two imports must be distinct module instances");
  assert.equal(other.isMdblistQuotaLocked(), true, "the pause tripped above, through the first copy");
  const snap = await other.getMdblistUsageSnapshot();
  assert.equal(snap.reportedLimit, 100_000, "and the usage MDBList reported to the first copy");
});

test("guardrail 27a: OMDb's lockout is process-wide too", async () => {
  const cronSpecifier = "../src/lib/omdb.ts?chunk=cron";
  const pageSpecifier = "../src/lib/omdb.ts?chunk=page";
  const cron: typeof import("../src/lib/omdb.ts") = await import(cronSpecifier);
  const page: typeof import("../src/lib/omdb.ts") = await import(pageSpecifier);
  assert.notEqual(cron, page);
  assert.equal(page.isOmdbQuotaLocked(), false);
  respond = () => new Response("slow down", { status: 429 });
  await cron.getOmdbRatings("tt0133093").catch(() => {});
  assert.equal(cron.isOmdbQuotaLocked(), true);
  assert.equal(page.isOmdbQuotaLocked(), true, "a lockout tripped by a cron route stops page renders too");
});
