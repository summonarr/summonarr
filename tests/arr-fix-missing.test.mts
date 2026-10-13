// Admin → Missing, "Search selected" — the bulk runner (src/lib/bulk-search-run.ts,
// driven by missing-report.tsx) and the search route's per-admin rate limit.
// What is pinned:
//
//   1. At most BULK_SEARCH_CONCURRENCY (2) requests are in flight, and every
//      row is taken once.
//   2. CANCEL stops further dequeues: the requests already sent settle, the
//      rest are never sent and are reported as not run.
//   3. A row that is busy or already searched WHEN IT IS DEQUEUED is skipped,
//      never searched twice — the check is at dequeue, not at the run's start.
//   4. A 409 ("nothing missing any more") is "already", not a failure.
//   5. A 429 waits out its Retry-After and retries that row exactly ONCE; a
//      cancel during the wait stops the retry.
//   6. The cap: a run takes at most BULK_SEARCH_MAX (100) rows; "select all"
//      ticks the first 100.
//   7. The route: LIMIT_PER_MIN searches per admin, then 429 with Retry-After
//      and no upstream call; another admin is unaffected; a malformed body is
//      refused before the limiter and spends none of it; a search still queues
//      exactly what is missing. Its failure log line never carries the body's
//      instance raw (sanitizeForLog).
//   8. The page's cap counts EVERY ticked row of the tab — the ones a filter
//      now hides too — and the button and the run use that same list, so a
//      filter change can't tick past the cap or make the button lie.
//   9. Removing a title in the title manager re-reads the list.
//  10. A cutoff listing that runs past the page ceiling is reported as
//      truncated per instance (read of total), never as the complete list.
//  11. The page's load/selection bookkeeping (the 2026-10-12 audit fixes): a
//      row's own Search unticks it, a reload is tracked per key with only the
//      newest load of a key committing, a fresh listing keeps a row whose
//      search is still in flight, and the tables are paged.
//
// Route harness: the tests/arr-missing-routes.test.mts idiom — the real
// withAdmin handler with a signed session JWT inside a synthetic request scope,
// over in-memory prisma stubs, with Radarr scripted on an RFC1918 literal.
import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import dns from "node:dns/promises";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { AsyncLocalStorage } from "node:async_hooks";

(globalThis as { AsyncLocalStorage?: unknown }).AsyncLocalStorage = AsyncLocalStorage;

process.env.TOKEN_ENCRYPTION_KEY = "ab".repeat(32);
process.env.NEXTAUTH_SECRET = "missing-fix-test-secret-0123456789abcdef";
process.env.AUTH_URL = "http://localhost:3000";
process.env.TRUST_PROXY = "true";
(process.env as Record<string, string | undefined>).NODE_ENV = "test";

const fakeLookup = async () => [{ address: "10.0.0.250", family: 4 }];
(dns as { lookup: unknown }).lookup = fakeLookup;
if ((dns as { lookup: unknown }).lookup !== fakeLookup) throw new Error("could not stub dns.lookup");

console.warn = () => {};
console.error = () => {};

const {
  BULK_SEARCH_CONCURRENCY,
  BULK_SEARCH_CONFIRM_OVER,
  BULK_SEARCH_MAX,
  RATE_LIMIT_DEFAULT_WAIT_MS,
  RATE_LIMIT_MAX_WAIT_MS,
  abortableSleep,
  capSelection,
  retryAfterMs,
  runBulkSearch,
  searchAttemptFromResponse,
} = await import("../src/lib/bulk-search-run.ts");
type SearchAttempt = import("../src/lib/bulk-search-run.ts").SearchAttempt;

const STARTED: SearchAttempt = { outcome: "started", message: "" };
const tick = () => new Promise<void>((r) => setTimeout(r, 0));
const noSleep = async () => {};
function deferred<T>() {
  let resolve!: (v: T) => void;
  const promise = new Promise<T>((r) => { resolve = r; });
  return { promise, resolve };
}
const rowsOf = (n: number) => Array.from({ length: n }, (_, i) => i);

// ── 1: concurrency ───────────────────────────────────────────────────────────

