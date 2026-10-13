// Admin → Arr System, the audit fixes that had no pin (C006, C040, C041,
// C043, C044, C045, C046, C088, C089) plus the Reload "held prompt" rule:
//
//   C006  Saves to ONE provider run one at a time (withProviderLock): the
//         second reads the arr's resource only after the first PUT settled,
//         so it carries the first's flag; a failed save releases the lock;
//         the lock map is left empty when idle.
//   C046  An indexer use the fresh read says it can't do (supportsRss /
//         supportsSearch false) is never switched ON — 400, nothing sent, not
//         audited. Switching it OFF still saves. Projected from booleans only.
//   C040  A `?job=` poll that failed in TRANSPORT (status 0, a 502–504 with no
//         JSON) is retried, JOB_MAX_FAILED_POLLS in a row read as still
//         running, and any real answer resets the count — callJob is lifted out
//         of arr-system.tsx and run against a scripted `call`.
//   C088  A BACKGROUND Test All waits 270 s; a synchronous Test All and every
//         single test keep 120 s.
//   C089  A failure's `customState.isWarning` decides when `isWarning` is
//         absent, over `severity`; an explicit `isWarning` still wins.
//   C041/C043/C044/C045 + the Reload held-prompt rule: source pins over
//         arr-system.tsx (a component — no render harness here).
//
// Harness: the same as tests/arr-fix-system.test.mts (in-memory prisma,
// scripted Radarr behind a fetch stub, a synthetic request scope).
import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import dns from "node:dns/promises";
import { readFileSync } from "node:fs";
import { createRequire, stripTypeScriptTypes } from "node:module";
import { AsyncLocalStorage } from "node:async_hooks";

(globalThis as { AsyncLocalStorage?: unknown }).AsyncLocalStorage = AsyncLocalStorage;

process.env.TOKEN_ENCRYPTION_KEY = "ab".repeat(32);
process.env.NEXTAUTH_SECRET = "audit-fix2-r6a-system-test-secret-0123456789";
process.env.AUTH_URL = "http://localhost:3000";
process.env.TRUST_PROXY = "true";
delete process.env.TMDB_READ_TOKEN;
(process.env as Record<string, string | undefined>).NODE_ENV = "test";

const fakeLookup = async () => [{ address: "10.0.0.250", family: 4 }];
(dns as { lookup: unknown }).lookup = fakeLookup;
if ((dns as { lookup: unknown }).lookup !== fakeLookup) throw new Error("could not stub dns.lookup");

console.warn = () => {};
console.error = () => {};

// Every request's timeout, read off the AbortSignal.timeout safeFetch builds for it.
const timeoutOf = new WeakMap<AbortSignal, number>();
const realTimeout = AbortSignal.timeout.bind(AbortSignal);
AbortSignal.timeout = (ms: number) => {
  const s = realTimeout(ms);
  timeoutOf.set(s, ms);
  return s;
};

// ── scripted Radarr ──────────────────────────────────────────────────────────
const RADARR = "http://10.0.0.5:7878";
type Call = { origin: string; method: string; path: string; query: URLSearchParams; body: unknown; timeoutMs: number | undefined };
let calls: Call[] = [];
type Responder = (c: Call) => Response | undefined | Promise<Response | undefined>;
let responder: Responder = () => undefined;
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
  const url = new URL(String(input));
  const method = init?.method ?? "GET";
  let body: unknown;
  if (typeof init?.body === "string" && init.body !== "") {
    try { body = JSON.parse(init.body); } catch { body = init.body; }
  }
  const call: Call = {
    origin: url.origin, method, path: url.pathname, query: url.searchParams, body,
    timeoutMs: init?.signal ? timeoutOf.get(init.signal) : undefined,
  };
  calls.push(call);
  const res = await responder(call);
  if (res instanceof Error) throw res;
  if (res) return res;
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
const { _resetReleaseSearchJobsForTests } = await import("../src/lib/release-search-jobs.ts");
const {
  isTransientJobPollFailure, JOB_MAX_FAILED_POLLS, projectFailures, projectIndexers, unsupportedIndexerUse,
} = await import("../src/lib/arr-system.ts");

