// Audit fix C017 (nw-upstream): the never-watched page's "Check now" walks every
// configured server's whole watch history (and every Jellyfin user's played
// items). Held open as one request, that outlasted a reverse proxy's ~60–100 s
// and the browser got a 502 while the walk went on to write the snapshot — the
// guardrail-37a shape. POST { async: true } now answers 202 { job } at once and
// the walk runs in the background (the generic startArrJob registry); GET ?job=
// is polled for its own answer. Pinned here:
//   1. 202 { job } BEFORE the walk finishes; the poll is 202 while it runs and
//      the walk's own answer (200 + body) after, with the cached report dropped.
//   2. The same admin asking again while theirs runs JOINS it — no second walk,
//      no rate token spent.
//   3. No body is still the synchronous walk (the API contract).
//   4. Another admin's job id reads 404, with the "job gone" message.
//
// Every admin is a fresh session (its own rate-limit bucket); each test has a
// timeout so a mutant that awaits the parked walk fails instead of hanging.
//
// Harness: a trimmed copy of tests/upstream-watch-routes.test.mts — real
// handlers with a signed session JWT inside a synthetic request scope, in-memory
// prisma stubs, a patched pg Client.prototype for the advisory lock, and a
// gated fetch so a walk can be parked mid-flight. No DB, no network.
import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { AsyncLocalStorage } from "node:async_hooks";
import { Client } from "pg";

(globalThis as { AsyncLocalStorage?: unknown }).AsyncLocalStorage = AsyncLocalStorage;

process.env.TOKEN_ENCRYPTION_KEY = "ab".repeat(32);
process.env.NEXTAUTH_SECRET = "audit-fix-nw-refresh-secret-0123456789abcdef";
process.env.AUTH_URL = "http://localhost:3000";
process.env.TRUST_PROXY = "true";
process.env.DATABASE_URL = "postgres://u:p@127.0.0.1:5432/db"; // Client.prototype is stubbed; never dialed
(process.env as Record<string, string | undefined>).NODE_ENV = "test";

console.warn = () => {};
console.error = () => {};

// ── pg advisory-lock seam ────────────────────────────────────────────────────
let lockTries = 0;
const pgProto = Client.prototype as unknown as {
  connect: () => Promise<void>;
  query: (text: string, values?: unknown[]) => Promise<{ rows: unknown[] }>;
  end: () => Promise<void>;
};
pgProto.connect = async () => {};
pgProto.query = async (text) => {
  if (text.includes("pg_try_advisory_lock")) {
    lockTries++;
    return { rows: [{ acquired: true }] };
  }
  return { rows: [] };
};
pgProto.end = async () => {};

// ── a gated upstream: the walk parks on the first Plex fetch until released ──
const PLEX = "http://10.74.0.1:32400";
let fetches = 0;
let gate: Promise<void> | null = null;
let release: () => void = () => {};
// Every gate ever parked, so afterEach can free a walk a mutant left hanging
// (its advisory-lock work timer would otherwise hold the process open).
const allReleases: Array<() => void> = [];
function park() {
  gate = new Promise<void>((r) => { release = r; allReleases.push(r); });
}
globalThis.fetch = (async () => {
  fetches++;
  if (gate) await gate;
  return new Response("unauthorized", { status: 401 });
}) as typeof fetch;

const cjsRequire = createRequire(import.meta.url);
type RunStore = { run<T>(store: unknown, fn: () => T): T };
const { workAsyncStorage } = cjsRequire("next/dist/server/app-render/work-async-storage.external.js") as { workAsyncStorage: RunStore };
const { workUnitAsyncStorage } = cjsRequire("next/dist/server/app-render/work-unit-async-storage.external.js") as { workUnitAsyncStorage: RunStore };
const { RequestCookies } = cjsRequire("next/dist/server/web/spec-extension/cookies.js") as { RequestCookies: new (h: Headers) => unknown };
const { RequestCookiesAdapter } = cjsRequire("next/dist/server/web/spec-extension/adapters/request-cookies.js") as { RequestCookiesAdapter: { seal(c: unknown): unknown } };
const { HeadersAdapter } = cjsRequire("next/dist/server/web/spec-extension/adapters/headers.js") as { HeadersAdapter: { seal(h: Headers): unknown } };

