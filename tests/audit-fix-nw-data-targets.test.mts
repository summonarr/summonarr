// Audit fixes C122 + C078 (wave B2, nw-data): the never-watched report's "eligible",
// sizes and season sizes — and the cleanup page's rows — use the delete route's
// OWN targets (resolveArrTargets: a Sonarr series listed only by tvdb id is
// reached through TMDB's cross-reference) and its own failed-instance rule
// (failedArrInstances), so "eligible" is exactly the dry run's selection
// (guardrail 14d). Harness: a copy of tests/library-cleanup-routes.test.mts's
// (real withAdmin handlers in a synthetic request scope, in-memory prisma,
// Radarr/Sonarr scripted on RFC1918 literals). No DB, no network.
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
    return Response.json(radarrMovies[url.origin] ?? []);
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
};
const reqMatch = (r: Req, w: ReqWhere = {}): boolean =>
  (!w.id || w.id.in.includes(r.id)) &&
  (w.tmdbId === undefined || (typeof w.tmdbId === "number" ? r.tmdbId === w.tmdbId : w.tmdbId.in.includes(r.tmdbId))) &&
  (w.tvdbId === undefined || (r.tvdbId != null && w.tvdbId.in.includes(r.tvdbId))) &&
  (w.OR === undefined || w.OR.some((o) => reqMatch(r, o))) &&
  (w.mediaType === undefined || r.mediaType === w.mediaType) &&
  (w.status === undefined || (typeof w.status === "string" ? r.status === w.status : w.status.in.includes(r.status))) &&
  (w.cleanedUpAt === undefined || (w.cleanedUpAt === null ? r.cleanedUpAt === null : r.cleanedUpAt?.getTime() === w.cleanedUpAt.getTime()));