test("runner: at most two requests are in flight, and every row is taken exactly once", async () => {
  assert.equal(BULK_SEARCH_CONCURRENCY, 2);
  let inFlight = 0;
  let peak = 0;
  const taken: number[] = [];
  const summary = await runBulkSearch(rowsOf(9), {
    signal: new AbortController().signal,
    skip: () => false,
    attempt: async (row) => {
      inFlight++;
      peak = Math.max(peak, inFlight);
      taken.push(row);
      await new Promise((r) => setTimeout(r, 2));
      inFlight--;
      return STARTED;
    },
    onSettled: () => {},
  });
  assert.equal(peak, 2);
  assert.deepEqual([...taken].sort((a, b) => a - b), rowsOf(9));
  assert.deepEqual({ ...summary, failed: summary.failed.length }, { started: 9, already: 0, failed: 0, skipped: 0, notRun: 0, cancelled: false });
});

// ── 2: cancel ────────────────────────────────────────────────────────────────

test("runner: cancel stops further dequeues — the two in flight settle, the rest are never sent", async () => {
  const controller = new AbortController();
  const gates: Array<ReturnType<typeof deferred<SearchAttempt>>> = [];
  const taken: number[] = [];
  const settled: Array<[number, string]> = [];
  const run = runBulkSearch(rowsOf(10), {
    signal: controller.signal,
    skip: () => false,
    attempt: (row) => {
      taken.push(row);
      // Only the first two are held open; anything taken after the cancel
      // answers at once, so a runner that ignores the cancel fails this test
      // instead of hanging it.
      if (gates.length >= 2) return Promise.resolve(STARTED);
      const d = deferred<SearchAttempt>();
      gates.push(d);
      return d.promise;
    },
    onSettled: (row, outcome) => settled.push([row, outcome]),
  });
  await tick();
  assert.deepEqual(taken, [0, 1]);
  controller.abort();
  for (const g of gates) g.resolve(STARTED);
  const summary = await run;
  assert.deepEqual(taken, [0, 1], "nothing taken after the cancel");
  assert.deepEqual(settled, [[0, "started"], [1, "started"]]);
  assert.equal(summary.notRun, 8);
  assert.equal(summary.cancelled, true);
  assert.equal(summary.started, 2);
});

// ── 3: skip at dequeue ───────────────────────────────────────────────────────

test("runner: a row that became busy, or was already searched, by the time it is dequeued is skipped — never searched", async () => {
  // Row 4 is already searched when the run starts; row 3 becomes busy (a
  // per-row click) only while row 0 is being searched — after the run began.
  const busy = new Set<number>([4]);
  const taken: number[] = [];
  const settled = new Map<number, string>();
  const summary = await runBulkSearch(rowsOf(6), {
    signal: new AbortController().signal,
    skip: (row) => busy.has(row),
    attempt: async (row) => {
      taken.push(row);
      if (row === 0) busy.add(3);
      await tick();
      return STARTED;
    },
    onSettled: (row, outcome) => settled.set(row, outcome),
  });
  assert.ok(!taken.includes(3), "row 3 was not searched again");
  assert.ok(!taken.includes(4), "row 4 was not searched again");
  assert.equal(settled.get(3), "skipped");
  assert.equal(settled.get(4), "skipped");
  assert.equal(summary.skipped, 2);
  assert.equal(summary.started, 4);
});

// ── 4: 409 ───────────────────────────────────────────────────────────────────

test("a 409 is 'already' (the title is complete), never a failure; other answers map as expected", async () => {
  assert.deepEqual(searchAttemptFromResponse(409, "Nothing is missing", null), { outcome: "already", message: "Nothing is missing" });
  assert.deepEqual(searchAttemptFromResponse(202, "", null), { outcome: "started", message: "" });
  for (const status of [400, 404, 500, 502]) {
    assert.deepEqual(searchAttemptFromResponse(status, "nope", null), { outcome: "failed", message: "nope" }, String(status));
  }
  assert.deepEqual(searchAttemptFromResponse(429, "slow down", "60"), { outcome: "rateLimited", message: "slow down", retryAfterMs: 60_000 });

  const summary = await runBulkSearch(rowsOf(3), {
    signal: new AbortController().signal,
    skip: () => false,
    attempt: async (row) => (row === 1 ? searchAttemptFromResponse(409, "complete", null) : STARTED),
    onSettled: () => {},
  });
  assert.equal(summary.already, 1);
  assert.deepEqual(summary.failed, []);
  assert.equal(summary.started, 2);
});

