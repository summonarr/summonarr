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
//   6. NO RE-DOWNLOAD. Every AVAILABLE request for the title is stamped
//      cleanedUpAt BEFORE the first delete (and un-stamped if nothing was
//      deleted); the sync's demote skips stamped rows — that half is pinned in
//      tests/sync-orchestrator-route.test.mts. approvedAt and status are never
//      written.
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
  if (url.pathname === "/api/v3/movie") return Response.json(radarrMovies[url.origin] ?? []);
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
shadowPrismaModel(prisma, "playHistory", {
  groupBy: async () => [],
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
type Req = { id: string; tmdbId: number; mediaType: string; status: string; arrInstance: string; availableAt: Date | null; cleanedUpAt: Date | null; approvedAt: Date | null };
let requests: Req[] = [];
type ReqWhere = { id?: { in: string[] }; tmdbId?: number | { in: number[] }; mediaType?: string; status?: string | { in: string[] }; cleanedUpAt?: null | Date };
const reqMatch = (r: Req, w: ReqWhere = {}) =>
  (!w.id || w.id.in.includes(r.id)) &&
  (w.tmdbId === undefined || (typeof w.tmdbId === "number" ? r.tmdbId === w.tmdbId : w.tmdbId.in.includes(r.tmdbId))) &&
  (w.mediaType === undefined || r.mediaType === w.mediaType) &&
  (w.status === undefined || (typeof w.status === "string" ? r.status === w.status : w.status.in.includes(r.status))) &&
  (w.cleanedUpAt === undefined || (w.cleanedUpAt === null ? r.cleanedUpAt === null : r.cleanedUpAt?.getTime() === w.cleanedUpAt.getTime()));
const requestWrites: Array<{ where: ReqWhere; data: Record<string, unknown> }> = [];
shadowPrismaModel(prisma, "mediaRequest", {
  findMany: async (args: { where?: ReqWhere }) => requests.filter((r) => reqMatch(r, args.where)).map((r) => ({ ...r })),
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
let protections: Array<{ tmdbId: number; mediaType: string; title: string | null; reason: string | null; createdAt: Date }> = [];
shadowPrismaModel(prisma, "cleanupProtection", {
  findMany: async (args: { where?: { tmdbId?: { in?: number[] } } }) => protections.filter((p) => inIds(args.where, p.tmdbId)),
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
shadowPrismaModel(prisma, "tmdbCache", { findMany: async () => [] });
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
  settings.clear();
  for (const [k, v] of Object.entries({
    "feature.admin.cleanup": "true",
    playHistoryEnabled: "true",
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