const { NextRequest } = await import("next/server");
const { prisma } = await import("../src/lib/prisma.ts");
const { shadowPrismaModel, shadowPrismaClientMethod } = await import("./_helpers.mts");
const { signSessionJwt } = await import("../src/lib/session-jwt.ts");
const { getSessionCookieName } = await import("../src/lib/session-cookie.ts");
const { Permission } = await import("../src/lib/permissions.ts");
const { invalidateFeatureFlagCache } = await import("../src/lib/features.ts");
const { _resetReleaseSearchJobsForTests } = await import("../src/lib/release-search-jobs.ts");
const { processSingleton } = await import("../src/lib/process-singleton.ts");

// The report cache invalidateNeverWatchedReport() bumps (never-watched-report.ts).
const reportCache = processSingleton("never-watched:report", () => ({ value: null, at: 0, generation: -1, version: 0 })) as { version: number };

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
  const userId = `nwr-user-${sessionSeq}`;
  const sessionId = `nwr-sess-${sessionSeq}`;
  usersById.set(userId, {
    role: "ADMIN", permissions: Permission.ADMIN, mediaServer: null, sessionsRevokedAt: null,
    passwordChangedAt: null, deactivatedAt: null, email: `nwr${sessionSeq}@example.com`, notificationEmail: null,
  });
  sessionRows.add(sessionId);
  const iat = Math.floor(Date.now() / 1000);
  return signSessionJwt(
    { id: userId, role: "ADMIN", permissions: Permission.ADMIN.toString(), provider: "credentials", sessionId, expiresAt: iat + 86_400 },
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
  upsert: async (args: { where: { key: string }; update: { value: string } }) => {
    settings.set(args.where.key, args.update.value);
    return { key: args.where.key, value: args.update.value };
  },
});
shadowPrismaModel(prisma, "upstreamWatchEvidence", {
  findMany: async () => [],
  deleteMany: async () => ({ count: 0 }),
  createMany: async () => ({ count: 0 }),
});
shadowPrismaModel(prisma, "plexLibraryItem", { findMany: async () => [] });
shadowPrismaModel(prisma, "jellyfinLibraryItem", { findMany: async () => [] });
shadowPrismaModel(prisma, "playHistory", { findMany: async () => [] });
shadowPrismaClientMethod(prisma, "$transaction", async (fn: unknown) => (fn as (tx: unknown) => Promise<unknown>)(prisma));

const route = await import("../src/app/api/admin/never-watched/refresh/route.ts");