// ── auth fixture ─────────────────────────────────────────────────────────────
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
  const userId = `user-${sessionSeq}`;
  const sessionId = `sess-${sessionSeq}`;
  const permissions = Permission.ADMIN.toString();
  usersById.set(userId, {
    role: "ADMIN", permissions: BigInt(permissions), mediaServer: null, sessionsRevokedAt: null,
    passwordChangedAt: null, deactivatedAt: null, email: `u${sessionSeq}@example.com`, notificationEmail: null,
  });
  sessionRows.add(sessionId);
  const iat = Math.floor(Date.now() / 1000);
  return signSessionJwt(
    { id: userId, role: "ADMIN", permissions, provider: "credentials", sessionId, expiresAt: iat + 86_400 },
    { expiresInSeconds: 7_200, iat },
  );
}
const COOKIE = getSessionCookieName();

// ── data stubs ───────────────────────────────────────────────────────────────
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
  upsert: async () => ({}),
});
const audits: Array<{ action: string; target: string | null; details: unknown }> = [];
shadowPrismaModel(prisma, "auditLog", {
  create: async (args: { data: { action: string; target?: string | null; details?: unknown } }) => {
    audits.push({ action: args.data.action, target: args.data.target ?? null, details: args.data.details });
    return {};
  },
});

const providersRoute = await import("../src/app/api/admin/arr/providers/route.ts");
const testRoute = await import("../src/app/api/admin/arr/providers/test/route.ts");

function inScope<T>(fn: () => Promise<T>): Promise<T> {
  const workStore = { route: "/audit-fix2-r6a-system.test", forceStatic: false, dynamicShouldError: false, afterContext: { after: () => {} } };
  const h = new Headers();
  const requestStore = {
    type: "request", phase: "render",
    headers: HeadersAdapter.seal(h),
    cookies: RequestCookiesAdapter.seal(new RequestCookies(h)),
    usedDynamic: false,
  };
  return workAsyncStorage.run(workStore, () => workUnitAsyncStorage.run(requestStore, fn));
}
type Handler = (r: unknown, c: unknown) => Promise<Response>;
const call = (handler: unknown, token: string, path: string, init: { method?: string; body?: unknown } = {}) =>
  inScope(() => (handler as Handler)(
    new NextRequest(`http://localhost:3000/api${path}`, {
      method: init.method ?? "GET",
      headers: { cookie: `${COOKIE}=${token}`, ...(init.body !== undefined ? { "content-type": "application/json" } : {}) },
      ...(init.body !== undefined ? { body: JSON.stringify(init.body) } : {}),
    }),
    undefined,
  ));
const arrCalls = () => calls.filter((c) => c.origin !== "http://localhost:3000");
const writes = () => arrCalls().filter((c) => c.method !== "GET");
const patch = (token: string, body: Record<string, unknown>) =>
  call(providersRoute.PATCH, token, "/admin/arr/providers", { method: "PATCH", body: { service: "radarr", ...body } });
const testProvider = (token: string, body: Record<string, unknown>) =>
  call(testRoute.POST, token, "/admin/arr/providers/test", { method: "POST", body: { service: "radarr", ...body } });

const INDEXER = {
  id: 3, name: "NZBgeek", implementationName: "Newznab", protocol: "usenet", priority: 25,
  enableRss: true, enableAutomaticSearch: false, enableInteractiveSearch: true, tags: [2],
  fields: [{ name: "baseUrl", value: "https://api.nzbgeek.info" }, { name: "apiKey", value: "********" }],
};

function deferred<T = void>() {
  let resolve!: (v: T) => void;
  const promise = new Promise<T>((r) => { resolve = r; });
  return { promise, resolve };
}
const tick = () => new Promise((r) => setImmediate(r));
const saveLocks = () =>
  ((globalThis as unknown as Record<symbol, Map<string, unknown>>)[Symbol.for("summonarr.processSingletons")]
    .get("arr-system-data:provider-save-locks")) as Map<string, unknown>;

beforeEach(() => {
  calls = [];
  audits.length = 0;
  responder = () => undefined;
  settings.clear();
  for (const [k, v] of Object.entries({ radarrUrl: RADARR, radarrApiKey: "radarr-key", "feature.integration.sonarr": "false" })) settings.set(k, v);
  invalidateFeatureFlagCache();
  _resetReleaseSearchJobsForTests();
});