// ── 5: 429 ───────────────────────────────────────────────────────────────────

test("runner: a 429 waits out its Retry-After, then retries that row once", async () => {
  const sleeps: number[] = [];
  const calls = new Map<number, number>();
  const summary = await runBulkSearch(rowsOf(3), {
    signal: new AbortController().signal,
    skip: () => false,
    attempt: async (row) => {
      const n = (calls.get(row) ?? 0) + 1;
      calls.set(row, n);
      return row === 1 && n === 1 ? searchAttemptFromResponse(429, "slow down", "45") : STARTED;
    },
    onSettled: () => {},
    sleep: async (ms) => { sleeps.push(ms); },
  });
  assert.deepEqual(sleeps, [45_000]);
  assert.equal(calls.get(1), 2);
  assert.equal(summary.started, 3);
  assert.deepEqual(summary.failed, []);
});

test("runner: a second 429 for the same row is a failure — it is retried once, not again", async () => {
  let calls = 0;
  const settled: Array<[string, string]> = [];
  const summary = await runBulkSearch([7], {
    signal: new AbortController().signal,
    skip: () => false,
    attempt: async () => {
      calls++;
      return searchAttemptFromResponse(429, "slow down", null);
    },
    onSettled: (_row, outcome, message) => settled.push([outcome, message]),
    sleep: noSleep,
  });
  assert.equal(calls, 2);
  assert.deepEqual(summary.failed, [7]);
  assert.deepEqual(settled, [["failed", "slow down"]]);
});

test("runner: a cancel during the 429 wait stops the retry; the row is failed and nothing else is taken", async () => {
  const controller = new AbortController();
  const taken: number[] = [];
  const summary = await runBulkSearch(rowsOf(5), {
    signal: controller.signal,
    skip: () => false,
    attempt: async (row) => {
      taken.push(row);
      return row === 0 ? searchAttemptFromResponse(429, "slow down", "60") : new Promise<SearchAttempt>((r) => setTimeout(() => r(STARTED), 5));
    },
    onSettled: () => {},
    sleep: async (_ms, signal) => {
      controller.abort();
      assert.equal(signal.aborted, true);
    },
  });
  assert.deepEqual(taken, [0, 1], "row 0 not retried; nothing after the cancel");
  assert.deepEqual(summary.failed, [0]);
  assert.equal(summary.cancelled, true);
  assert.equal(summary.notRun, 3);
});

test("retryAfterMs: delta-seconds within the limiter window; anything else waits the default", () => {
  assert.equal(retryAfterMs("60"), 60_000);
  assert.equal(retryAfterMs(" 12 "), 12_000);
  assert.equal(retryAfterMs("3600"), RATE_LIMIT_MAX_WAIT_MS);
  assert.equal(retryAfterMs("0"), 1_000);
  for (const v of [null, "", "abc", "-5", "1.5", "Wed, 21 Oct 2026 07:28:00 GMT"]) {
    assert.equal(retryAfterMs(v), RATE_LIMIT_DEFAULT_WAIT_MS, String(v));
  }
});

test("abortableSleep resolves as soon as the signal aborts", async () => {
  const controller = new AbortController();
  const t0 = performance.now();
  const sleeping = abortableSleep(10_000, controller.signal);
  setTimeout(() => controller.abort(), 5);
  await sleeping;
  assert.ok(performance.now() - t0 < 1_000);
  await abortableSleep(10_000, controller.signal); // already aborted: immediate
});

test("runner: a throwing attempt fails its row and the run carries on", async () => {
  const summary = await runBulkSearch(rowsOf(4), {
    signal: new AbortController().signal,
    skip: () => false,
    attempt: async (row) => {
      if (row === 1) throw new Error("boom");
      return STARTED;
    },
    onSettled: () => {},
  });
  assert.deepEqual(summary.failed, [1]);
  assert.equal(summary.started, 3);
});

