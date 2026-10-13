// C015 (audit fix, unit "release"): a Library cleanup delete whose OUTCOME IS
// UNKNOWN — a timeout, a dropped connection, a gateway's 502/504 — keeps the
// guardrail-14b `cleanedUpAt` stamps. The arr may have taken the delete (its
// handlers take no abort token), and an unstamp on a deleted title lets the
// sync demote and re-push it: the cleanup would re-download what it removed.
// A definite refusal (the arr's own 500, a 503 nothing behind the proxy took)
// still removes the stamps this call wrote — tests/library-cleanup-routes.test.mts
// pins that half.
//
// Harness: copied from tests/library-cleanup-routes.test.mts, with a DELETE
// that can throw instead of answering.
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
// A DELETE that never gets an answer: the request went out, the arr may have acted.
let deleteThrows: (origin: string, path: string) => Error | null = () => null;
let listingStatus: (origin: string) => number = () => 200;
// Runs before a listing answers — lets a test park one listing mid-flight.
let listingHook: ((origin: string, path: string) => Promise<void>) | null = null;

globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
  const url = new URL(String(input));
  const method = init?.method ?? "GET";
  calls.push({ origin: url.origin, method, path: url.pathname, query: url.search });
  if (method === "DELETE") {
    seq.push(`delete ${url.origin}${url.pathname}`);
    const thrown = deleteThrows(url.origin, url.pathname);
    if (thrown) throw thrown;
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
shadowPrismaModel(prisma, "playHistory", {
  groupBy: async (args: { by: string[] }) =>
    args.by.join(",") === "tmdbId,mediaType"
      ? tmdbPlays.map((p) => ({ tmdbId: p.tmdbId, mediaType: p.mediaType, _count: { _all: p.n }, _max: { startedAt: p.at } }))
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
// When set, a protection read answers with what it saw on arrival, but only
// once the gate opens — a computation parked mid-flight.
let protectionsGate: Promise<void> | null = null;
let _protectionReads = 0;
shadowPrismaModel(prisma, "cleanupProtection", {
  findMany: async (args: { where?: { tmdbId?: { in?: number[] } } }) => {
    _protectionReads++;
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

const deleteRoute = await import("../src/app/api/admin/cleanup/delete/route.ts");
// The listing's 502/503/504 retry pauses 2 s in production; no test should wait.
const { _setArrListingRetryDelayForTests, getCachedArrLibraryIndex, invalidateArrLibraryIndexCache } = await import("../src/lib/library-cleanup-arr.ts");
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
const execute = (token: string | null, body: unknown) => call(deleteRoute.POST as never, token, "/delete?execute=true", "POST", body);


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
  deleteThrows = () => null;
  listingStatus = () => 200;
  listingHook = null;
  protectionsGate = null;
  _protectionReads = 0;
  tmdbPlays = [];
  tmdbToTvdb = new Map();
  // Both read-only caches are process-wide; every test starts from a cold one.
  invalidateArrLibraryIndexCache();
  invalidateNeverWatchedReport();
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

const timeoutError = () => Object.assign(new Error("The operation was aborted due to timeout"), { name: "TimeoutError" });
const r100 = (id: "r100a" | "r100b") => requests.find((r) => r.id === id)!;

test("C015: every DELETE times out ⇒ failed + uncertain, and the stamps STAY — the arr may have deleted it (14b)", async () => {
  deleteThrows = () => timeoutError();
  const res = await execute(await mintSession(), { items: [MOVIE_100], confirmTargets: 2 });
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.failedCount, 1);
  assert.equal(body.results[0].status, "failed");
  assert.equal(body.results[0].uncertain, true);
  assert.ok(r100("r100a").cleanedUpAt instanceof Date, "an unstamp would let the sync re-push a title the arr removed");
  assert.ok(r100("r100b").cleanedUpAt instanceof Date);
  assert.equal(audits.length, 0, "nothing is KNOWN to have been deleted, so nothing is audited");
});

test("C015: a gateway's 504 on every DELETE is an unknown outcome too — the stamps stay", async () => {
  deleteStatus = () => 504;
  const body = await (await execute(await mintSession(), { items: [MOVIE_100], confirmTargets: 2 })).json();
  assert.equal(body.results[0].status, "failed");
  assert.equal(body.results[0].uncertain, true);
  assert.ok(r100("r100a").cleanedUpAt instanceof Date);
  assert.ok(r100("r100b").cleanedUpAt instanceof Date);
});

test("C015: a dropped connection on one instance of a partial delete keeps THAT instance's stamp (only a refusal unstamps)", async () => {
  deleteThrows = (origin) => (origin === RADARR_4K ? new TypeError("fetch failed") : null);
  const body = await (await execute(await mintSession(), { items: [MOVIE_100], confirmTargets: 2 })).json();
  assert.equal(body.results[0].status, "partial");
  assert.equal(body.results[0].uncertain, true);
  assert.ok(r100("r100a").cleanedUpAt instanceof Date, "the default copy is gone");
  assert.ok(r100("r100b").cleanedUpAt instanceof Date, "the 4K delete may have gone through as well");
  assert.equal(audits[0].details.uncertain, true, "the audit says one target's outcome is unknown");
  assert.equal(audits[0].details.requestsStamped, 2);
});

test("C015: one instance refuses (503) and the other times out — only the refusing instance's requests are unstamped", async () => {
  deleteStatus = (origin) => (origin === RADARR ? 503 : 200);
  deleteThrows = (origin) => (origin === RADARR_4K ? timeoutError() : null);
  const body = await (await execute(await mintSession(), { items: [MOVIE_100], confirmTargets: 2 })).json();
  assert.equal(body.results[0].status, "failed");
  assert.equal(body.results[0].uncertain, true);
  assert.equal(r100("r100a").cleanedUpAt, null, "the default instance refused — it still holds the title");
  assert.ok(r100("r100b").cleanedUpAt instanceof Date, "4K's outcome is unknown — keep its stamp");
});

test("C015 control: a definite refusal everywhere (503) still removes the stamps this call wrote, with no `uncertain`", async () => {
  deleteStatus = () => 503;
  const body = await (await execute(await mintSession(), { items: [MOVIE_100], confirmTargets: 2 })).json();
  assert.equal(body.results[0].status, "failed");
  assert.equal("uncertain" in body.results[0], false);
  assert.equal(r100("r100a").cleanedUpAt, null);
  assert.equal(r100("r100b").cleanedUpAt, null);
});

test("C015: a definite 500 on one instance still unstamps that instance's requests (the partial rule is unchanged)", async () => {
  deleteStatus = (origin) => (origin === RADARR_4K ? 500 : 200);
  const body = await (await execute(await mintSession(), { items: [MOVIE_100], confirmTargets: 2 })).json();
  assert.equal(body.results[0].status, "partial");
  assert.equal("uncertain" in body.results[0], false);
  assert.equal(r100("r100b").cleanedUpAt, null);
});

test("C015: an uncertain-only run still drops the cached Radarr/Sonarr listing — the title may be gone", async () => {
  const listings = () => calls.filter((c) => c.method === "GET" && c.origin === RADARR && c.path === "/api/v3/movie").length;
  await getCachedArrLibraryIndex(); // warm the read-only views' cache
  deleteThrows = () => timeoutError();
  await execute(await mintSession(), { items: [MOVIE_100], confirmTargets: 2 });
  const before = listings();
  await getCachedArrLibraryIndex();
  assert.equal(listings(), before + 1, "listed again — the cached listing may still show a deleted title");
});