// ── C006: one save per provider at a time ────────────────────────────────────

test("two overlapping saves to one provider run in turn: the second reads after the first PUT and carries its flag", async () => {
  const token = await mintSession();
  let stored: Record<string, unknown> = { ...INDEXER };
  const firstPut = deferred();
  let puts = 0;
  responder = async (c) => {
    if (c.origin !== RADARR) return undefined;
    if (c.path === "/api/v3/indexer/3" && c.method === "GET") return json(stored);
    if (c.path === "/api/v3/indexer/3" && c.method === "PUT") {
      puts++;
      if (puts === 1) await firstPut.promise; // the first save is still at the arr
      stored = c.body as Record<string, unknown>;
      return json(stored);
    }
    return undefined;
  };
  const a = patch(token, { kind: "indexer", id: 3, enableRss: false });
  const b = patch(token, { kind: "indexer", id: 3, enableInteractiveSearch: false });
  for (let i = 0; i < 20; i++) await tick();
  assert.deepEqual(arrCalls().map((c) => c.method), ["GET", "PUT"], "the second save has not read the resource while the first PUT is out");
  firstPut.resolve();
  const [ra, rb] = await Promise.all([a, b]);
  assert.equal(ra.status, 200);
  assert.equal(rb.status, 200);
  const putBodies = writes().map((c) => c.body as Record<string, unknown>);
  assert.equal(putBodies.length, 2);
  assert.equal(putBodies[1].enableRss, false, "the second save keeps the first's flag");
  assert.equal(putBodies[1].enableInteractiveSearch, false);
  assert.equal(stored.enableRss, false);
  assert.equal(stored.enableInteractiveSearch, false);
  assert.deepEqual(audits.map((x) => x.action), ["ARR_PROVIDER_CHANGE", "ARR_PROVIDER_CHANGE"]);
  assert.equal(saveLocks().size, 0, "the lock entry is dropped once nothing waits");
});

test("a save that fails releases the lock: the next save to that provider still runs", async () => {
  const token = await mintSession();
  const firstPut = deferred();
  let puts = 0;
  responder = async (c) => {
    if (c.origin !== RADARR) return undefined;
    if (c.path === "/api/v3/indexer/3" && c.method === "GET") return json(INDEXER);
    if (c.path === "/api/v3/indexer/3" && c.method === "PUT") {
      puts++;
      if (puts === 1) {
        await firstPut.promise;
        return json({ message: "boom" }, 500);
      }
      return json(c.body);
    }
    return undefined;
  };
  const a = patch(token, { kind: "indexer", id: 3, enableRss: false });
  const b = patch(token, { kind: "indexer", id: 3, enableInteractiveSearch: false });
  for (let i = 0; i < 20; i++) await tick();
  firstPut.resolve();
  const [ra, rb] = await Promise.all([a, b]);
  assert.notEqual(ra.status, 200, "the first save failed");
  assert.equal(rb.status, 200, "and the one queued behind it still saved");
  assert.equal(writes().length, 2);
  assert.equal(saveLocks().size, 0);
});

// ── C046: a use the indexer can't do is never switched on ────────────────────