// ── 6: the cap ───────────────────────────────────────────────────────────────

test("the cap: a run takes at most 100 rows, and 'select all' ticks the first 100 in the order shown", async () => {
  assert.equal(BULK_SEARCH_MAX, 100);
  assert.equal(BULK_SEARCH_CONFIRM_OVER, 10);
  assert.deepEqual(capSelection(rowsOf(150)), rowsOf(100));
  assert.deepEqual(capSelection(rowsOf(7)), rowsOf(7));
  let attempts = 0;
  let progress = 0;
  const summary = await runBulkSearch(rowsOf(150), {
    signal: new AbortController().signal,
    skip: () => false,
    attempt: async () => {
      attempts++;
      return STARTED;
    },
    onSettled: () => {},
    onProgress: (done) => { progress = done; },
  });
  assert.equal(attempts, 100);
  assert.equal(progress, 100);
  assert.equal(summary.started, 100);
  assert.equal(summary.notRun, 0);
});

// ── 7: the route ─────────────────────────────────────────────────────────────

const RADARR = "http://10.0.0.5:7878";
type Call = { origin: string; method: string; path: string; body: unknown };
let calls: Call[] = [];
let radarrMovies: unknown[] = [];
// /api/v3/wanted/cutoff: how many records the arr says it has (served 500 a page).
let cutoffTotal = 0;

globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
  const url = new URL(String(input));
  const method = init?.method ?? "GET";
  const body = typeof init?.body === "string" ? JSON.parse(init.body) : undefined;
  calls.push({ origin: url.origin, method, path: url.pathname, body });
  if (method === "POST" && url.pathname === "/api/v3/command") return Response.json({ id: calls.length, status: "queued", ...body }, { status: 201 });
  if (method === "GET" && url.pathname === "/api/v3/qualityprofile") return Response.json([]);
  if (method === "GET" && url.pathname === "/api/v3/wanted/cutoff") {
    const page = Number(url.searchParams.get("page"));
    const size = Number(url.searchParams.get("pageSize"));
    const from = (page - 1) * size;
    const records = Array.from({ length: Math.max(0, Math.min(size, cutoffTotal - from)) }, (_, i) => (
      { id: from + i + 1, title: `Movie ${from + i + 1}`, hasFile: true, movieFile: { qualityCutoffNotMet: true } }
    ));
    return Response.json({ page, pageSize: size, totalRecords: cutoffTotal, records });
  }
  const movieById = /^\/api\/v3\/movie\/(\d+)$/.exec(url.pathname);
  if (method === "GET" && movieById) {
    const row = radarrMovies.find((m) => (m as { id: number }).id === Number(movieById[1]));
    return row ? Response.json(row) : new Response("not found", { status: 404 });
  }
  throw new Error(`unexpected ${method} ${url}`);
}) as unknown as typeof fetch;

const cjsRequire = createRequire(import.meta.url);
type RunStore = { run<T>(store: unknown, fn: () => T): T };
const { workAsyncStorage } = cjsRequire("next/dist/server/app-render/work-async-storage.external.js") as { workAsyncStorage: RunStore };
const { workUnitAsyncStorage } = cjsRequire("next/dist/server/app-render/work-unit-async-storage.external.js") as { workUnitAsyncStorage: RunStore };
const { RequestCookies } = cjsRequire("next/dist/server/web/spec-extension/cookies.js") as { RequestCookies: new (h: Headers) => unknown };
const { RequestCookiesAdapter } = cjsRequire("next/dist/server/web/spec-extension/adapters/request-cookies.js") as { RequestCookiesAdapter: { seal(c: unknown): unknown } };
const { HeadersAdapter } = cjsRequire("next/dist/server/web/spec-extension/adapters/headers.js") as { HeadersAdapter: { seal(h: Headers): unknown } };