// ── request scope ────────────────────────────────────────────────────────────
function inScope<T>(fn: () => Promise<T>): Promise<T> {
  const workStore = {
    route: "/audit-fix-nw-upstream-refresh.test",
    forceStatic: false,
    dynamicShouldError: false,
    afterContext: { after: () => {} },
  };
  const h = new Headers();
  const requestStore = {
    type: "request", phase: "render",
    headers: HeadersAdapter.seal(h),
    cookies: RequestCookiesAdapter.seal(new RequestCookies(h)),
    usedDynamic: false,
  };
  return workAsyncStorage.run(workStore, () => workUnitAsyncStorage.run(requestStore, fn));
}
const URL_BASE = "http://localhost:3000/api/admin/never-watched/refresh";
const post = (token: string, body?: unknown) =>
  inScope(() => (route.POST as unknown as (r: unknown, c: unknown) => Promise<Response>)(
    new NextRequest(URL_BASE, {
      method: "POST",
      headers: { cookie: `${COOKIE}=${token}`, ...(body === undefined ? {} : { "content-type": "application/json" }) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    }),
    undefined,
  ));
const poll = (token: string, job: string) =>
  inScope(() => (route.GET as unknown as (r: unknown, c: unknown) => Promise<Response>)(
    new NextRequest(`${URL_BASE}?job=${encodeURIComponent(job)}`, { headers: { cookie: `${COOKIE}=${token}` } }),
    undefined,
  ));
const tick = () => new Promise((r) => setTimeout(r, 5));
async function until(cond: () => boolean): Promise<void> {
  for (let i = 0; i < 400 && !cond(); i++) await tick();
  assert.ok(cond(), "condition never became true");
}

beforeEach(() => {
  settings.clear();
  settings.set("feature.admin.neverWatched", "true");
  settings.set("plexServerUrl", PLEX);
  settings.set("plexAdminToken", "t");
  invalidateFeatureFlagCache();
  _resetReleaseSearchJobsForTests();
  lockTries = 0;
  fetches = 0;
  gate = null;
});

afterEach(() => {
  for (const r of allReleases.splice(0)) r();
  gate = null;
});

test("C017 async: 202 { job } BEFORE the walk finishes; the poll is 202 while it runs, then the walk's own 200 answer — report invalidated", { timeout: 5_000 }, async () => {
  const token = await mintSession();
  park();
  const versionBefore = reportCache.version;
  const res = await post(token, { async: true });
  assert.equal(res.status, 202, "answered at once, while the walk is parked on the media server");
  const { job } = (await res.json()) as { job: string };
  assert.match(job, /^[0-9a-f]{32}$/);
  await until(() => fetches > 0);
  const running = await poll(token, job);
  assert.equal(running.status, 202);
  assert.deepEqual(await running.json(), { job, running: true });
  assert.equal(reportCache.version, versionBefore, "nothing invalidated while the walk is still running");

  release();
  let done: Response = running;
  for (let i = 0; i < 400; i++) {
    done = await poll(token, job);
    if (done.status !== 202) break;
    await tick();
  }
  assert.equal(done.status, 200);
  const body = (await done.json()) as { servers: Array<{ ok: boolean; error: string }>; aborted: boolean };
  assert.equal(body.aborted, false);
  assert.equal(body.servers[0].ok, false, "the walk's own answer (the 401 server), not a job envelope");
  assert.equal(body.servers[0].error, "HTTP 401");
  assert.ok(reportCache.version > versionBefore, "the job drops the cached report once the walk lands");
});

test("C017 async: the same admin asking again while theirs runs JOINS it — one walk, and no rate token spent on a join", { timeout: 5_000 }, async () => {
  const token = await mintSession();
  park();
  const first = (await (await post(token, { async: true })).json()) as { job: string };
  await until(() => fetches > 0);
  // 3 per 10 minutes: joins must not use them up.
  for (let i = 0; i < 3; i++) {
    const again = await post(token, { async: true });
    assert.equal(again.status, 202, `join ${i + 1}`);
    assert.equal(((await again.json()) as { job: string }).job, first.job, "the running job, not a second walk");
  }
  assert.equal(lockTries, 1, "one walk under the lock");
  release();
  let status = 202;
  for (let i = 0; i < 400 && status === 202; i++) {
    status = (await poll(token, first.job)).status;
    if (status === 202) await tick();
  }
  assert.equal(status, 200);
  // The first walk used ONE token; two fresh starts remain in the window.
  gate = null;
  assert.equal((await post(token, { async: true })).status, 202, "a fresh start after the joins is still allowed");
});

test("C017 no body is still the SYNCHRONOUS walk (the API contract): its result JSON, not a job", { timeout: 5_000 }, async () => {
  const token = await mintSession();
  const res = await post(token);
  assert.equal(res.status, 200);
  const body = (await res.json()) as { servers: unknown[]; aborted: boolean; job?: unknown };
  assert.equal(body.job, undefined);
  assert.equal(body.aborted, false);
  assert.equal(body.servers.length, 1);
  const explicit = await post(token, { async: false });
  assert.equal(explicit.status, 200, "async: false is synchronous too");
});

test("C017 another admin's job id reads 404 with the 'job gone' message — and so does a made-up one", { timeout: 5_000 }, async () => {
  const owner = await mintSession();
  const other = await mintSession();
  park();
  const { job } = (await (await post(owner, { async: true })).json()) as { job: string };
  const res = await poll(other, job);
  assert.equal(res.status, 404);
  assert.equal(typeof ((await res.json()) as { error?: unknown }).error, "string");
  assert.equal((await poll(owner, "not-a-job")).status, 404);
  release();
});
