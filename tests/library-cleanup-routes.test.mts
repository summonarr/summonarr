// Route-level tests for Library cleanup (/api/admin/cleanup/*). The delete route
// is the only code in the app that removes media files, so these pin the
// guarantees that keep it an admin's deliberate act:
//
//   1. ADMIN ONLY (guardrail 6a). Every verb is withAdmin: anonymous 401, a plain
//      USER or an ISSUE_ADMIN 403, and none of them reaches Radarr/Sonarr.
//   2. FEATURE GATE. With feature.admin.cleanup off every route 404s.
//   3. DRY RUN FIRST. The default call resolves every *arr copy of each title
//      (every instance, guardrail 32) and returns the count — no DELETE, no DB
//      write. Execute requires that count echoed back, live: a missing or stale
//      count 409s and deletes nothing.
//   4. THE DELETE CALL. Radarr gets DELETE /api/v3/movie/{id}?deleteFiles=true
//      &addImportExclusion=true and Sonarr DELETE /api/v3/series/{id}?deleteFiles
//      =true&addImportListExclusion=true, once per instance, on that instance.
//   5. PARTIAL FAILURE is reported per title, never as a 500.
//   6. NO RE-DOWNLOAD. Every AVAILABLE request for the title — matched by tmdb
//      id OR a Sonarr target's tvdb id — is stamped cleanedUpAt BEFORE the first
//      delete (and un-stamped on an instance whose delete failed, or everywhere
//      if nothing was deleted); the sync's demote skips stamped rows — that half
//      is pinned in tests/sync-orchestrator-route.test.mts. approvedAt and
//      status are never written.
//   7. AUDIT AFTER THE UPSTREAM DELETE, swallowing (guardrail 26): a failed audit
//      write never turns a completed deletion into an error.
//   8. A title that is not a candidate (protected, active request, …) is skipped
//      and never deleted, even when the body names it.
//
// Harness: the tests/blacklist-route.test.mts idiom — real withAdmin-wrapped
// handlers with a signed session JWT inside a synthetic request scope, over
// in-memory prisma stubs, with Radarr/Sonarr scripted on RFC1918 literals.
import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import dns from "node:dns/promises";
import { createRequire } from "node:module";
import { AsyncLocalStorage } from "node:async_hooks";

(globalThis as { AsyncLocalStorage?: unknown }).AsyncLocalStorage = AsyncLocalStorage;

process.env.TOKEN_ENCRYPTION_KEY = "ab".repeat(32);
process.env.NEXTAUTH_SECRET = "cleanup-route-test-secret-0123456789abcdef";
process.env.AUTH_URL = "http://localhost:3000";
process.env.TRUST_PROXY = "true";
(process.env as Record<string, string | undefined>).NODE_ENV = "test";

const fakeLookup = async () => [{ address: "10.0.0.250", family: 4 }];
(dns as { lookup: unknown }).lookup = fakeLookup;
if ((dns as { lookup: unknown }).lookup !== fakeLookup) throw new Error("could not stub dns.lookup");

console.warn = () => {};
console.error = () => {};

// ── ordered op log (stamp → delete → audit ordering is asserted on it) ───────
let seq: string[] = [];

// ── scripted Radarr/Sonarr ───────────────────────────────────────────────────
const RADARR = "http://10.0.0.5:7878";
const RADARR_4K = "http://10.0.0.6:7878";
const SONARR = "http://10.0.0.7:8989";
type Call = { origin: string; method: string; path: string; query: string };
let calls: Call[] = [];
let radarrMovies: Record<string, unknown[]> = {};
let sonarrSeries: unknown[] = [];
let deleteStatus: (origin: string, path: string) => number = () => 200;
let listingStatus: (origin: string) => number = () => 200;
// Runs before a listing answers — lets a test park one listing mid-flight.
let listingHook: ((origin: string, path: string) => Promise<void>) | null = null;

globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
  const url = new URL(String(input));
  const method = init?.method ?? "GET";
  calls.push({ origin: url.origin, method, path: url.pathname, query: url.search });
  if (method === "DELETE") {
    seq.push(`delete ${url.origin}${url.pathname}`);
    const status = deleteStatus(url.origin, url.pathname);
    // Radarr/Sonarr answer a successful delete with an EMPTY body.
    return new Response(status === 200 ? "" : "boom", { status });
  }
  const ls = listingStatus(url.origin);
  if (ls !== 200) return new Response("down", { status: ls });
  if (url.pathname === "/api/v3/movie") {
    // The body is read BEFORE the hook parks: a parked listing answers with the
    // library as it was when the request reached Radarr.
    const body = radarrMovies[url.origin] ?? [];
    if (listingHook) await listingHook(url.origin, url.pathname);
    return Response.json(body);
  }
  if (url.pathname === "/api/v3/series") return Response.json(sonarrSeries);
  throw new Error(`unexpected fetch ${method} ${url}`);
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
const { shadowPrismaModel, shadowPrismaClientMethod } = await import("./_helpers.mts");
const { signSessionJwt } = await import("../src/lib/session-jwt.ts");
const { getSessionCookieName } = await import("../src/lib/session-cookie.ts");
const { Permission } = await import("../src/lib/permissions.ts");
const { invalidateFeatureFlagCache } = await import("../src/lib/features.ts");

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
async function mintSession(opts: { role?: string; permissions?: bigint } = {}): Promise<string> {
  sessionSeq++;
  const userId = `admin-${sessionSeq}`;
  const sessionId = `sess-${sessionSeq}`;
  const role = opts.role ?? "ADMIN";
  const permissions = (opts.permissions ?? Permission.ADMIN).toString();
  usersById.set(userId, {
    role, permissions: BigInt(permissions), mediaServer: null, sessionsRevokedAt: null,
    passwordChangedAt: null, deactivatedAt: null, email: `a${sessionSeq}@example.com`, notificationEmail: null,
  });
  sessionRows.add(sessionId);
  const iat = Math.floor(Date.now() / 1000);
  return signSessionJwt(
    { id: userId, role, permissions, provider: "credentials", sessionId, expiresAt: iat + 86_400 },
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
  upsert: async (args: { where: { key: string }; create: { value: string } }) => {
    seq.push(`setting.upsert ${args.where.key}`);
    settings.set(args.where.key, args.create.value);
    return { key: args.where.key, value: args.create.value };
  },
  deleteMany: async () => ({ count: 0 }),
});

type Lib = { tmdbId: number; mediaType: "MOVIE" | "TV"; serverInstance: string; title: string; year: string | null; addedAt: Date | null };
let plexLib: Lib[] = [];
const inIds = (where: { tmdbId?: { in?: number[] } } | undefined, id: number | null) =>
  !where?.tmdbId?.in || (id !== null && where.tmdbId.in.includes(id));
shadowPrismaModel(prisma, "plexLibraryItem", {
  findMany: async (args: { where?: { tmdbId?: { in?: number[] } } }) => plexLib.filter((r) => inIds(args.where, r.tmdbId)),
});
shadowPrismaModel(prisma, "jellyfinLibraryItem", { findMany: async () => [] });
// Plays attributed by tmdb id — the never-watched loader's first evidence read.
let tmdbPlays: Array<{ tmdbId: number; mediaType: string; n: number; at: Date }> = [];
// Per-server first recorded play (coverage). Empty by default — every holder
// then reads "no history", so the watch rules never reach a verdict; the C132
// test below opts in.
let firstPlays: Array<{ source: string; serverInstance: string; _min: { startedAt: Date | null } }> = [];
shadowPrismaModel(prisma, "playHistory", {
  groupBy: async (args: { by: string[] }) =>
    args.by.join(",") === "tmdbId,mediaType"
      ? tmdbPlays.map((p) => ({ tmdbId: p.tmdbId, mediaType: p.mediaType, _count: { _all: p.n }, _max: { startedAt: p.at } }))
      : args.by.join(",") === "source,serverInstance"
        ? firstPlays
        : [],
  aggregate: async () => ({ _min: { startedAt: new Date("2025-01-01T00:00:00.000Z") } }),
});
let votes: Array<{ tmdbId: number; mediaType: string; n: number }> = [];
shadowPrismaModel(prisma, "deletionVote", {
  groupBy: async (args: { where?: { tmdbId?: { in?: number[] } } }) =>
    votes.filter((v) => inIds(args.where, v.tmdbId)).map((v) => ({ tmdbId: v.tmdbId, mediaType: v.mediaType, _count: { _all: v.n } })),
  deleteMany: async (args: unknown) => {
    seq.push(`deletionVote.deleteMany ${JSON.stringify(args)}`);
    return { count: 1 };
  },
});
type Req = { id: string; tmdbId: number; tvdbId?: number | null; mediaType: string; status: string; arrInstance: string; availableAt: Date | null; cleanedUpAt: Date | null; approvedAt: Date | null };
let requests: Req[] = [];
type ReqWhere = {
  id?: { in: string[] }; tmdbId?: number | { in: number[] }; tvdbId?: { in: number[] }; mediaType?: string;
  status?: string | { in: string[] }; cleanedUpAt?: null | Date; OR?: ReqWhere[];
  arrInstance?: string | { notIn: string[] };
};
const reqMatch = (r: Req, w: ReqWhere = {}): boolean =>
  (!w.id || w.id.in.includes(r.id)) &&
  (w.tmdbId === undefined || (typeof w.tmdbId === "number" ? r.tmdbId === w.tmdbId : w.tmdbId.in.includes(r.tmdbId))) &&
  (w.tvdbId === undefined || (r.tvdbId != null && w.tvdbId.in.includes(r.tvdbId))) &&
  (w.OR === undefined || w.OR.some((o) => reqMatch(r, o))) &&
  (w.mediaType === undefined || r.mediaType === w.mediaType) &&
  (w.arrInstance === undefined || (typeof w.arrInstance === "string" ? r.arrInstance === w.arrInstance : !w.arrInstance.notIn.includes(r.arrInstance))) &&
  (w.status === undefined || (typeof w.status === "string" ? r.status === w.status : w.status.in.includes(r.status))) &&
  (w.cleanedUpAt === undefined || (w.cleanedUpAt === null ? r.cleanedUpAt === null : r.cleanedUpAt?.getTime() === w.cleanedUpAt.getTime()));