const { NextRequest } = await import("next/server");
const { prisma } = await import("../src/lib/prisma.ts");
const { shadowPrismaModel } = await import("./_helpers.mts");
const { signSessionJwt } = await import("../src/lib/session-jwt.ts");
const { getSessionCookieName } = await import("../src/lib/session-cookie.ts");
const { Permission } = await import("../src/lib/permissions.ts");
const { invalidateFeatureFlagCache } = await import("../src/lib/features.ts");

const usersById = new Map<string, Record<string, unknown>>();
const sessionRows = new Set<string>();
shadowPrismaModel(prisma, "authSession", {
  findUnique: async (args: { where: { sessionId: string } }) =>
    sessionRows.has(args.where.sessionId) ? { id: `row-${args.where.sessionId}`, sessionId: args.where.sessionId } : null,
  update: async () => ({}),
});
shadowPrismaModel(prisma, "user", {
  findUnique: async (args: { where: { id: string } }) => {
    const u = usersById.get(args.where.id);
    return u ? { ...u } : null;
  },
  update: async () => ({}),
});
let sessionSeq = 0;
async function mintSession(): Promise<string> {
  sessionSeq++;
  const userId = `fix-admin-${sessionSeq}`;
  const sessionId = `fix-sess-${sessionSeq}`;
  usersById.set(userId, {
    role: "ADMIN", permissions: Permission.ADMIN, mediaServer: null, sessionsRevokedAt: null,
    passwordChangedAt: null, deactivatedAt: null, email: `f${sessionSeq}@example.com`, notificationEmail: null,
  });
  sessionRows.add(sessionId);
  const iat = Math.floor(Date.now() / 1000);
  return signSessionJwt(
    { id: userId, role: "ADMIN", permissions: Permission.ADMIN.toString(), provider: "credentials", sessionId, expiresAt: iat + 86_400 },
    { expiresInSeconds: 7_200, iat },
  );
}
const COOKIE = getSessionCookieName();

const settings = new Map<string, string>();
shadowPrismaModel(prisma, "setting", {
  findMany: async (args?: { where?: { key?: { in?: string[] } } }) => {
    const keys = args?.where?.key?.in;
    return [...settings.entries()].filter(([k]) => !keys || keys.includes(k)).map(([key, value]) => ({ key, value }));
  },
  findUnique: async (args: { where: { key: string } }) => {
    const v = settings.get(args.where.key);
    return v === undefined ? null : { key: args.where.key, value: v };
  },
});

shadowPrismaModel(prisma, "tmdbMediaCore", { findMany: async () => [] });

const searchRoute = await import("../src/app/api/admin/missing/search/route.ts");
const missingData = await import("../src/lib/arr-missing-data.ts");

function inScope<T>(fn: () => Promise<T>): Promise<T> {
  const workStore = { route: "/missing-fix.test", forceStatic: false, dynamicShouldError: false, afterContext: { after: () => {} } };
  const h = new Headers();
  const requestStore = {
    type: "request", phase: "render",
    headers: HeadersAdapter.seal(h),
    cookies: RequestCookiesAdapter.seal(new RequestCookies(h)),
    usedDynamic: false,
  };
  return workAsyncStorage.run(workStore, () => workUnitAsyncStorage.run(requestStore, fn));
}
const post = (token: string, body: unknown) =>
  inScope(() => (searchRoute.POST as unknown as (r: unknown, c: unknown) => Promise<Response>)(
    new NextRequest("http://localhost:3000/api/admin/missing/search", {
      method: "POST",
      headers: { "content-type": "application/json", cookie: `${COOKIE}=${token}` },
      body: JSON.stringify(body),
    }),
    undefined,
  ));

const DAY = 86_400_000;
const ago = (d: number) => new Date(Date.now() - d * DAY).toISOString();
const LIMIT = 120;
// A movie that gained a file: each search is one live GET and a 409, no command.
const COMPLETE = { service: "radarr", instance: "", arrId: 3 };