const requestWrites: Array<{ where: ReqWhere; data: Record<string, unknown> }> = [];
shadowPrismaModel(prisma, "mediaRequest", {
  findMany: async (args: { where?: ReqWhere }) => requests.filter((r) => reqMatch(r, args.where)).map((r) => ({ ...r })),
  // The never-watched loader's "fulfilled since" read (an arrival date).
  groupBy: async () => [],
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
shadowPrismaModel(prisma, "cleanupProtection", {
  findMany: async (args: { where?: { tmdbId?: { in?: number[] } } }) => {
    return protections.filter((p) => inIds(args.where, p.tmdbId));
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
let audits: Array<{ action: string; target: string; details: Record<string, unknown> }> = [];
shadowPrismaModel(prisma, "auditLog", {
  create: async (args: { data: { action: string; target: string; details: string | null } }) => {
    seq.push(`audit ${args.data.action} ${args.data.target}`);
    audits.push({ action: args.data.action, target: args.data.target, details: args.data.details ? JSON.parse(args.data.details) : {} });
    return { id: "audit" };
  },
});
shadowPrismaClientMethod(prisma, "$transaction", async (arg: unknown) => {
  if (Array.isArray(arg)) return Promise.all(arg);
  throw new Error("interactive transaction not expected in cleanup routes");
});

const report = await import("../src/app/api/admin/cleanup/route.ts");
const deleteRoute = await import("../src/app/api/admin/cleanup/delete/route.ts");
const neverWatchedRoute = await import("../src/app/api/admin/never-watched/route.ts");
// The listing's 502/503/504 retry pauses 2 s in production; no test should wait.
const { _setArrListingRetryDelayForTests, invalidateArrLibraryIndexCache } = await import("../src/lib/library-cleanup-arr.ts");
_setArrListingRetryDelayForTests(0);
const { invalidateNeverWatchedReport } = await import("../src/lib/never-watched-report.ts");


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
  deleteStatus = () => 200;
  listingStatus = () => 200;
  tmdbPlays = [];
  firstPlays = [];
  tmdbToTvdb = new Map();
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

const SHOW_300 = { tmdbId: 300, mediaType: "TV" };
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

const SONARR_4K = "http://10.0.0.8:8989";
const { failedArrInstances } = await import("../src/lib/library-cleanup-arr.ts");

type NwRow = {
  kind: string; tmdbId: number; mediaType: "MOVIE" | "TV"; eligible: boolean; sizeOnDisk: number | null;
  arr: Array<{ service: string; instance: string; sizeOnDisk: number }>; cleanup: { excludedBy: string[] };
};
type CleanupGetRow = { tmdbId: number; mediaType: string; arr: Array<{ service: string; instance: string; sizeOnDisk: number }>; sizeOnDisk: number | null; excludedBy: string[]; candidate: boolean };

// The pinned 14d equality: the report's eligible rows are exactly what the dry
// run plans for every row the report lists.
async function assertEligibleIsDryRun(token: string): Promise<NwRow[]> {
  const body = await (await nwCall(token, "state=all&limit=200&fresh=1")).json() as { rows: NwRow[] };
  const eligible = body.rows.filter((r) => r.eligible).map((r) => `${r.mediaType}:${r.tmdbId}`).sort();
  const plan = await (await dryRun(token, { items: body.rows.map((r) => ({ tmdbId: r.tmdbId, mediaType: r.mediaType })) })).json() as { items: Array<{ tmdbId: number; mediaType: string }> };
  assert.deepEqual(plan.items.map((i) => `${i.mediaType}:${i.tmdbId}`).sort(), eligible, "report eligible === dry run selection");
  return body.rows;
}

function addTvdbOnlyShow(tmdbId: number, tvdbId: number, size: number) {
  plexLib.push({ tmdbId, mediaType: "TV", serverInstance: "", title: `Show ${tmdbId}`, year: "2019", addedAt: new Date("2024-01-01T00:00:00.000Z") });
  votes.push({ tmdbId, mediaType: "TV", n: 2 });
  // Sonarr v3: no tmdbId on the resource — reachable only through TMDB's tvdb id.
  sonarrSeries.push({ id: tmdbId + 1, tvdbId, title: `Show ${tmdbId}`, status: "ended", statistics: { sizeOnDisk: size } });
  tmdbToTvdb.set(tmdbId, tvdbId);
}

test("C122: a Sonarr series listed only by tvdb id is sized and ELIGIBLE on the report, exactly as the dry run plans it", async () => {
  addTvdbOnlyShow(320, 3200, 650);
  const token = await mintSession();
  const rows = await assertEligibleIsDryRun(token);
  const row = rows.find((r) => r.tmdbId === 320)!;
  assert.equal(row.eligible, true);
  assert.equal(row.sizeOnDisk, 650);
  assert.deepEqual(row.arr, [{ service: "sonarr", instance: "", sizeOnDisk: 650 }]);
  // The cleanup page offers the same copy (its Deletable-only toggle reads it).
  const page = await (await call(report.GET as never, token, "", "GET")).json() as { rows: CleanupGetRow[]; totals: { reclaimableBytes: number } };
  const pageRow = page.rows.find((r) => r.tmdbId === 320)!;
  assert.equal(pageRow.sizeOnDisk, 650);
  assert.deepEqual(pageRow.arr, [{ service: "sonarr", instance: "", sizeOnDisk: 650 }]);
  assert.deepEqual(deletes(), []);
});

test("C122: a tvdb-only show whose request is linked ONLY by that tvdb id is held back on the report AND the cleanup page, as in the dry run", async () => {
  addTvdbOnlyShow(330, 3300, 640);
  requests.push({ id: "r335", tmdbId: 335, tvdbId: 3300, mediaType: "TV", status: "PENDING", arrInstance: "", availableAt: null, cleanedUpAt: null, approvedAt: null });
  const token = await mintSession();
  const rows = await assertEligibleIsDryRun(token);
  const row = rows.find((r) => r.tmdbId === 330)!;
  assert.equal(row.eligible, false);
  assert.deepEqual(row.cleanup.excludedBy, ["activeRequest"]);
  assert.equal(row.sizeOnDisk, 640, "still sized — it is in Sonarr");
  const page = await (await call(report.GET as never, token, "", "GET")).json() as { rows: CleanupGetRow[] };
  const pageRow = page.rows.find((r) => r.tmdbId === 330)!;
  assert.deepEqual(pageRow.excludedBy, ["activeRequest"], "the page re-judges with the resolved tvdb id, like the dry run");
  assert.equal(pageRow.candidate, false);
  assert.equal(pageRow.sizeOnDisk, 640);
});

test("C122: a second Sonarr instance that can't be listed makes NO show eligible on the report, and the dry run refuses naming it", async () => {
  settings.set("sonarr4kUrl", SONARR_4K);
  settings.set("sonarr4kApiKey", "sonarr4k-key");
  listingStatus = (origin) => (origin === SONARR_4K ? 503 : 200);
  const token = await mintSession();
  const rows = await assertEligibleIsDryRun(token);
  assert.ok(rows.some((r) => r.tmdbId === 300 && r.sizeOnDisk === 700), "the healthy instance's copy is still sized");
  assert.deepEqual(rows.filter((r) => r.mediaType === "TV" && r.eligible), []);
  assert.ok(rows.some((r) => r.mediaType === "MOVIE" && r.eligible), "Radarr titles are unaffected");
  const plan = await (await dryRun(token, { items: [SHOW_300] })).json() as { targetCount: number; skipped: Array<{ reason: string }> };
  assert.equal(plan.targetCount, 0);
  assert.match(plan.skipped[0].reason, /Sonarr/);
  assert.match(plan.skipped[0].reason, /4k/);
});

test("C122: failedArrInstances names each failed instance of the title's own service, the unnamed one as 'default'", () => {
  const errors = [
    { service: "sonarr" as const, instance: "", error: "x" },
    { service: "sonarr" as const, instance: "anime", error: "y" },
    { service: "radarr" as const, instance: "4k", error: "z" },
  ];
  assert.deepEqual(failedArrInstances({ errors }, "TV"), ["default", "anime"]);
  assert.deepEqual(failedArrInstances({ errors }, "MOVIE"), ["4k"]);
  assert.deepEqual(failedArrInstances({ errors: [] }, "MOVIE"), []);
});

test("C078: the uncached cleanup report GET is rate-limited per admin (30 a minute), then 429", async () => {
  const token = await mintSession();
  for (let i = 0; i < 30; i++) assert.equal((await call(report.GET as never, token, "", "GET")).status, 200, `load ${i + 1}`);
  assert.equal((await call(report.GET as never, token, "", "GET")).status, 429);
  // Another admin has their own budget.
  assert.equal((await call(report.GET as never, await mintSession(), "", "GET")).status, 200);
});