const requestWrites: Array<{ where: ReqWhere; data: Record<string, unknown> }> = [];
let fulfilledRows: Array<{ tmdbId: number; mediaType: string; arrInstance: string; cleanedUpAt: Date | null; _min: { availableAt: Date | null } }> = [];
shadowPrismaModel(prisma, "mediaRequest", {
  findMany: async (args: { where?: ReqWhere }) => requests.filter((r) => reqMatch(r, args.where)).map((r) => ({ ...r })),
  // The never-watched loader's "fulfilled since" read (an arrival date). Empty
  // unless a test opts in (C136).
  groupBy: async () => fulfilledRows,
  updateMany: async (args: { where: ReqWhere; data: Record<string, unknown> }) => {
    requestWrites.push(args);
    seq.push(`mediaRequest.updateMany ${JSON.stringify(args.data)}`);
    let count = 0;
    for (const r of requests) if (reqMatch(r, args.where)) { Object.assign(r, args.data); count++; }
    return { count };
  },
});
shadowPrismaModel(prisma, "watchlistItem", { groupBy: async () => [] });
shadowPrismaModel(prisma, "activeSession", { findMany: async () => [] });
shadowPrismaModel(prisma, "upstreamWatchEvidence", { findMany: async () => [] });
let protections: Array<{ tmdbId: number; mediaType: string; title: string | null; reason: string | null; createdAt: Date }> = [];
// When set, a protection read answers with what it saw on arrival, but only
// once the gate opens — a computation parked mid-flight.
let protectionsGate: Promise<void> | null = null;
let protectionReads = 0;
shadowPrismaModel(prisma, "cleanupProtection", {
  findMany: async (args: { where?: { tmdbId?: { in?: number[] } } }) => {
    protectionReads++;
    const seen = protections.filter((p) => inIds(args.where, p.tmdbId));
    if (protectionsGate) await protectionsGate;
    return seen;
  },
  upsert: async (args: { where: { tmdbId_mediaType: { tmdbId: number; mediaType: string } }; create: { title: string | null; reason: string | null } }) => {
    seq.push("cleanupProtection.upsert");
    const { tmdbId, mediaType } = args.where.tmdbId_mediaType;
    protections = protections.filter((p) => !(p.tmdbId === tmdbId && p.mediaType === mediaType));
    const row = { tmdbId, mediaType, title: args.create.title, reason: args.create.reason, createdAt: new Date() };
    protections.push(row);
    return row;
  },
  deleteMany: async (args: { where: { tmdbId: number; mediaType: string } }) => {
    const before = protections.length;
    protections = protections.filter((p) => !(p.tmdbId === args.where.tmdbId && p.mediaType === args.where.mediaType));
    return { count: before - protections.length };
  },
});
shadowPrismaModel(prisma, "tmdbMediaCore", { findMany: async () => [] });
// TMDB's tmdb→tvdb cross-reference, as resolveTmdbToTvdb reads it from the cache.
let tmdbToTvdb = new Map<number, number>();
shadowPrismaModel(prisma, "tmdbCache", {
  findMany: async () => [],
  findUnique: async (args: { where: { key: string } }) => {
    const m = /^tmdb-to-tvdb:(\d+)$/.exec(args.where.key);
    const tvdbId = m ? tmdbToTvdb.get(Number(m[1])) : undefined;
    return tvdbId === undefined ? null : { key: args.where.key, data: JSON.stringify({ tvdbId }), expiresAt: new Date(Date.now() + 86_400_000) };
  },
});
let blacklistUpserts: Array<Record<string, unknown>> = [];
shadowPrismaModel(prisma, "blacklistItem", {
  upsert: async (args: Record<string, unknown>) => {
    seq.push("blacklistItem.upsert");
    blacklistUpserts.push(args);
    return {};
  },
});
let auditFails = false;
let audits: Array<{ action: string; target: string; details: Record<string, unknown> }> = [];
shadowPrismaModel(prisma, "auditLog", {
  create: async (args: { data: { action: string; target: string; details: string | null } }) => {
    seq.push(`audit ${args.data.action} ${args.data.target}`);
    if (auditFails) throw new Error("simulated audit failure");
    audits.push({ action: args.data.action, target: args.data.target, details: args.data.details ? JSON.parse(args.data.details) : {} });
    return { id: "audit" };
  },
});
shadowPrismaClientMethod(prisma, "$transaction", async (arg: unknown) => {
  if (Array.isArray(arg)) return Promise.all(arg);
  throw new Error("interactive transaction not expected in cleanup routes");
});

const report = await import("../src/app/api/admin/cleanup/route.ts");
const settingsRoute = await import("../src/app/api/admin/cleanup/settings/route.ts");
const protectRoute = await import("../src/app/api/admin/cleanup/protect/route.ts");
const deleteRoute = await import("../src/app/api/admin/cleanup/delete/route.ts");
const { CLEANUP_MAX_ITEMS } = await import("../src/lib/library-cleanup.ts");
const neverWatchedRoute = await import("../src/app/api/admin/never-watched/route.ts");
// The listing's 502/503/504 retry pauses 2 s in production; no test should wait.
const { _setArrListingRetryDelayForTests, getCachedArrLibraryIndex, invalidateArrLibraryIndexCache } = await import("../src/lib/library-cleanup-arr.ts");
_setArrListingRetryDelayForTests(0);
const { invalidateNeverWatchedReport, getTitleNeverWatched } = await import("../src/lib/never-watched-report.ts");
const { clearActivityCache } = await import("../src/lib/play-history.ts");

// Yields to the event loop until `pred` holds (or gives up) — for a test that
// parks one computation and needs it to reach the gate first.
async function settleUntil(pred: () => boolean, ticks = 500): Promise<boolean> {
  for (let i = 0; i < ticks && !pred(); i++) await new Promise((r) => setImmediate(r));
  return pred();
}