beforeEach(() => {
  calls = [];
  settings.clear();
  settings.set("radarrUrl", RADARR);
  settings.set("radarrApiKey", "radarr-key");
  invalidateFeatureFlagCache();
  cutoffTotal = 0;
  radarrMovies = [
    { id: 1, tmdbId: 101, title: "Released, no file", monitored: true, hasFile: false, digitalRelease: ago(5) },
    { id: 3, tmdbId: 103, title: "Has file", monitored: true, hasFile: true, physicalRelease: ago(100) },
  ];
});

test("route: 120 searches a minute per admin, then 429 with Retry-After — and the 429 never reaches Radarr", async () => {
  const token = await mintSession();
  for (let i = 0; i < LIMIT; i++) {
    assert.equal((await post(token, COMPLETE)).status, 409, `request ${i + 1}`);
  }
  const before = calls.length;
  const res = await post(token, COMPLETE);
  assert.equal(res.status, 429);
  assert.equal(res.headers.get("Retry-After"), "60");
  assert.ok(typeof (await res.json()).error === "string");
  assert.equal(calls.length, before, "a rate-limited search makes no upstream call");

  // Per ADMIN: another admin's budget is untouched.
  assert.equal((await post(await mintSession(), COMPLETE)).status, 409);
});

test("route: a malformed body is refused before the limiter and spends none of it", async () => {
  const token = await mintSession();
  for (let i = 0; i < LIMIT; i++) {
    assert.equal((await post(token, { service: "radarr", arrId: 0 })).status, 400);
  }
  assert.equal((await post(token, COMPLETE)).status, 409, "the budget is still whole");
});

test("route: under the limit a search still queues exactly MoviesSearch for that movie", async () => {
  const res = await post(await mintSession(), { service: "radarr", instance: "", arrId: 1 });
  assert.equal(res.status, 202);
  assert.deepEqual(await res.json(), { commands: 1, seasons: [], episodes: 0 });
  assert.deepEqual(calls.filter((c) => c.method === "POST").map((c) => ({ origin: c.origin, body: c.body })), [
    { origin: RADARR, body: { name: "MoviesSearch", movieIds: [1] } },
  ]);
});

test("route: its failure log line runs the body's instance through sanitizeForLog, never raw", () => {
  const src = readFileSync(new URL("../src/app/api/admin/missing/search/route.ts", import.meta.url), "utf8");
  assert.match(src, /instance "\$\{sanitizeForLog\(instance\)\}" search failed/);
  assert.doesNotMatch(src, /"\$\{instance\}"/, "no raw interpolation of the slug");
});

// ── 8: the page's selection ──────────────────────────────────────────────────

const missingPage = () => readFileSync(new URL("../src/components/admin/missing-report.tsx", import.meta.url), "utf8");