test("switching ON a use the indexer reports it can't do is 400 with nothing sent and nothing audited; switching it OFF saves", async () => {
  const token = await mintSession();
  let stored: Record<string, unknown> = { ...INDEXER, enableRss: false, supportsRss: false, supportsSearch: false };
  responder = (c) => {
    if (c.origin !== RADARR) return undefined;
    if (c.path === "/api/v3/indexer/3" && c.method === "GET") return json(stored);
    if (c.path === "/api/v3/indexer/3" && c.method === "PUT") return json(c.body);
    return undefined;
  };
  for (const [change, re] of [
    [{ enableRss: true }, /doesn't support RSS/],
    [{ enableAutomaticSearch: true }, /doesn't support searching/],
    [{ enableInteractiveSearch: true, enableRss: false }, /doesn't support searching/],
  ] as const) {
    const res = await patch(token, { kind: "indexer", id: 3, ...change });
    assert.equal(res.status, 400, JSON.stringify(change));
    assert.match(((await res.json()) as { error: string }).error, re);
  }
  assert.deepEqual(writes(), [], "nothing sent to the arr");
  assert.equal(audits.length, 0);

  // OFF is always allowed — one that is somehow on can be switched off.
  stored = { ...INDEXER, supportsSearch: false };
  const off = await patch(token, { kind: "indexer", id: 3, enableInteractiveSearch: false });
  assert.equal(off.status, 200);
  assert.deepEqual(writes().map((c) => [c.path, c.query.get("forceSave")]), [["/api/v3/indexer/3", "true"]]);
});

test("unsupportedIndexerUse refuses only an ON the fresh read says false to; supportsRss/supportsSearch project from booleans only", () => {
  assert.equal(unsupportedIndexerUse({ supportsRss: false }, { enableRss: true }), "rss");
  assert.equal(unsupportedIndexerUse({ supportsSearch: false }, { enableAutomaticSearch: true }), "search");
  assert.equal(unsupportedIndexerUse({ supportsSearch: false }, { enableInteractiveSearch: true }), "search");
  assert.equal(unsupportedIndexerUse({ supportsRss: false, supportsSearch: false }, { enableRss: false, enableInteractiveSearch: false }), null, "OFF");
  assert.equal(unsupportedIndexerUse({ supportsRss: true, supportsSearch: true }, { enableRss: true, enableAutomaticSearch: true }), null);
  assert.equal(unsupportedIndexerUse({}, { enableRss: true, enableAutomaticSearch: true }), null, "an arr that doesn't say");
  assert.equal(unsupportedIndexerUse({ supportsRss: "false" }, { enableRss: true }), null, "not a boolean");
  assert.equal(unsupportedIndexerUse(null, { enableRss: true }), null);
  assert.equal(unsupportedIndexerUse({ supportsRss: false }, { enable: true }), null, "a download client's change");

  const [ix] = projectIndexers([{ ...INDEXER, supportsRss: false, supportsSearch: true }]);
  assert.deepEqual([ix.supportsRss, ix.supportsSearch], [false, true]);
  const [unknown] = projectIndexers([{ ...INDEXER, supportsRss: "no", supportsSearch: 0 }]);
  assert.deepEqual([unknown.supportsRss, unknown.supportsSearch], [null, null]);
});

// ── C088: a background Test All waits longer ─────────────────────────────────

test("a BACKGROUND Test All waits 270 s; a synchronous Test All and a single test, background or not, wait 120 s", async () => {
  const token = await mintSession();
  responder = (c) => {
    if (c.origin !== RADARR) return undefined;
    if (c.path === "/api/v3/indexer/testall") return json([{ id: 3, isValid: true, validationFailures: [] }]);
    if (c.path === "/api/v3/indexer/3" && c.method === "GET") return json(INDEXER);
    if (c.path === "/api/v3/indexer/test") return new Response(null, { status: 200 });
    return undefined;
  };
  const settle = async (start: Response) => {
    assert.equal(start.status, 202);
    const { job } = (await start.json()) as { job: string };
    for (let i = 0; i < 200; i++) {
      const res = await call(testRoute.GET, token, `/admin/arr/providers/test?job=${job}`);
      if (res.status !== 202) return res;
      await tick();
    }
    throw new Error("the job never finished");
  };
  assert.equal((await settle(await testProvider(token, { kind: "indexer", async: true }))).status, 200);
  assert.equal((await testProvider(token, { kind: "indexer" })).status, 200);
  assert.equal((await settle(await testProvider(token, { kind: "indexer", id: 3, async: true }))).status, 200);
  assert.equal((await testProvider(token, { kind: "indexer", id: 3 })).status, 200);
  assert.deepEqual(writes().map((c) => [c.path, c.timeoutMs]), [
    ["/api/v3/indexer/testall", 270_000],
    ["/api/v3/indexer/testall", 120_000],
    ["/api/v3/indexer/test", 120_000],
    ["/api/v3/indexer/test", 120_000],
  ]);
});

// ── C089: customState.isWarning ──────────────────────────────────────────────

test("a failure's customState.isWarning decides when isWarning is absent — over severity; an explicit isWarning still wins", () => {
  assert.equal(projectFailures([{ errorMessage: "slow", customState: { isWarning: true }, severity: "error" }]).warningsOnly, true);
  assert.equal(projectFailures([{ errorMessage: "bad", customState: { isWarning: false }, severity: "warning" }]).warningsOnly, false);
  assert.equal(projectFailures([{ errorMessage: "bad", isWarning: false, customState: { isWarning: true } }]).warningsOnly, false);
  assert.equal(projectFailures([{ errorMessage: "slow", isWarning: true, customState: { isWarning: false } }]).warningsOnly, true);
  assert.equal(projectFailures([{ errorMessage: "slow", customState: { isWarning: "yes" }, severity: "warning" }]).warningsOnly, true, "non-boolean → severity");
  assert.equal(projectFailures([{ errorMessage: "bad", customState: null, severity: "error" }]).warningsOnly, false);
});

// ── C040: a poll that failed on the way is not the job's answer ──────────────

test("isTransientJobPollFailure: only status 0, or 502–504 with no JSON body", () => {
  assert.equal(isTransientJobPollFailure(0, null), true);
  assert.equal(isTransientJobPollFailure(0, { error: "x" }), true, "a fetch throw is transient whatever the body");
  for (const s of [502, 503, 504]) {
    assert.equal(isTransientJobPollFailure(s, null), true, `${s} null`);
    assert.equal(isTransientJobPollFailure(s, undefined), true, `${s} undefined`);
  }
  assert.equal(isTransientJobPollFailure(502, { error: "Radarr is unreachable" }), false, "arrFailure's own 502");
  assert.equal(isTransientJobPollFailure(504, { timedOut: true, provider: {} }), false, "a save's 504");
  for (const s of [500, 501, 505, 409, 404, 400]) assert.equal(isTransientJobPollFailure(s, null), false, String(s));
  assert.equal(JOB_MAX_FAILED_POLLS, 5);
});

const TSX = readFileSync(new URL("../src/components/admin/arr-system.tsx", import.meta.url), "utf8");

/** callJob, lifted out of arr-system.tsx with its types stripped, run against a scripted `call`. */
type Res = { data: unknown; status: number } | { error: string; status: number; body: Record<string, unknown> | null };
function liftCallJob(script: Res[]) {
  const start = TSX.indexOf("async function callJob<T>(");
  assert.ok(start >= 0, "callJob is in arr-system.tsx");
  const end = TSX.indexOf("\n}\n", start);
  const src = stripTypeScriptTypes(TSX.slice(start, end + 2));
  const seen: string[] = [];
  const scriptedCall = async (path: string) => {
    seen.push(path);
    const next = script.shift();
    if (!next) throw new Error(`no scripted answer for ${path}`);
    return next;
  };
  const fakeWindow = { setTimeout: (fn: () => void) => { fn(); return 0; } };
  const make = new Function(
    "call", "window", "isTransientJobPollFailure", "JOB_MAX_FAILED_POLLS", "JOB_MAX_POLLS", "JOB_POLL_MS",
    `${src}\nreturn callJob;`,
  ) as (...a: unknown[]) => (path: string, init: unknown, fallback: string, stillRunning: string, alive: () => boolean) => Promise<Res | null>;
  const callJob = make(scriptedCall, fakeWindow, isTransientJobPollFailure, JOB_MAX_FAILED_POLLS, 150, 2_000);
  return { run: () => callJob("/admin/arr/providers", { method: "PATCH", body: {} }, "failed", "still running", () => true), seen };
}
const running: Res = { data: { job: "j1", running: true }, status: 202 };
const blip: Res = { error: "failed", status: 0, body: null };
const proxy502: Res = { error: "failed", status: 502, body: null };

test("callJob retries a poll that failed on the way, and a real answer after it is the job's answer", async () => {
  const done: Res = { data: { provider: { id: 3 } }, status: 200 };
  const { run, seen } = liftCallJob([{ data: { job: "j1" }, status: 202 }, blip, proxy502, running, done]);
  assert.deepEqual(await run(), done);
  assert.equal(seen.length, 5);
  assert.ok(seen.slice(1).every((p) => p === "/admin/arr/providers?job=j1"));
});

test("callJob: JOB_MAX_FAILED_POLLS transport failures in a row read as still running — never the change's failure", async () => {
  const { run, seen } = liftCallJob([{ data: { job: "j1" }, status: 202 }, blip, blip, proxy502, blip, blip, running]);
  assert.deepEqual(await run(), { error: "still running", status: 0, body: { stillRunning: true } });
  assert.equal(seen.length, 1 + JOB_MAX_FAILED_POLLS, "stopped at the fifth failure in a row");
});

test("callJob: a real answer between failures resets the count; a JSON-bodied 502 is the job's own answer", async () => {
  const done: Res = { data: { provider: { id: 3 } }, status: 200 };
  const { run } = liftCallJob([{ data: { job: "j1" }, status: 202 }, blip, blip, blip, blip, running, blip, blip, blip, blip, done]);
  assert.deepEqual(await run(), done, "4 + 4 failures with a 202 between never reach five in a row");

  const own502: Res = { error: "Radarr is unreachable", status: 502, body: { error: "Radarr is unreachable" } };
  const terminal = liftCallJob([{ data: { job: "j1" }, status: 202 }, own502, done]);
  assert.deepEqual(await terminal.run(), own502);
  assert.equal(terminal.seen.length, 2);
});

// ── C041 / C043 / C044 / C045 / Reload: source pins ──────────────────────────

/** The body of `function <name>(` in the component file, to the next line holding only "  }". */
function fnBody(name: string): string {
  const start = TSX.indexOf(`function ${name}(`);
  assert.ok(start >= 0, `${name} is in arr-system.tsx`);
  return TSX.slice(start, TSX.indexOf("\n  }\n", start));
}

test("Providers Reload keeps a held 'switch anyway' prompt and an override written while it was out; clears only what was there at the click", () => {
  const reload = fnBody("reload");
  assert.doesNotMatch(reload, /setHeld\(\{\}\)/, "a bare setHeld({}) wipes a prompt that arrived mid-reload");
  assert.doesNotMatch(reload, /setOverrides\(\{\}\)/);
  assert.match(reload, /const heldBefore = held;/);
  assert.match(reload, /const before = overrides;/);
  assert.match(reload, /if \(!ok\) return;/, "a failed reload keeps them all");
  assert.match(reload, /setHeld\(\(m\) => without\(m, \(key\) => m\[key\] === heldBefore\[key\]\)\)/);
  assert.match(reload, /setOverrides\(\(m\) => without\(m, \(key\) => m\[key\] === before\[key\]\)\)/);
  assert.match(TSX, /<Toolbar loading=\{loading\} onReload=\{reload\}/, "the Providers toolbar reloads through it");
  // useReport's load answers whether ITS report landed.
  assert.match(TSX, /const load = useCallback\(async \(kind: LoadKind = "manual"\): Promise<boolean> =>/);
  assert.match(TSX, /setReport\(res\.data\);\s*setError\(""\);\s*return true;/);
});

test("busy is per instance card — no page-wide busy; a failed first load offers Reload on every tab; bulk searches see the arr's running command", () => {
  assert.doesNotMatch(TSX, /busy !== null/, "no control is disabled by another card's action");
  assert.equal(TSX.match(/useState<Record<string, string>>\(\{\}\)/g)?.length, 2, "Tasks and Providers keep busy per card");
  assert.equal(TSX.match(/if \(!report\) return <Loading error=\{error\} loading=\{loading\} onRetry=\{\(\) => void load\(\)\} \/>;/g)?.length, 3);
  assert.match(TSX, /function Loading\(\{ error, loading, onRetry \}: \{ error: string; loading: boolean; onRetry: \(\) => void \}\)/);
  assert.match(TSX, /disabled=\{loading\} onClick=\{onRetry\}/);
  assert.match(
    TSX,
    /const commandName = bulkActionCommand\(r\.service, action\)\.name;\s*const active = isWatchActive\(watches\[key\]\) \|\| r\.commands\.some\(\(c\) => c\.commandName === commandName && \(c\.status === "started" \|\| c\.status === "queued"\)\);/,
  );
});