// ── request scope ────────────────────────────────────────────────────────────
const afterTasks: unknown[] = [];
function inScope<T>(fn: () => Promise<T>): Promise<T> {
  const workStore = {
    route: "/cleanup.test",
    forceStatic: false,
    dynamicShouldError: false,
    afterContext: { after: (task: unknown) => { afterTasks.push(task); } },
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
function req(token: string | null, path: string, method: string, body?: unknown) {
  return new NextRequest(`http://localhost:3000/api/admin/cleanup${path}`, {
    method,
    headers: { ...(token ? { cookie: `${COOKIE}=${token}` } : {}), "content-type": "application/json" },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
}
const call = (handler: (r: unknown, c: unknown) => Promise<Response>, token: string | null, path: string, method: string, body?: unknown) =>
  inScope(() => handler(req(token, path, method, body), undefined));
const dryRun = (token: string | null, body: unknown) => call(deleteRoute.POST as never, token, "/delete", "POST", body);
const execute = (token: string | null, body: unknown) => call(deleteRoute.POST as never, token, "/delete?execute=true", "POST", body);

const deletes = () => calls.filter((c) => c.method === "DELETE");

// ── fixture ──────────────────────────────────────────────────────────────────
// Rule: at least 1 deletion vote. 100 = movie on default + 4K Radarr; 200 = movie,
// protected; 300 = show on Sonarr; 400 = movie no *arr manages; 500 = movie with
// a pending request.
beforeEach(() => {
  seq = [];
  calls = [];
  afterTasks.length = 0;
  requestWrites.length = 0;
  blacklistUpserts = [];
  audits = [];
  auditFails = false;
  deleteStatus = () => 200;
  listingStatus = () => 200;
  listingHook = null;
  protectionsGate = null;
  protectionReads = 0;
  tmdbPlays = [];
  firstPlays = [];
  tmdbToTvdb = new Map();
  fulfilledRows = [];
  // Both read-only caches are process-wide; every test starts from a cold one.
  invalidateArrLibraryIndexCache();
  invalidateNeverWatchedReport();
  settings.clear();
  for (const [k, v] of Object.entries({
    "feature.admin.cleanup": "true",
    playHistoryEnabled: "true",
    // Set for every test (play-history caches these settings 15 s, across
    // tests): with no first play recorded (`firstPlays` empty) a holder still
    // reads "no history", so only the C132 test reaches a watch verdict.
    playHistoryPlexEnabled: "true",
    cleanupVotesEnabled: "true",
    cleanupVotesMin: "1",
    cleanupMinAgeDays: "0",
    radarrUrl: RADARR, radarrApiKey: "radarr-key",
    radarr4kUrl: RADARR_4K, radarr4kApiKey: "radarr4k-key",
    sonarrUrl: SONARR, sonarrApiKey: "sonarr-key",
  })) settings.set(k, v);
  invalidateFeatureFlagCache();
  const added = new Date("2024-01-01T00:00:00.000Z");
  plexLib = [100, 200, 400, 500].map((tmdbId) => ({ tmdbId, mediaType: "MOVIE" as const, serverInstance: "", title: `Movie ${tmdbId}`, year: "2020", addedAt: added }));
  plexLib.push({ tmdbId: 300, mediaType: "TV", serverInstance: "", title: "Show 300", year: "2019", addedAt: added });
  votes = [100, 200, 300, 400, 500].map((tmdbId) => ({ tmdbId, mediaType: tmdbId === 300 ? "TV" : "MOVIE", n: 2 }));
  protections = [{ tmdbId: 200, mediaType: "MOVIE", title: "Movie 200", reason: null, createdAt: new Date() }];
  requests = [
    { id: "r100a", tmdbId: 100, mediaType: "MOVIE", status: "AVAILABLE", arrInstance: "", availableAt: new Date("2024-02-01"), cleanedUpAt: null, approvedAt: new Date("2024-01-15") },
    { id: "r100b", tmdbId: 100, mediaType: "MOVIE", status: "AVAILABLE", arrInstance: "4k", availableAt: new Date("2024-02-01"), cleanedUpAt: null, approvedAt: null },
    { id: "r300", tmdbId: 300, mediaType: "TV", status: "AVAILABLE", arrInstance: "", availableAt: new Date("2024-02-01"), cleanedUpAt: null, approvedAt: new Date("2024-01-15") },
    { id: "r500", tmdbId: 500, mediaType: "MOVIE", status: "PENDING", arrInstance: "", availableAt: null, cleanedUpAt: null, approvedAt: null },
  ];
  radarrMovies = {
    [RADARR]: [
      { id: 11, tmdbId: 100, title: "Movie 100", sizeOnDisk: 1_000 },
      { id: 12, tmdbId: 200, title: "Movie 200", sizeOnDisk: 2_000 },
      { id: 15, tmdbId: 500, title: "Movie 500", sizeOnDisk: 5_000 },
    ],
    [RADARR_4K]: [{ id: 21, tmdbId: 100, title: "Movie 100", sizeOnDisk: 9_000 }],
  };
  sonarrSeries = [{ id: 31, tmdbId: 300, tvdbId: 3000, title: "Show 300", status: "ended", statistics: { sizeOnDisk: 700 } }];
});

const MOVIE_100 = { tmdbId: 100, mediaType: "MOVIE" };
const SHOW_300 = { tmdbId: 300, mediaType: "TV" };

// ── 1/2: auth + feature gate ─────────────────────────────────────────────────

test("anonymous is 401 on every cleanup route, and nothing reaches Radarr/Sonarr", async () => {
  assert.equal((await call(report.GET as never, null, "", "GET")).status, 401);
  assert.equal((await call(settingsRoute.PATCH as never, null, "/settings", "PATCH", { votesMin: 2 })).status, 401);
  assert.equal((await call(protectRoute.POST as never, null, "/protect", "POST", MOVIE_100)).status, 401);
  assert.equal((await execute(null, { items: [MOVIE_100], confirmTargets: 2 })).status, 401);
  assert.deepEqual(calls, []);
});

for (const [label, role, permissions] of [
  ["a plain USER", "USER", 0n],
  ["an ISSUE_ADMIN", "ISSUE_ADMIN", Permission.MANAGE_ISSUES],
  ["a MANAGE_USERS delegate", "USER", Permission.MANAGE_USERS],
] as const) {
  test(`${label} is refused 403 — deleting media is ADMIN-only — and no DELETE is sent`, async () => {
    const token = await mintSession({ role, permissions });
    assert.equal((await call(report.GET as never, token, "", "GET")).status, 403);
    assert.equal((await dryRun(token, { items: [MOVIE_100] })).status, 403);
    assert.equal((await execute(token, { items: [MOVIE_100], confirmTargets: 2 })).status, 403);
    assert.equal((await call(protectRoute.POST as never, token, "/protect", "POST", MOVIE_100)).status, 403);
    assert.deepEqual(deletes(), []);
    assert.deepEqual(requestWrites, []);
  });
}

test("protect POST/DELETE reject a tmdbId past INT4 with 400 and write nothing", async () => {
  const token = await mintSession();
  const before = protections.length;
  const big = { tmdbId: 2_147_483_648, mediaType: "MOVIE", title: "x" };
  assert.equal((await call(protectRoute.POST as never, token, "/protect", "POST", big)).status, 400);
  assert.equal((await call(protectRoute.DELETE as never, token, "/protect?tmdbId=2147483648&mediaType=MOVIE", "DELETE")).status, 400);
  assert.equal(protections.length, before);
});

test("with feature.admin.cleanup off every route 404s and nothing is deleted", async () => {
  settings.set("feature.admin.cleanup", "false");
  invalidateFeatureFlagCache();
  const token = await mintSession();
  assert.equal((await call(report.GET as never, token, "", "GET")).status, 404);
  assert.equal((await call(settingsRoute.GET as never, token, "/settings", "GET")).status, 404);
  assert.equal((await call(protectRoute.DELETE as never, token, "/protect?tmdbId=100&mediaType=MOVIE", "DELETE")).status, 404);
  assert.equal((await execute(token, { items: [MOVIE_100], confirmTargets: 2 })).status, 404);
  assert.deepEqual(deletes(), []);
});

// ── report ───────────────────────────────────────────────────────────────────

test("report: candidates first, held-back titles named with their exclusions, sizes summed across instances", async () => {
  const res = await call(report.GET as never, await mintSession(), "", "GET");
  assert.equal(res.status, 200);
  const body = await res.json();
  const byId = new Map(body.rows.map((r: { tmdbId: number }) => [r.tmdbId, r]));
  assert.deepEqual((byId.get(100) as { matched: string[] }).matched, ["votes"]);
  assert.equal((byId.get(100) as { sizeOnDisk: number }).sizeOnDisk, 10_000, "default + 4K copies");
  assert.deepEqual((byId.get(200) as { excludedBy: string[] }).excludedBy, ["protected"]);
  assert.deepEqual((byId.get(500) as { excludedBy: string[] }).excludedBy, ["activeRequest"]);
  assert.equal((byId.get(400) as { sizeOnDisk: null }).sizeOnDisk, null, "no *arr entry → no size");
  assert.equal(body.totals.candidates, 3);
  assert.equal(body.totals.held, 2);
  assert.ok(body.rows.slice(0, 3).every((r: { candidate: boolean }) => r.candidate), "candidates sort first");
  assert.deepEqual(deletes(), [], "the report never deletes");
  assert.deepEqual(requestWrites, []);
});

// ── 3: dry run, then a confirmed execute ─────────────────────────────────────

test("dry run: resolves every instance's copy, returns the count, and changes nothing", async () => {
  const res = await dryRun(await mintSession(), { items: [MOVIE_100, SHOW_300] });
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.dryRun, true);
  assert.equal(body.targetCount, 3, "Radarr default + Radarr 4K + Sonarr");
  const targets = body.items.flatMap((i: { targets: Array<{ service: string; instance: string; arrId: number }> }) => i.targets.map((t) => `${t.service}:${t.instance}:${t.arrId}`)).sort();
  assert.deepEqual(targets, ["radarr:4k:21", "radarr::11", "sonarr::31"]);
  assert.equal(body.reclaimableBytes, 10_700);
  assert.deepEqual(deletes(), []);
  assert.deepEqual(requestWrites, []);
  assert.deepEqual(blacklistUpserts, []);
  assert.deepEqual(audits, []);
});

for (const [label, confirm] of [["no", undefined], ["a stale", 2], ["a string", "3"]] as const) {
  test(`execute with ${label} confirmTargets is 409, returns the live plan, and deletes nothing`, async () => {
    const res = await execute(await mintSession(), { items: [MOVIE_100, SHOW_300], ...(confirm !== undefined ? { confirmTargets: confirm } : {}) });
    assert.equal(res.status, 409);
    assert.equal((await res.json()).targetCount, 3);
    assert.deepEqual(deletes(), []);
    assert.deepEqual(requestWrites, []);
  });
}

test("a title that stopped being a candidate since the dry run drops out of the count, so the old confirmation 409s", async () => {
  const token = await mintSession();
  const plan = await (await dryRun(token, { items: [MOVIE_100] })).json();
  assert.equal(plan.targetCount, 2);
  // Someone requests it in between.
  requests.push({ id: "late", tmdbId: 100, mediaType: "MOVIE", status: "PENDING", arrInstance: "", availableAt: null, cleanedUpAt: null, approvedAt: null });
  const res = await execute(token, { items: [MOVIE_100], confirmTargets: plan.targetCount });
  assert.equal(res.status, 409);
  assert.deepEqual(deletes(), []);
});

// ── 4: the delete calls ──────────────────────────────────────────────────────

test("execute: Radarr and Sonarr get the right DELETE, with files and the import exclusion, on EACH instance", async () => {
  const res = await execute(await mintSession(), { items: [MOVIE_100, SHOW_300], confirmTargets: 3 });
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.deletedCount, 2);
  const got = deletes().map((c) => `${c.origin}${c.path}${c.query}`).sort();
  assert.deepEqual(got, [
    `${RADARR}/api/v3/movie/11?deleteFiles=true&addImportExclusion=true`,
    `${RADARR_4K}/api/v3/movie/21?deleteFiles=true&addImportExclusion=true`,
    `${SONARR}/api/v3/series/31?deleteFiles=true&addImportListExclusion=true`,
  ].sort());
});

test("execute: a not-a-candidate title in the body is skipped, never deleted", async () => {
  const token = await mintSession();
  const items = [MOVIE_100, { tmdbId: 200, mediaType: "MOVIE" }, { tmdbId: 500, mediaType: "MOVIE" }, { tmdbId: 400, mediaType: "MOVIE" }];
  const plan = await (await dryRun(token, { items })).json();
  assert.equal(plan.targetCount, 2, "only 100's two copies");
  const skipped = new Map(plan.skipped.map((s: { tmdbId: number; reason: string }) => [s.tmdbId, s.reason]));
  assert.match(String(skipped.get(200)), /Protected/);
  assert.match(String(skipped.get(500)), /Pending or approved request/);
  assert.match(String(skipped.get(400)), /Not managed/);
  await execute(token, { items, confirmTargets: 2 });
  assert.deepEqual(deletes().map((c) => c.path).sort(), ["/api/v3/movie/11", "/api/v3/movie/21"]);
});

test("a Radarr instance whose listing failed refuses its titles rather than half-deleting them", async () => {
  listingStatus = (origin) => (origin === RADARR_4K ? 503 : 200);
  const body = await (await dryRun(await mintSession(), { items: [MOVIE_100, SHOW_300] })).json();
  assert.equal(body.targetCount, 1, "only the show");
  assert.match(body.skipped.find((s: { tmdbId: number }) => s.tmdbId === 100).reason, /Could not read Radarr/);
});

// ── 5/6: partial failure + the no-re-download stamp ─────────────────────────

test("execute: requests are stamped cleanedUpAt BEFORE the first delete, and audit lands AFTER it", async () => {
  await execute(await mintSession(), { items: [SHOW_300], confirmTargets: 1 });
  const stamp = seq.findIndex((s) => s.startsWith("mediaRequest.updateMany") && s.includes("cleanedUpAt"));
  const del = seq.findIndex((s) => s.startsWith("delete "));
  const audit = seq.findIndex((s) => s.startsWith("audit LIBRARY_CLEANUP_DELETE"));
  assert.ok(stamp >= 0 && del > stamp, `stamp before delete: ${seq.join(" | ")}`);
  assert.ok(audit > del, "audit after the upstream delete");
  assert.ok(requests.find((r) => r.id === "r300")!.cleanedUpAt instanceof Date);
});

test("execute: the stamp never touches status or approvedAt (guardrail 34a)", async () => {
  await execute(await mintSession(), { items: [MOVIE_100], confirmTargets: 2 });
  for (const w of requestWrites) {
    assert.deepEqual(Object.keys(w.data), ["cleanedUpAt"]);
  }
  const r = requests.find((x) => x.id === "r100a")!;
  assert.equal(r.status, "AVAILABLE");
  assert.equal(r.approvedAt?.toISOString(), new Date("2024-01-15").toISOString());
  assert.ok(requests.find((x) => x.id === "r100b")!.cleanedUpAt, "every instance's request is stamped");
});

test("complete delete: votes cleared, title blacklisted (default on) with the cleanup reason, audit records it", async () => {
  await execute(await mintSession(), { items: [MOVIE_100], confirmTargets: 2 });
  assert.ok(seq.some((s) => s.startsWith("deletionVote.deleteMany")));
  assert.equal(blacklistUpserts.length, 1);
  assert.equal((blacklistUpserts[0].create as { reason: string }).reason, "Removed by library cleanup");
  assert.equal(audits.length, 1);
  assert.equal(audits[0].action, "LIBRARY_CLEANUP_DELETE");
  assert.deepEqual(audits[0].details.deleted, ["radarr:default", "radarr:4k"]);
  assert.equal(audits[0].details.blacklisted, true);
});

test("blacklist: false skips the blacklist but still stamps and clears votes", async () => {
  await execute(await mintSession(), { items: [MOVIE_100], blacklist: false, confirmTargets: 2 });
  assert.equal(blacklistUpserts.length, 0);
  assert.ok(requests.find((r) => r.id === "r100a")!.cleanedUpAt);
});

test("partial failure: one instance 500s — reported per title as partial, stamp kept, not blacklisted, no 500", async () => {
  deleteStatus = (origin) => (origin === RADARR_4K ? 500 : 200);
  const res = await execute(await mintSession(), { items: [MOVIE_100, SHOW_300], confirmTargets: 3 });
  assert.equal(res.status, 200);
  const body = await res.json();
  const r100 = body.results.find((r: { tmdbId: number }) => r.tmdbId === 100);
  assert.equal(r100.status, "partial");
  assert.deepEqual(r100.deleted, ["radarr:default"]);
  assert.equal(r100.failed[0].target, "radarr:4k");
  assert.equal(body.results.find((r: { tmdbId: number }) => r.tmdbId === 300).status, "deleted", "the other title is unaffected");
  assert.equal(body.partialCount, 1);
  assert.equal(body.deletedCount, 1);
  assert.ok(requests.find((r) => r.id === "r100a")!.cleanedUpAt, "half-gone is still gone from the default instance — keep the stamp");
  assert.equal(blacklistUpserts.filter((b) => (b.where as { tmdbId_mediaType: { tmdbId: number } }).tmdbId_mediaType.tmdbId === 100).length, 0);
});

test("partial failure: the requests on the instance whose delete failed lose the stamp — that instance still holds the title", async () => {
  deleteStatus = (origin) => (origin === RADARR_4K ? 500 : 200);
  const body = await (await execute(await mintSession(), { items: [MOVIE_100], confirmTargets: 2 })).json();
  assert.equal(body.results[0].status, "partial");
  assert.ok(requests.find((r) => r.id === "r100a")!.cleanedUpAt instanceof Date, "the default copy is gone — its request keeps the stamp");
  assert.equal(requests.find((r) => r.id === "r100b")!.cleanedUpAt, null, "4K still holds it, so a later loss there is a lost file and re-pushed");
  assert.equal(audits[0].details.requestsStamped, 1);
  for (const w of requestWrites) assert.deepEqual(Object.keys(w.data), ["cleanedUpAt"], "status and approvedAt are never written");
});

test("total failure: nothing deleted ⇒ the stamp this call wrote is removed again", async () => {
  deleteStatus = () => 503;
  const body = await (await execute(await mintSession(), { items: [MOVIE_100], confirmTargets: 2 })).json();
  assert.equal(body.failedCount, 1);
  assert.equal(requests.find((r) => r.id === "r100a")!.cleanedUpAt, null);
  assert.equal(requests.find((r) => r.id === "r100b")!.cleanedUpAt, null);
  assert.equal(audits.length, 0, "nothing was deleted, so there is nothing to audit");
});

test("an older stamp survives a later failed attempt — the unstamp only clears what this call wrote", async () => {
  const older = new Date("2026-01-01T00:00:00.000Z");
  requests.find((r) => r.id === "r100b")!.cleanedUpAt = older;
  deleteStatus = () => 503;
  await execute(await mintSession(), { items: [MOVIE_100], confirmTargets: 2 });
  assert.equal(requests.find((r) => r.id === "r100b")!.cleanedUpAt?.getTime(), older.getTime());
});

// Audit C014: two executes of one title in flight at once (two tabs, or both
// pages). The first stamps; the second finds every row already stamped and owns
// none. If the second's DELETE succeeds and the first's is refused, the first
// unstamps by ITS time — the only stamp on a title that is gone, so the next
// sync re-downloads it. A delete that went through re-asserts the stamp with its
// own time, so that unstamp misses (or, if it ran first, is written back).
test("C014: a delete that went through takes over the stamp, so a concurrent execute's failed-delete unstamp can't clear it", async () => {
  const otherNow = new Date("2026-10-01T00:00:00.000Z");
  for (const id of ["r100a", "r100b"]) requests.find((r) => r.id === id)!.cleanedUpAt = otherNow;
  const body = await (await execute(await mintSession(), { items: [MOVIE_100], confirmTargets: 2 })).json();
  assert.equal(body.results[0].status, "deleted");
  for (const id of ["r100a", "r100b"]) {
    const at = requests.find((r) => r.id === id)!.cleanedUpAt;
    assert.ok(at instanceof Date && at.getTime() !== otherNow.getTime(), `${id} carries this call's stamp, not the concurrent one's`);
  }
  // The concurrent execute's unstamp, exactly as the route writes it.
  for (const r of requests) if (reqMatch(r, { id: { in: ["r100a", "r100b"] }, cleanedUpAt: otherNow })) r.cleanedUpAt = null;
  for (const id of ["r100a", "r100b"]) assert.ok(requests.find((r) => r.id === id)!.cleanedUpAt instanceof Date, `${id} stays stamped`);
});

test("C014: a concurrent unstamp that lands while this call's DELETE is in flight is written back", async () => {
  const otherNow = new Date("2026-10-01T00:00:00.000Z");
  requests.find((r) => r.id === "r300")!.cleanedUpAt = otherNow;
  deleteStatus = () => {
    // The other execute's delete was refused: it unstamps by its own time.
    for (const r of requests) if (reqMatch(r, { id: { in: ["r300"] }, cleanedUpAt: otherNow })) r.cleanedUpAt = null;
    return 200;
  };
  const body = await (await execute(await mintSession(), { items: [SHOW_300], confirmTargets: 1 })).json();
  assert.equal(body.results[0].status, "deleted");
  assert.ok(requests.find((r) => r.id === "r300")!.cleanedUpAt instanceof Date, "the show is gone from Sonarr — it must stay stamped");
});

// Review round 2: the same race when THIS call's delete has an UNKNOWN outcome
// (a timeout, a gateway 504) and nothing was confirmed deleted. The arr may have
// taken it, so "maybe deleted" must hold the stamp as "deleted" does — this call
// owned none (the other execute stamped first), and the other's definite
// refusal unstamps by its own time while this DELETE hangs.
test("C014: an unknown-outcome delete re-asserts the stamp too, so a concurrent execute's refusal can't unstamp a maybe-deleted title", async () => {
  const otherNow = new Date("2026-10-01T00:00:00.000Z");
  requests.find((r) => r.id === "r300")!.cleanedUpAt = otherNow;
  deleteStatus = () => {
    for (const r of requests) if (reqMatch(r, { id: { in: ["r300"] }, cleanedUpAt: otherNow })) r.cleanedUpAt = null;
    return 504;
  };
  const body = await (await execute(await mintSession(), { items: [SHOW_300], confirmTargets: 1 })).json();
  assert.equal(body.results[0].status, "failed");
  assert.equal(body.results[0].uncertain, true);
  assert.ok(requests.find((r) => r.id === "r300")!.cleanedUpAt instanceof Date, "Sonarr may have removed the show — it must stay stamped");
});

test("C014 control: a DEFINITE refusal with nothing deleted re-asserts nothing — the older stamp is left as it was, and this call's own stamps go", async () => {
  const otherNow = new Date("2026-10-01T00:00:00.000Z");
  requests.find((r) => r.id === "r300")!.cleanedUpAt = otherNow;
  // A request for the show routed to an instance that holds no copy: this call
  // stamps it, and a definite total failure must take that stamp back off.
  requests.push({ ...requests.find((r) => r.id === "r300")!, id: "r300x", arrInstance: "anime", cleanedUpAt: null });
  deleteStatus = () => 503;
  const body = await (await execute(await mintSession(), { items: [SHOW_300], confirmTargets: 1 })).json();
  assert.equal(body.results[0].status, "failed");
  assert.equal("uncertain" in body.results[0], false);
  assert.equal(requests.find((r) => r.id === "r300")!.cleanedUpAt?.getTime(), otherNow.getTime());
  assert.equal(requests.find((r) => r.id === "r300x")!.cleanedUpAt, null, "nothing was deleted anywhere — no stamp may stay");
});

test("C014: a failed re-assert after a durable delete is reported on the title, never a 500", async () => {
  const realUpdateMany = (prisma.mediaRequest as unknown as { updateMany: (a: unknown) => Promise<unknown> }).updateMany;
  let n = 0;
  (prisma.mediaRequest as unknown as { updateMany: (a: { data: { cleanedUpAt: Date | null }; where: { status?: unknown } }) => Promise<unknown> }).updateMany = async (a) => {
    // The up-front stamp is keyed `cleanedUpAt: null`; the re-assert by status.
    if (a.where.status !== undefined && n++ === 0) throw new Error("simulated write failure");
    return realUpdateMany(a);
  };
  try {
    const res = await execute(await mintSession(), { items: [MOVIE_100], confirmTargets: 2 });
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.results[0].status, "deleted");
    assert.equal(body.results[0].bookkeepingError, "simulated write failure");
  } finally {
    (prisma.mediaRequest as unknown as { updateMany: unknown }).updateMany = realUpdateMany;
  }
});

// Audit C057: a failure the page shows carries a translatable kind and names
// its instance, instead of only the English arrErrorMessage text.
test("C057: a refused delete reports the instance and a translatable kind beside the English detail", async () => {
  deleteStatus = (origin) => (origin === RADARR_4K ? 401 : 200);
  const body = await (await execute(await mintSession(), { items: [MOVIE_100], confirmTargets: 2 })).json();
  assert.deepEqual(body.results[0].failed, [{
    target: "radarr:4k", service: "radarr", instance: "4k",
    error: "Arr authentication failed (401) — check the API key", kind: "auth",
  }]);
  assert.deepEqual(audits[0].details.failed, ["radarr:4k"], "the audit still records only the target");
});

test("C057: the never-watched coverage carries the upstream check's error code, so the page never prints the stored English", async () => {
  settings.set("upstreamWatch:status:plex:", JSON.stringify({
    fetchedAt: null, attemptedAt: new Date().toISOString(), ok: false,
    entries: 0, matched: 0, samples: 0, agreed: 0, error: "HTTP 401",
  }));
  const body = await (await nwCall(await mintSession(), "state=all&fresh=1")).json() as { coverage: Array<{ server: string; upstream: { error: string | null; errorCode: string | null; httpStatus: number | null } }> };
  const plex = body.coverage.find((c) => c.server === "plex")!;
  assert.deepEqual(plex.upstream.error, "HTTP 401");
  assert.equal(plex.upstream.errorCode, "http");
  assert.equal(plex.upstream.httpStatus, 401);
});

test("a 404 on delete (already removed by hand) counts as deleted", async () => {
  deleteStatus = (origin) => (origin === RADARR_4K ? 404 : 200);
  const body = await (await execute(await mintSession(), { items: [MOVIE_100], confirmTargets: 2 })).json();
  assert.equal(body.results[0].status, "deleted");
});

// ── 7: audit after commit, swallowing ────────────────────────────────────────

test("a failing audit write never turns a completed delete into an error (guardrail 26)", async () => {
  auditFails = true;
  const res = await execute(await mintSession(), { items: [MOVIE_100], confirmTargets: 2 });
  assert.equal(res.status, 200);
  assert.equal((await res.json()).deletedCount, 1);
  assert.equal(deletes().length, 2);
});

test("a library scan is scheduled through after(), not awaited in the request", async () => {
  await execute(await mintSession(), { items: [MOVIE_100, SHOW_300], confirmTargets: 3 });
  assert.equal(afterTasks.length, 2, "one per media type");
});

// ── body validation ──────────────────────────────────────────────────────────

for (const [label, body] of [
  ["no items", {}],
  ["an empty list", { items: [] }],
  ["a string tmdbId", { items: [{ tmdbId: "100", mediaType: "MOVIE" }] }],
  ["a bad mediaType", { items: [{ tmdbId: 100, mediaType: "movie" }] }],
  ["a non-boolean blacklist", { items: [MOVIE_100], blacklist: "yes" }],
] as const) {
  test(`delete with ${label} is 400 and reaches no *arr`, async () => {
    assert.equal((await dryRun(await mintSession(), body)).status, 400);
    assert.deepEqual(calls, []);
  });
}

// The route takes exactly CLEANUP_MAX_ITEMS titles — the cap both pages stop
// their selection at (C062): a full selection is judged, one more is a 400.
test("delete takes exactly CLEANUP_MAX_ITEMS titles: a full selection is judged, one more is a 400 naming the cap that reaches no *arr", async () => {
  const token = await mintSession();
  const filler = (n: number) => Array.from({ length: n }, (_, i) => ({ tmdbId: 10_000 + i, mediaType: "MOVIE" }));
  const full = await dryRun(token, { items: [MOVIE_100, SHOW_300, ...filler(CLEANUP_MAX_ITEMS - 2)] });
  assert.equal(full.status, 200, "the last title that fits is accepted");
  assert.equal((await full.json()).targetCount, 3, "titles no instance holds add no target");
  calls = [];
  const over = await dryRun(token, { items: [MOVIE_100, SHOW_300, ...filler(CLEANUP_MAX_ITEMS - 1)] });
  assert.equal(over.status, 400, "one past the cap is refused");
  assert.match(((await over.json()) as { error: string }).error, new RegExp(`1–${CLEANUP_MAX_ITEMS} `));
  assert.deepEqual(calls, [], "refused before any *arr listing");
});

// ── settings + protect ───────────────────────────────────────────────────────

test("settings PATCH writes the mapped keys and refuses a bad value without writing anything", async () => {
  const token = await mintSession();
  const bad = await call(settingsRoute.PATCH as never, token, "/settings", "PATCH", { unwatchedEnabled: true, unwatchedDays: 0 });
  assert.equal(bad.status, 400);
  assert.ok(!seq.some((s) => s.startsWith("setting.upsert")));
  const ok = await call(settingsRoute.PATCH as never, token, "/settings", "PATCH", { unwatchedEnabled: true, unwatchedDays: 200 });
  assert.equal(ok.status, 200);
  assert.equal(settings.get("cleanupUnwatchedEnabled"), "true");
  assert.equal(settings.get("cleanupUnwatchedDays"), "200");
  assert.equal((await ok.json()).settings.unwatchedDays, 200);
});

test("protect then unprotect round-trips and is audited", async () => {
  const token = await mintSession();
  assert.equal((await call(protectRoute.POST as never, token, "/protect", "POST", { ...MOVIE_100, title: "Movie 100" })).status, 201);
  assert.ok(protections.some((p) => p.tmdbId === 100));
  const plan = await (await dryRun(token, { items: [MOVIE_100] })).json();
  assert.equal(plan.targetCount, 0, "a protected title has nothing to delete");
  assert.equal((await call(protectRoute.DELETE as never, token, "/protect?tmdbId=100&mediaType=MOVIE", "DELETE")).status, 200);
  assert.ok(!protections.some((p) => p.tmdbId === 100));
  assert.deepEqual(audits.map((a) => a.action), ["LIBRARY_CLEANUP_PROTECT", "LIBRARY_CLEANUP_PROTECT"]);
});

// ── never-watched report (guardrail 14d) ─────────────────────────────────────
// The report lives on the cleanup engine: "eligible" there must be EXACTLY what
// the delete route's dry run includes, or the page offers deletions the route
// refuses (or worse, the reverse). `fresh=1` bypasses the report's short cache.
const nwCall = (token: string | null, query: string) =>
  inScope(() =>
    (neverWatchedRoute.GET as never as (r: unknown, c: unknown) => Promise<Response>)(
      new NextRequest(`http://localhost:3000/api/admin/never-watched?${query}`, {
        headers: token ? { cookie: `${COOKIE}=${token}` } : {},
      }),
      undefined,
    ),
  );

test("never-watched report: anonymous 401, non-admin 403, flag off 404", async () => {
  assert.equal((await nwCall(null, "")).status, 401);
  assert.equal((await nwCall(await mintSession({ role: "USER", permissions: Permission.MANAGE_USERS }), "")).status, 403);
  settings.set("feature.admin.neverWatched", "false");
  invalidateFeatureFlagCache();
  assert.equal((await nwCall(await mintSession(), "")).status, 404);
});

test("never-watched report: 'eligible' is exactly the delete dry run's selection, and loading it writes nothing", async () => {
  const token = await mintSession();
  const res = await nwCall(token, "state=all&limit=200&fresh=1");
  assert.equal(res.status, 200);
  const body = await res.json() as { rows: Array<{ tmdbId: number; mediaType: "MOVIE" | "TV"; eligible: boolean; sizeOnDisk: number | null }>; total: number; cleanupEnabled: boolean };
  assert.equal(body.cleanupEnabled, true);
  assert.equal(body.total, body.rows.length);
  const eligible = body.rows.filter((r) => r.eligible).map((r) => `${r.mediaType}:${r.tmdbId}`).sort();
  assert.ok(eligible.length > 0, "the fixture has deletable titles");
  const plan = await (await dryRun(token, { items: body.rows.map((r) => ({ tmdbId: r.tmdbId, mediaType: r.mediaType })) })).json() as { items: Array<{ tmdbId: number; mediaType: string }> };
  assert.deepEqual(plan.items.map((i) => `${i.mediaType}:${i.tmdbId}`).sort(), eligible);
  assert.deepEqual(deletes(), []);
  assert.deepEqual(requestWrites, []);
  assert.deepEqual(audits, []);
});


// A down instance makes the delete route refuse EVERY title of that service
// (arrUnreadable), so the report must not call one eligible either (C123).
test("never-watched report: while a Radarr instance can't be listed, no movie is eligible — still exactly the dry run's selection", async () => {
  const token = await mintSession();
  listingStatus = (origin) => (origin === RADARR_4K ? 503 : 200);
  try {
    const body = await (await nwCall(token, "state=all&limit=200&fresh=1")).json() as { rows: Array<{ tmdbId: number; mediaType: "MOVIE" | "TV"; eligible: boolean }> };
    const eligible = body.rows.filter((r) => r.eligible).map((r) => `${r.mediaType}:${r.tmdbId}`).sort();
    assert.ok(!eligible.some((k) => k.startsWith("MOVIE:")), `no movie is eligible while Radarr 4K is down: ${eligible.join(", ")}`);
    assert.ok(eligible.includes("TV:300"), "Sonarr's titles are unaffected");
    const plan = await (await dryRun(token, { items: body.rows.map((r) => ({ tmdbId: r.tmdbId, mediaType: r.mediaType })) })).json() as { items: Array<{ tmdbId: number; mediaType: string }> };
    assert.deepEqual(plan.items.map((i) => `${i.mediaType}:${i.tmdbId}`).sort(), eligible);
    assert.deepEqual(deletes(), []);
  } finally {
    listingStatus = () => 200;
  }
});

test("never-watched report: sorted by size, biggest first, unknown sizes last; paged", async () => {
  const token = await mintSession();
  const page1 = await (await nwCall(token, "state=all&limit=2&fresh=1")).json() as { rows: Array<{ sizeOnDisk: number | null }>; total: number };
  const all = await (await nwCall(token, "state=all&limit=200")).json() as { rows: Array<{ sizeOnDisk: number | null }> };
  assert.equal(page1.rows.length, 2);
  const sizes = all.rows.map((r) => r.sizeOnDisk);
  const known = sizes.filter((n): n is number => n !== null);
  assert.deepEqual(known, [...known].sort((a, b) => b - a));
  assert.ok(sizes.indexOf(null) === -1 || sizes.slice(sizes.indexOf(null)).every((n) => n === null), "unknown sizes sort last");
  assert.deepEqual(page1.rows.map((r) => r.sizeOnDisk), sizes.slice(0, 2));
});

// A Sonarr that answers 503 while importing must not keep "could not read
// Sonarr" on the page for the shared listing cache's full five minutes: a
// failed listing (and a report built on one) is kept only briefly, and the
// banner names the reason instead of a bare instance.
test("never-watched report: a failed Sonarr listing names its reason and clears soon after Sonarr recovers", async () => {
  const token = await mintSession();
  listingStatus = (origin) => (origin === SONARR ? 503 : 200);
  const down = await (await nwCall(token, "state=all&fresh=1")).json() as { arrErrors: Array<{ service: string; instance: string; error: string }> };
  // `kind` is what the page translates (C057); `error` stays as the fallback.
  assert.deepEqual(down.arrErrors, [{ service: "sonarr", instance: "", error: "Arr service returned a non-200 response (503)", kind: "unreachable" }]);

  listingStatus = () => 200;
  const realNow = Date.now;
  Date.now = () => realNow() + 31_000;
  try {
    const up = await (await nwCall(token, "state=all")).json() as { arrErrors: unknown[] };
    assert.deepEqual(up.arrErrors, [], "a recovered Sonarr is listed again without waiting out the 5-minute cache");
  } finally {
    Date.now = realNow;
  }
});

// A gateway in front of Sonarr answers 502/503/504 while Sonarr restarts or
// drops a long /series response. The listing retries ONCE on exactly those;
// a status waiting can't fix (a bad key's 401) is never retried.
const seriesListings = () => calls.filter((c) => c.origin === SONARR && c.method === "GET" && c.path === "/api/v3/series").length;

test("listing retry: a transient 502 from Sonarr's gateway is retried once and the listing succeeds", async () => {
  const token = await mintSession();
  let served = 0;
  listingStatus = (origin) => (origin === SONARR && served++ === 0 ? 502 : 200);
  const before = seriesListings();
  const body = await (await nwCall(token, "state=all&fresh=1")).json() as { arrErrors: unknown[] };
  assert.deepEqual(body.arrErrors, [], "the retry's answer is used — no banner for a blip");
  assert.equal(seriesListings() - before, 2);
});

for (const status of [503, 504] as const) {
  test(`listing retry: a persistent ${status} is tried exactly twice, then reported`, async () => {
    const token = await mintSession();
    listingStatus = (origin) => (origin === SONARR ? status : 200);
    const before = seriesListings();
    const body = await (await nwCall(token, "state=all&fresh=1")).json() as { arrErrors: Array<{ service: string; error: string }> };
    assert.equal(seriesListings() - before, 2, "one retry, not a loop");
    assert.deepEqual(body.arrErrors.map((e) => [e.service, e.error]), [["sonarr", `Arr service returned a non-200 response (${status})`]]);
  });
}

test("listing retry: a 401 (bad API key) is not retried — waiting can't fix it", async () => {
  const token = await mintSession();
  listingStatus = (origin) => (origin === SONARR ? 401 : 200);
  const before = seriesListings();
  const body = await (await nwCall(token, "state=all&fresh=1")).json() as { arrErrors: Array<{ error: string }> };
  assert.equal(seriesListings() - before, 1);
  assert.equal(body.arrErrors.length, 1);
});

// ── the read-only caches across an invalidation (guardrails 14d, 19b) ────────
// The shared Radarr/Sonarr index and the never-watched report are both cached,
// and both are dropped by the routes that change what they show. A computation
// that began BEFORE such a change read the old state: it must never be stored,
// and a caller arriving after the change must never join it.

const defaultMovieListings = () => calls.filter((c) => c.origin === RADARR && c.method === "GET" && c.path === "/api/v3/movie").length;
const holdsDefault100 = (index: { byKey: Map<string, Array<{ instance: string }>> }) =>
  (index.byKey.get("MOVIE:100") ?? []).some((e) => e.instance === "");

test("arr index cache: a listing begun before an invalidation is never stored, and a caller after it never joins it", async () => {
  let release!: () => void;
  const gate = new Promise<void>((r) => { release = r; });
  let park = true;
  listingHook = async (origin) => {
    if (origin === RADARR && park) {
      park = false;
      await gate;
    }
  };
  try {
    const before = getCachedArrLibraryIndex();
    assert.ok(await settleUntil(() => defaultMovieListings() === 1), "the first listing reached Radarr and parked");
    // A cleanup delete lands while that listing is in flight: movie 100 leaves
    // the default Radarr, and the route drops the cache.
    radarrMovies[RADARR] = radarrMovies[RADARR].filter((m) => (m as { tmdbId: number }).tmdbId !== 100);
    invalidateArrLibraryIndexCache();

    const after = getCachedArrLibraryIndex();
    const listedAgain = await settleUntil(() => defaultMovieListings() === 2);
    release();
    assert.ok(listedAgain, "the post-invalidation caller lists again instead of joining the parked pre-delete listing");
    assert.equal(holdsDefault100((await after).index), false);
    assert.equal(holdsDefault100((await before).index), true, "the parked caller still gets its own answer");

    const cached = await getCachedArrLibraryIndex();
    assert.equal(defaultMovieListings(), 2, "served from the cache");
    assert.equal(holdsDefault100(cached.index), false, "the pre-delete listing, which finished last, was not stored over the post-delete one");
  } finally {
    release();
  }
});

type NwRow = { kind: string; tmdbId: number; mediaType: string; protected: boolean; eligible: boolean };
const nwRows = async (token: string, query = "state=all&limit=200") =>
  ((await (await nwCall(token, query)).json()) as { rows: NwRow[] }).rows;
const movieRow = (rows: NwRow[], tmdbId: number) => rows.find((r) => r.kind === "title" && r.mediaType === "MOVIE" && r.tmdbId === tmdbId);

test("never-watched report cache: protecting a title drops the cached report (invalidateNeverWatchedReport)", async () => {
  const token = await mintSession();
  const warm = movieRow(await nwRows(token), 100);
  assert.equal(warm?.eligible, true, "movie 100 starts eligible");
  const reads = protectionReads;
  assert.equal(movieRow(await nwRows(token), 100)?.eligible, true);
  assert.equal(protectionReads, reads, "a second read inside the TTL is served from the cache");

  assert.equal((await call(protectRoute.POST as never, token, "/protect", "POST", { ...MOVIE_100, title: "Movie 100" })).status, 201);
  const after = movieRow(await nwRows(token), 100);
  assert.equal(after?.protected, true, "the next (non-fresh) read reflects the protection");
  assert.equal(after?.eligible, false);
});

test("never-watched report cache: a newly recorded play (the activity generation) drops the cached report", async () => {
  const token = await mintSession();
  assert.ok(movieRow(await nwRows(token), 400), "movie 400 starts unwatched");
  // A session finalizes: the play lands and the activity cache is cleared.
  tmdbPlays = [{ tmdbId: 400, mediaType: "MOVIE", n: 1, at: new Date() }];
  clearActivityCache();
  assert.equal(movieRow(await nwRows(token), 400), undefined, "the next (non-fresh) read sees the play — a watched title leaves the report");
});

test("never-watched report cache: a computation that spans an invalidation is never stored (the 19b shape)", async () => {
  const token = await mintSession();
  let release!: () => void;
  protectionsGate = new Promise<void>((r) => { release = r; });
  try {
    const parked = nwRows(token);
    assert.ok(await settleUntil(() => protectionReads === 1), "the computation reached the protection read and parked");
    // An admin protects movie 100 while it is parked (the route's write + invalidation).
    protections.push({ tmdbId: 100, mediaType: "MOVIE", title: "Movie 100", reason: null, createdAt: new Date() });
    invalidateNeverWatchedReport();
    protectionsGate = null;
    release();
    assert.equal(movieRow(await parked, 100)?.protected, false, "the parked computation answered from what it read");
    assert.equal(movieRow(await nwRows(token), 100)?.protected, true, "…but was not stored: the next read recomputes");
  } finally {
    protectionsGate = null;
    release();
  }
});

// ── a show's requests are matched by tmdb id OR tvdb id ──────────────────────
// A TV request carries the tvdbId it was pushed to Sonarr with — its only link
// to the series when TMDB's id for the show and the one the library and Sonarr
// use disagree. Matched on tmdb id alone, an APPROVED one would not hold the
// delete back and the next sync would re-push it (guardrail 14b).

function addShow(tmdbId: number, sonarr: { id: number; tmdbId: number | null; tvdbId: number }) {
  plexLib.push({ tmdbId, mediaType: "TV", serverInstance: "", title: `Show ${tmdbId}`, year: "2019", addedAt: new Date("2024-01-01T00:00:00.000Z") });
  votes.push({ tmdbId, mediaType: "TV", n: 2 });
  sonarrSeries.push({ id: sonarr.id, tmdbId: sonarr.tmdbId, tvdbId: sonarr.tvdbId, title: `Show ${tmdbId}`, status: "ended", statistics: { sizeOnDisk: 600 } });
}

test("an APPROVED request linked to the show only by its Sonarr tvdb id holds the delete back", async () => {
  addShow(600, { id: 61, tmdbId: 600, tvdbId: 6000 });
  requests.push({ id: "r650", tmdbId: 650, tvdbId: 6000, mediaType: "TV", status: "APPROVED", arrInstance: "", availableAt: null, cleanedUpAt: null, approvedAt: new Date("2024-01-15") });
  const token = await mintSession();
  const plan = await (await dryRun(token, { items: [{ tmdbId: 600, mediaType: "TV" }] })).json();
  assert.equal(plan.targetCount, 0);
  assert.match(plan.skipped[0].reason, /Pending or approved request/);
  // The report (a whole-library read) judges it the same way.
  const row = (await (await call(report.GET as never, token, "", "GET")).json()).rows.find((r: { tmdbId: number }) => r.tmdbId === 600);
  assert.deepEqual(row.excludedBy, ["activeRequest"]);
  assert.deepEqual(deletes(), []);
});

test("a tmdb-less Sonarr series (v3) reached through TMDB's cross-reference: its tvdb-linked request holds the delete back too", async () => {
  addShow(700, { id: 71, tmdbId: null, tvdbId: 7000 });
  tmdbToTvdb.set(700, 7000);
  requests.push({ id: "r750", tmdbId: 750, tvdbId: 7000, mediaType: "TV", status: "PENDING", arrInstance: "", availableAt: null, cleanedUpAt: null, approvedAt: null });
  const plan = await (await dryRun(await mintSession(), { items: [{ tmdbId: 700, mediaType: "TV" }] })).json();
  assert.equal(plan.targetCount, 0);
  assert.match(plan.skipped[0].reason, /Pending or approved request/);
  // Without the request the same show is a target — the cross-reference is what found it.
  requests = requests.filter((r) => r.id !== "r750");
  const free = await (await dryRun(await mintSession(), { items: [{ tmdbId: 700, mediaType: "TV" }] })).json();
  assert.equal(free.targetCount, 1);
});

// Audit C121: on Sonarr v3 every series is tvdb-only, so the byKey read never
// sees its status. With TMDB's details row missing (a cleared cache, a failed
// fetch) the airing exclusion stayed unknown and a continuing series was a
// candidate — while the delete itself found its Sonarr entry through TMDB's
// cross-reference. The airing pass reaches it the same way.
test("C121: a tvdb-only (Sonarr v3) continuing series with no TMDB details row is held back as still airing — dry run and report agree", async () => {
  sonarrSeries = [{ id: 31, tvdbId: 3000, title: "Show 300", status: "continuing", statistics: { sizeOnDisk: 700 } }];
  tmdbToTvdb.set(300, 3000);
  const token = await mintSession();
  const plan = await (await dryRun(token, { items: [SHOW_300] })).json() as { targetCount: number; skipped: Array<{ tmdbId: number; reason: string }> };
  assert.equal(plan.targetCount, 0, `Sonarr says continuing: ${JSON.stringify(plan.skipped)}`);
  assert.match(plan.skipped[0].reason, /Still airing/);

  const nw = await (await nwCall(token, "state=all&limit=200&fresh=1")).json() as { rows: Array<{ tmdbId: number; mediaType: string; eligible: boolean; cleanup: { excludedBy: string[] } }> };
  const row = nw.rows.find((r) => r.tmdbId === 300 && r.mediaType === "TV")!;
  assert.ok(row.cleanup.excludedBy.includes("airing"), "the report reads the same status");
  assert.equal(row.eligible, false);

  // Sonarr saying "ended" releases it (the status is Sonarr's, not a guess).
  sonarrSeries = [{ id: 31, tvdbId: 3000, title: "Show 300", status: "ended", statistics: { sizeOnDisk: 700 } }];
  const ended = await (await dryRun(token, { items: [SHOW_300] })).json() as { targetCount: number };
  assert.equal(ended.targetCount, 1);
});

test("execute stamps an AVAILABLE request linked to the show only by its tvdb id", async () => {
  addShow(600, { id: 61, tmdbId: 600, tvdbId: 6000 });
  requests.push({ id: "r650", tmdbId: 650, tvdbId: 6000, mediaType: "TV", status: "AVAILABLE", arrInstance: "", availableAt: new Date("2024-02-01"), cleanedUpAt: null, approvedAt: new Date("2024-01-15") });
  // An unrelated show's request on the same tvdb id space is never touched.
  requests.push({ id: "r-other", tmdbId: 651, tvdbId: 6001, mediaType: "TV", status: "AVAILABLE", arrInstance: "", availableAt: new Date("2024-02-01"), cleanedUpAt: null, approvedAt: null });
  const res = await execute(await mintSession(), { items: [{ tmdbId: 600, mediaType: "TV" }], confirmTargets: 1 });
  assert.equal((await res.json()).deletedCount, 1);
  assert.ok(requests.find((r) => r.id === "r650")!.cleanedUpAt instanceof Date, "the sync's demote will skip it");
  assert.equal(requests.find((r) => r.id === "r-other")!.cleanedUpAt, null);
});

// Audit C132: the loader-to-rule wiring of the guardrail-14d upstream hold-back,
// end to end through the real dry run. Every fixture above uses the votes rule,
// which is EXEMPT from the hold-back, so deleting the loader's `upstreamUnchecked`
// computation left the whole suite green.
test("a never-watched candidate whose holder's own watch records were never checked is HELD BACK by the dry run; a fresh ok check releases it", async () => {
  const { processSingleton } = await import("../src/lib/process-singleton.ts");
  // The per-server first-play read is cached process-wide (5 min): start cold.
  const firstPlayCache = processSingleton("never-watched:first-play", () => ({ value: null as unknown, at: 0, generation: -1 }));
  firstPlayCache.value = null;
  firstPlays = [{ source: "plex", serverInstance: "", _min: { startedAt: new Date("2025-01-01T00:00:00.000Z") } }];
  settings.set("cleanupVotesEnabled", "false");
  settings.set("cleanupNeverWatchedEnabled", "true");
  settings.set("cleanupNeverWatchedDays", "0");
  const token = await mintSession();

  const held = await (await dryRun(token, { items: [MOVIE_100] })).json();
  assert.equal(held.targetCount, 0, `held back while plex's records are unchecked: ${JSON.stringify(held.skipped)}`);
  assert.equal(held.skipped.length, 1);
  // The upstreamUnchecked exclusion's label — not "no rule matches" (which is
  // what an unobservable or watched verdict would read).
  assert.match(String(held.skipped[0].reason), /^Held back: Server history not checked/, `the reason must be the upstream check: ${held.skipped[0].reason}`);

  settings.set("upstreamWatch:status:plex:", JSON.stringify({
    fetchedAt: new Date().toISOString(), attemptedAt: new Date().toISOString(), ok: true,
    entries: 10, matched: 10, samples: 0, agreed: 0, error: null,
  }));
  invalidateNeverWatchedReport();
  const released = await (await dryRun(token, { items: [MOVIE_100] })).json();
  assert.equal(released.targetCount, 2, `a fresh ok check releases it (Radarr default + 4K): ${JSON.stringify(released.skipped)}`);

  // C159: the same fresh check, but the read stopped at its cap — the oldest
  // records (the pre-install views) were never read, so it holds again.
  settings.set("upstreamWatch:status:plex:", JSON.stringify({
    fetchedAt: new Date().toISOString(), attemptedAt: new Date().toISOString(), ok: true,
    entries: 10, matched: 10, samples: 0, agreed: 0, error: null, truncated: true,
  }));
  invalidateNeverWatchedReport();
  const truncated = await (await dryRun(token, { items: [MOVIE_100] })).json();
  assert.equal(truncated.targetCount, 0, "a truncated read is never a check");
  assert.match(String(truncated.skipped[0].reason), /^Held back: Server history not checked/);
  firstPlayCache.value = null;
});

// Audit C136: the detail-page chip judged the title without the Radarr/Sonarr
// index, while the report passes it — and the index feeds the verdict: a
// fulfilled request's delivery counts as the arrival only while its instance
// hasn't re-added the title since. The chip now reads the shared index when it
// is already in memory, and never lists an arr itself.
test("C136: the detail chip's window matches the report's once the shared index is warm, and a cold chip lists no arr", async () => {
  const { processSingleton } = await import("../src/lib/process-singleton.ts");
  const firstPlayCache = processSingleton("never-watched:first-play", () => ({ value: null as unknown, at: 0, generation: -1 }));
  firstPlayCache.value = null;
  firstPlays = [{ source: "plex", serverInstance: "", _min: { startedAt: new Date("2025-01-01T00:00:00.000Z") } }];
  // Plex re-added it in June; the request was delivered in March, by a copy
  // Radarr's default instance has since replaced (re-added in May).
  plexLib.find((r) => r.tmdbId === 100)!.addedAt = new Date("2025-06-01T00:00:00.000Z");
  fulfilledRows = [{ tmdbId: 100, mediaType: "MOVIE", arrInstance: "", cleanedUpAt: null, _min: { availableAt: new Date("2025-03-01T00:00:00.000Z") } }];
  radarrMovies[RADARR] = radarrMovies[RADARR].map((m) => ((m as { id: number }).id === 11 ? { ...(m as object), added: "2025-05-01T00:00:00Z" } : m));
  try {
    const token = await mintSession();
    const body = await (await nwCall(token, "state=all&limit=200&fresh=1")).json() as { rows: Array<{ tmdbId: number; mediaType: string; windowStart: string | null }> };
    const row = body.rows.find((r) => r.tmdbId === 100 && r.mediaType === "MOVIE")!;
    assert.equal(row.windowStart, "2025-06-01T00:00:00.000Z", "the report drops the replaced copy's delivery");
    const warm = await getTitleNeverWatched(100, "MOVIE");
    assert.equal(warm?.windowStart, row.windowStart, "the chip reads the same arrival as the report");

    invalidateArrLibraryIndexCache();
    const listingsBefore = calls.filter((c) => c.method === "GET").length;
    const cold = await getTitleNeverWatched(100, "MOVIE");
    assert.ok(cold, "a cold chip still answers");
    assert.equal(calls.filter((c) => c.method === "GET").length, listingsBefore, "a page render never lists Radarr/Sonarr");
  } finally {
    firstPlayCache.value = null;
  }
});