test("page: the cap counts every ticked row of the tab — on another page, hidden by a filter or not — and the button and the run take that same list", () => {
  const src = missingPage();
  assert.match(
    src,
    /const selectedHidden = \(\(report\?\.items \?\? \[\]\) as ReadonlyArray<BulkRow>\)\.filter\(\(r\) => !listedKeys\.has\(selKey\(r\)\) && selected\.has\(selKey\(r\)\) && isOpen\(r\)\);/,
    "the ticks a filter hides come from the UNFILTERED listing",
  );
  assert.match(src, /const listedKeys = new Set\(currentRows\.map\(selKey\)\);/, "listed = every page of the filtered list");
  assert.match(src, /const selectedListed = currentRows\.filter\(\(r\) => selected\.has\(selKey\(r\)\) && isOpen\(r\)\);/, "ticks on other pages count");
  assert.match(src, /const selectedHere = \[\.\.\.selectedListed, \.\.\.selectedHidden\];/);
  assert.match(src, /const atCap = selectedHere\.length >= BULK_SEARCH_MAX;/, "the cap counts them all");
  assert.match(src, /else if \(!atCap\) next\.add\(k\);/, "a tick past the cap is refused");
  assert.match(src, /const toRun = capSelection\(selectedHere\);/);
  assert.match(src, /t\("adminArr\.missingBulk\.search", \{ count: toRun\.length \}\)/, "the button says what the run takes");
  assert.match(src, /t\("adminArr\.missingBulk\.searchCutoff", \{ count: toRun\.length \}\)/);
  assert.doesNotMatch(src, /missingBulk\.search(?:Cutoff)?", \{ count: selectedHere\.length \}/, "never the uncapped count");
  assert.match(src, /const rows = capSelection\(selectedHere\);/);
  assert.match(src, /void searchSelected\(current, capSelection\(selectedHere\)\)/);
  assert.match(src, /const roomOnPage = BULK_SEARCH_MAX - selectedOffPage - selectedHidden\.length;/, "select-all leaves room for every tick elsewhere");
  assert.match(src, /capSelection\(selectable, roomOnPage\)/);
});

// The body of `function name(` up to the next line that closes it at the
// component's indentation.
function fnBody(src: string, head: string): string {
  const start = src.indexOf(head);
  assert.ok(start >= 0, `${head} exists`);
  const end = src.indexOf("\n  }\n", start);
  return src.slice(start, end);
}

test("page: a row's own Search unticks it, so a failed search can't bring a tick back past the cap", () => {
  const body = fnBody(missingPage(), "async function startSearch(");
  const untick = body.search(/setSelected\(\(prev\) => \{[\s\S]*?next\.delete\(k\);[\s\S]*?\}\);/);
  assert.ok(untick >= 0, "startSearch removes the row from the selection");
  assert.ok(untick < body.indexOf("requestSearch("), "before the request goes out");
  assert.match(body, /const k = `\$\{key\}\|\$\{rowKey\(row\)\}`;/, "the row's own key");
  // The bulk runner's own requests never untick (it clears the selection itself when it ends).
  assert.doesNotMatch(fnBody(missingPage(), "async function requestSearch("), /setSelected\(/);
});

test("page: a list's reload is tracked per key — a bulk run or a second listing never starts while that list's load is out, and only the newest load of a key commits", () => {
  const src = missingPage();
  assert.doesNotMatch(src, /useState<ReportKey \| null>/, "no single shared loading slot");
  assert.doesNotMatch(src, /\bloading === current\b|\bloading !== current\b/);
  assert.match(src, /const \[loadingKeys, setLoadingKeys\] = useState<ReadonlySet<ReportKey>>\(new Set\(\)\);/);
  assert.match(src, /const loadingHere = loadingKeys\.has\(current\);/);
  assert.match(src, /const needsLoad = configured\[service\] && !reports\[current\] && !errors\[current\] && !loadingHere;/, "no second listing of a list already loading");
  assert.match(fnBody(src, "function requestBulk("), /if \(rows\.length === 0 \|\| bulkRunning \|\| loadingHere\) return;/);
  assert.match(fnBody(src, "function confirmBulk("), /c\.key === current && !loadingKeys\.has\(current\)/);
  assert.match(src, /<Button size="sm" disabled=\{bulkRunning \|\| loadingHere\} onClick=\{requestBulk\}>/, "Search selected is off while this list loads");
  assert.match(src, /onClick=\{\(\) => void load\(service, mode\)\} disabled=\{loadingHere \|\| bulk\?\.key === current\}/, "Refresh too");

  const load = src.slice(src.indexOf("const load = useCallback("), src.indexOf("}, [t, updateSearches]);"));
  assert.match(load, /const seq = \(loadSeq\.current\[k\] \?\? 0\) \+ 1;\s*loadSeq\.current\[k\] = seq;/);
  assert.match(load, /const superseded = \(\) => loadSeq\.current\[k\] !== seq;/);
  const ok = load.indexOf("const data = await res.json();");
  assert.ok(ok >= 0 && load.indexOf("if (superseded()) return;", ok) < load.indexOf("setReports(", ok), "a superseded load never writes the listing");
  const failed = load.indexOf("if (!res.ok) {");
  assert.ok(load.indexOf("if (superseded()) return;", failed) < load.indexOf("setErrors((e) => ({ ...e, [k]: message }))"), "nor its error");
  assert.ok(load.indexOf("if (superseded()) return;", load.indexOf("} catch {")) < load.indexOf('t("adminManage.missing.error.loadNetwork")'), "nor its network error");
  assert.match(load, /finally \{\s*if \(!superseded\(\)\) \{\s*setLoadingKeys\(\(prev\) => \{\s*const next = new Set\(prev\);\s*next\.delete\(k\);/, "only the newest load clears the key, and only its own key");
});

test("page: a fresh listing keeps the state of a row whose search is still in flight", () => {
  assert.match(
    missingPage(),
    /updateSearches\(\(s\) => Object\.fromEntries\(Object\.entries\(s\)\.filter\(\(\[key, st\]\) => !key\.startsWith\(`\$\{k\}\|`\) \|\| st\.busy\)\)\);/,
  );
});

test("page: the tables render one page of rows; the query is deferred for the filters", () => {
  const src = missingPage();
  assert.match(src, /const PAGE_SIZE = 100;/);
  for (const list of ["movies", "series", "cutoffMovies", "cutoffSeries"]) {
    assert.match(src, new RegExp(`onPage\\(${list}\\)\\.map\\(`), `${list} renders its page`);
    assert.doesNotMatch(src, new RegExp(`\\{\\s*${list}\\.map\\(|,\\s*${list}\\.map\\(`), `${list} never renders whole`);
  }
  assert.match(src, /return rows\.slice\(pageStart, pageStart \+ PAGE_SIZE\);/);
  assert.match(src, /const selectable = pageRows\.filter\(isOpen\);/, "select-all works on the page on screen");
  assert.match(src, /const pageIndex = pageView\.view === viewKey \? Math\.min\(pageView\.page, pageCount - 1\) : 0;/, "a new view starts on its first page");
  assert.match(src, /const deferredQuery = useDeferredValue\(query\);/);
  assert.equal((src.match(/query: deferredQuery/g) ?? []).length, 4, "every list filters on the deferred query");
});

test("page: a Sonarr search refused part-way shows a neutral note on its started row", () => {
  const src = missingPage();
  assert.match(src, /return d\?\.partial === true \? \{ \.\.\.attempt, message: t\("adminManage\.missing\.searchPartial"\) \} : attempt;/);
  assert.match(src, /\{\(already \|\| started\) && st\.message && \(/);
});

test("page: removing a title in the title manager re-reads the list (never mid bulk run)", () => {
  const blocks = [...missingPage().matchAll(/<ManageTitleButton\b[\s\S]*?\/>/g)].map((m) => m[0]);
  assert.equal(blocks.length, 1);
  assert.match(blocks[0], /onRemoved=\{\(\) => \{\s*(?:\/\/[^\n]*\n\s*)*if \(!bulkAbort\.current\) void load\(svc, mode\);\s*\}\}/);
});

// ── 10: a truncated cutoff listing ───────────────────────────────────────────

test("cutoff: a listing past the page ceiling is reported as truncated (read of total) — never as the complete list", async () => {
  const ceiling = missingData.CUTOFF_PAGE_SIZE * missingData.CUTOFF_MAX_PAGES;
  assert.equal(ceiling, 20_000);
  cutoffTotal = 25_000;
  const capped = await missingData.loadCutoffMovies();
  assert.deepEqual(capped.truncated, [{ instance: "", read: ceiling, total: 25_000 }]);
  assert.equal(capped.items.length, ceiling);
  assert.equal(calls.filter((c) => c.path === "/api/v3/wanted/cutoff").length, missingData.CUTOFF_MAX_PAGES, "bounded all the same");

  // Exactly at the ceiling the read reached the end: complete, no flag (not even an empty one).
  calls = [];
  cutoffTotal = ceiling;
  const whole = await missingData.loadCutoffMovies();
  assert.equal("truncated" in whole, false);
  assert.equal(whole.items.length, ceiling);

  cutoffTotal = 3;
  assert.equal("truncated" in (await missingData.loadCutoffMovies()), false);
});

test("page: a truncated cutoff listing is named per instance, with Arr System's library-wide search as the way past it", () => {
  const src = missingPage();
  assert.match(src, /report\.truncated && report\.truncated\.length > 0 &&/);
  assert.match(src, /t\("adminManage\.missing\.cutoff\.truncated", \{ name: instanceLabel\(e\.instance\), read: e\.read, total: e\.total \}\)/);
});
