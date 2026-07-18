// Route-level unit tests for the two admin observability dumps:
//   GET /api/admin/debug/arr-state?tmdbId=&type=movie|tv
//   GET /api/admin/debug/ratings-state?tmdbId=&type=movie|tv[&live=1]
//
// These endpoints are documented in CLAUDE.md's "Observability" paragraph.
// arr-state "dumps the whole pipeline: cache rows, attachArrPending result, live
// Radarr/Sonarr check, tvdb→tmdb mapping, total wanted-table counts, and the most
// recent LIBRARY_SYNC audit row." ratings-state dumps "provider-configured flags,
// MDBList/OMDB quota-lockout state, raw ratings cache rows (stale/sentinel), the
// details-cache rating fields (absent = never fetched, null = authoritative none),
// plus an opt-in live probe through fetchUnifiedRatings."
//
// Both routes are thin assemblers that DELEGATE to lib functions owned by sibling
// suites — this file pins the ROUTE contract (auth, validation, opt-in-live
// gating, read-only-ness, response-shape assembly), NOT the delegates' internals:
//   - withAdmin gating (401 unauth / 403 non-admin, body never runs) is owned by
//     tests/api-auth.test.mts — here we only pin that BOTH routes wear it and that
//     ADMIN-only means ISSUE_ADMIN is rejected too;
//   - attachArrPending's wanted/available badge derivation is owned by
//     tests/arr-availability.test.mts — here we pin only that the route surfaces
//     its boolean (attachArrPendingReturns), cache-derived, independent of a live
//     Arr result that can legitimately disagree with it;
//   - the OMDB/MDBList quota-lockout + single-item ratings pipeline is owned by
//     tests/omdb-quota.test.mts / tests/omdb.test.mts / tests/mdblist.test.mts —
//     here we pin the lockout flags are surfaced and that fetchUnifiedRatings is
//     the OPT-IN live probe (zero provider fetches without &live=1);
//   - tmdb-cache row lifecycle (getCache) is owned by tests/tmdb-cache.test.mts.
//
// The headline ratings-state pins: the live probe is OPT-IN (no fetchUnifiedRatings
// / zero provider fetches without &live=1) and the non-live path is READ-ONLY
// (zero writes to any model). arr-state is likewise read-only (GET-only arrFetch,
// no cache writes on the movie path).
//
// No DB, network, or DNS: the prisma model delegates are shadowed in-memory
// (tests/_helpers.mts), the JWTs are REAL jose tokens over stubbed authSession/user
// rows (tests/api-auth.test.mts idiom), globalThis.fetch is a recording script,
// and dns/promises.lookup is stubbed so safe-fetch's SSRF resolver never issues a
// real lookup for the (scripted) Arr host / api.mdblist.com. TOKEN_ENCRYPTION_KEY
// and the session-JWT secret are set BEFORE the module graph loads (dynamic
// imports below would otherwise hoist above them).
import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import dns from "node:dns/promises";

process.env.TOKEN_ENCRYPTION_KEY = "ab".repeat(32); // prisma.ts pulls in token-crypto
process.env.NEXTAUTH_SECRET = "debug-routes-test-secret-0123456789abcdef"; // session JWT sign/verify
process.env.AUTH_URL = "http://localhost:3000"; // insecure context → unprefixed cookie name
process.env.TRUST_PROXY = "true"; // silence rate-limit's module-load warning
process.env.TMDB_READ_TOKEN = "debug-routes-test-tmdb-token"; // warn-only otherwise; unused by the pinned paths

// ── DNS stub (tests/omdb-quota.test.mts rationale) — safe-fetch resolves the Arr
// host (safeFetchAdminConfigured) and api.mdblist.com (safeFetchTrusted) before
// fetching; a fixed public address keeps every lookup off the network. Guarded
// like the prisma shadow so a non-writable core module fails loudly, not by hang.
const fakeLookup = async () => [{ address: "93.184.216.34", family: 4 }];
(dns as { lookup: unknown }).lookup = fakeLookup;
if ((dns as { lookup: unknown }).lookup !== fakeLookup) {
  throw new Error("could not stub dns.lookup — aborting before a real DNS query can leave the process");
}

// ── console capture ─────────────────────────────────────────────────────────
const warns: string[] = [];
const errors: string[] = [];
console.warn = (...args: unknown[]) => { warns.push(args.map(String).join(" ")); };
console.error = (...args: unknown[]) => { errors.push(args.map(String).join(" ")); };

// ── recording fetch: every wire attempt logged; unscripted fetches throw ─────
const fetchCalls: URL[] = [];
let fetchImpl: (url: URL) => Response | Promise<Response> = () => {
  throw new Error("unexpected fetch — this test must satisfy its flow from stubs, or script fetchImpl");
};
globalThis.fetch = (async (input: RequestInfo | URL) => {
  const url = new URL(String(input));
  fetchCalls.push(url);
  return fetchImpl(url);
}) as typeof fetch;

// Dynamic imports so the env/global stubs above genuinely precede the module-graph
// load (static imports would hoist above them).
const { NextRequest } = await import("next/server");
const { prisma } = await import("../src/lib/prisma.ts");
const { shadowPrismaModel, shadowPrismaClientMethod } = await import("./_helpers.mts");
const { signSessionJwt } = await import("../src/lib/session-jwt.ts");
const { getSessionCookieName } = await import("../src/lib/session-cookie.ts");

type Req = InstanceType<typeof NextRequest>;

// ── write / read tracking (the read-only + body-not-invoked pins) ────────────
// Business-model reads push to readLog; business-model writes push to writes. The
// AUTH models (authSession/user) are tracked separately below and never touch
// these arrays — so a 401/403 with an empty readLog proves the ROUTE BODY never
// ran, and a successful non-live run with an empty `writes` proves read-only.
const readLog: string[] = [];
const writes: string[] = [];
function writeRecorders(model: string): Record<string, () => Promise<unknown>> {
  return {
    create: async () => { writes.push(`${model}.create`); return {}; },
    createMany: async () => { writes.push(`${model}.createMany`); return { count: 0 }; },
    update: async () => { writes.push(`${model}.update`); return {}; },
    updateMany: async () => { writes.push(`${model}.updateMany`); return { count: 0 }; },
    upsert: async () => { writes.push(`${model}.upsert`); return {}; },
    delete: async () => { writes.push(`${model}.delete`); return {}; },
    deleteMany: async () => { writes.push(`${model}.deleteMany`); return { count: 0 }; },
  };
}

// ── Radarr/Sonarr wanted/available cache tables ──────────────────────────────
// findUnique keys on { tmdbId_arrInstance }, findMany on { tmdbId: { in } } (the
// attachArrPending shape), count() is unfiltered (wantedTableTotals).
type ArrRow = { tmdbId: number; arrInstance: string };
function makeArrTable(model: string) {
  const rows: ArrRow[] = [];
  const stub = {
    ...writeRecorders(model),
    findUnique: async (args: { where: { tmdbId_arrInstance: { tmdbId: number; arrInstance: string } } }) => {
      readLog.push(`${model}.findUnique`);
      const { tmdbId, arrInstance } = args.where.tmdbId_arrInstance;
      return rows.find((r) => r.tmdbId === tmdbId && r.arrInstance === arrInstance) ?? null;
    },
    findMany: async (args: { where: { tmdbId: { in: number[] } } }) => {
      readLog.push(`${model}.findMany`);
      return rows
        .filter((r) => args.where.tmdbId.in.includes(r.tmdbId))
        .map((r) => ({ tmdbId: r.tmdbId, arrInstance: r.arrInstance }));
    },
    count: async () => { readLog.push(`${model}.count`); return rows.length; },
  };
  return { rows, stub };
}
const radarrWanted = makeArrTable("radarrWantedItem");
const sonarrWanted = makeArrTable("sonarrWantedItem");
const radarrAvail = makeArrTable("radarrAvailableItem");
const sonarrAvail = makeArrTable("sonarrAvailableItem");
shadowPrismaModel(prisma, "radarrWantedItem", radarrWanted.stub);
shadowPrismaModel(prisma, "sonarrWantedItem", sonarrWanted.stub);
shadowPrismaModel(prisma, "radarrAvailableItem", radarrAvail.stub);
shadowPrismaModel(prisma, "sonarrAvailableItem", sonarrAvail.stub);

// ── mediaRequest / auditLog ──────────────────────────────────────────────────
let mediaRequestRows: Array<Record<string, unknown>> = [];
shadowPrismaModel(prisma, "mediaRequest", {
  ...writeRecorders("mediaRequest"),
  findMany: async () => { readLog.push("mediaRequest.findMany"); return mediaRequestRows; },
});
let auditRow: { createdAt: Date; details: string | null } | null = null;
shadowPrismaModel(prisma, "auditLog", {
  ...writeRecorders("auditLog"),
  findFirst: async () => { readLog.push("auditLog.findFirst"); return auditRow; },
});

// ── Setting (Arr config + registry + ratings provider keys) ──────────────────
const settings = new Map<string, string>();
shadowPrismaModel(prisma, "setting", {
  upsert: async () => { writes.push("setting.upsert"); return {}; },
  findUnique: async (args: { where: { key: string } }) => {
    readLog.push("setting.findUnique");
    const v = settings.get(args.where.key);
    return v === undefined ? null : { key: args.where.key, value: v };
  },
  findMany: async (args: { where: { key: { in: string[] } } }) => {
    readLog.push("setting.findMany");
    return args.where.key.in.filter((k) => settings.has(k)).map((k) => ({ key: k, value: settings.get(k) as string }));
  },
});

// ── TmdbCache (getCache tvdb mapping on the tv path; raw ratings/details rows) ─
type CacheRow = { key: string; data: string; cachedAt: Date; expiresAt: Date };
const cache = new Map<string, CacheRow>();
shadowPrismaModel(prisma, "tmdbCache", {
  findUnique: async (args: { where: { key: string } }) => { readLog.push("tmdbCache.findUnique"); return cache.get(args.where.key) ?? null; },
  findMany: async (args: { where: { key: { in: string[] } } }) => {
    readLog.push("tmdbCache.findMany");
    return args.where.key.in.map((k) => cache.get(k)).filter((r): r is CacheRow => r !== undefined);
  },
  deleteMany: async (args: { where: { key?: string | { in: string[] } } }) => {
    writes.push("tmdbCache.deleteMany");
    const k = args.where.key;
    if (typeof k === "string") cache.delete(k);
    else if (k && "in" in k) for (const key of k.in) cache.delete(key);
    return { count: 0 };
  },
  upsert: async (args: { where: { key: string }; create: CacheRow }) => {
    writes.push("tmdbCache.upsert");
    cache.set(args.where.key, args.create);
    return args.create;
  },
});

// ── auth fixture (tests/api-auth.test.mts idiom, verbatim shape) ─────────────
type DbUser = {
  role: string;
  permissions: bigint;
  mediaServer: string | null;
  sessionsRevokedAt: Date | null;
  passwordChangedAt: Date | null;
  deactivatedAt: Date | null;
  email: string | null;
  notificationEmail: string | null;
};
const usersById = new Map<string, DbUser>();
const sessionRows = new Set<string>();
shadowPrismaModel(prisma, "authSession", {
  findUnique: async (args: { where: { sessionId: string } }) =>
    sessionRows.has(args.where.sessionId) ? { id: `row-${args.where.sessionId}`, sessionId: args.where.sessionId } : null,
  update: async () => ({}), // lastSeenAt fire-and-forget touch — deliberately NOT tracked in `writes`
});
shadowPrismaModel(prisma, "user", {
  findUnique: async (args: { where: { id: string } }) => {
    const u = usersById.get(args.where.id);
    return u ? { ...u } : null;
  },
  update: async () => ({}),
});
// Rotation never fires here (claim role/permissions mirror the DB row), but a
// functional $transaction stub keeps an accidental trigger off a real client.
const txStub = {
  authSession: {
    findUnique: async (args: { where: { sessionId: string } }) =>
      sessionRows.has(args.where.sessionId) ? { id: `row-${args.where.sessionId}` } : null,
    update: async (args: { where: { sessionId: string }; data: { sessionId: string } }) => {
      sessionRows.delete(args.where.sessionId);
      sessionRows.add(args.data.sessionId);
      return {};
    },
  },
  user: {
    findUnique: async (args: { where: { id: string } }) => {
      const u = usersById.get(args.where.id);
      return u ? { sessionsRevokedAt: u.sessionsRevokedAt } : null;
    },
    update: async () => ({}),
  },
};
shadowPrismaClientMethod(prisma, "$transaction", async (fn: (tx: typeof txStub) => Promise<unknown>) => fn(txStub));

// Routes under test (imported AFTER every stub is installed).
const { GET: arrStateGET } = await import("../src/app/api/admin/debug/arr-state/route.ts");
const { GET: ratingsStateGET } = await import("../src/app/api/admin/debug/ratings-state/route.ts");

// ── fixtures ─────────────────────────────────────────────────────────────────
const COOKIE = getSessionCookieName();
let seq = 0;
// Mint a REAL signed session JWT with backing user + AuthSession rows. Claim
// role/permissions mirror the DB row so verify takes the plain slow path (no
// rotation, no Set-Cookie surprises).
async function mintSession(role = "ADMIN"): Promise<string> {
  seq++;
  const userId = `user-${seq}`;
  const sessionId = `sess-${seq}`;
  usersById.set(userId, {
    role,
    permissions: 0n,
    mediaServer: null,
    sessionsRevokedAt: null,
    passwordChangedAt: null,
    deactivatedAt: null,
    email: "admin@example.com",
    notificationEmail: null,
  });
  sessionRows.add(sessionId);
  const iat = Math.floor(Date.now() / 1000);
  return signSessionJwt(
    { id: userId, role, permissions: "0", provider: "credentials", sessionId, expiresAt: iat + 86_400 },
    { expiresInSeconds: 7_200, iat },
  );
}

function req(base: string, token: string | null, query: string): Req {
  const headers: Record<string, string> = {};
  if (token) headers.cookie = `${COOKIE}=${token}`;
  return new NextRequest(`http://localhost:3000/api/admin/debug/${base}${query}`, { method: "GET", headers });
}
const arrReq = (token: string | null, query: string) => req("arr-state", token, query);
const ratingsReq = (token: string | null, query: string) => req("ratings-state", token, query);
const bodyOf = (res: Response): Promise<Record<string, unknown>> => res.json() as Promise<Record<string, unknown>>;

// Configure the default Radarr instance so the live check actually fetches.
function configureRadarr(): void {
  settings.set("radarrUrl", "http://radarr.debug-test:7878");
  settings.set("radarrApiKey", "radarr-debug-key");
}
function configureSonarr(): void {
  settings.set("sonarrUrl", "http://sonarr.debug-test:8989");
  settings.set("sonarrApiKey", "sonarr-debug-key");
}
function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}
function seedCache(key: string, data: unknown, expiresInMs: number): void {
  cache.set(key, {
    key,
    data: JSON.stringify(data),
    cachedAt: new Date(Date.now() - 1_000),
    expiresAt: new Date(Date.now() + expiresInMs),
  });
}

beforeEach(() => {
  readLog.length = 0;
  writes.length = 0;
  fetchCalls.length = 0;
  warns.length = 0;
  errors.length = 0;
  settings.clear();
  cache.clear();
  mediaRequestRows = [];
  auditRow = null;
  for (const t of [radarrWanted, sonarrWanted, radarrAvail, sonarrAvail]) t.rows.length = 0;
  fetchImpl = () => {
    throw new Error("unexpected fetch — this test must satisfy its flow from stubs, or script fetchImpl");
  };
});

// ══ withAdmin gating — both routes are ADMIN-only (guardrail 6a) ═════════════

test("arr-state: no session → 401 Unauthorized; the handler body never runs (no business read, no fetch)", async () => {
  const res = await arrStateGET(arrReq(null, "?tmdbId=603&type=movie"), undefined);
  assert.equal(res.status, 401);
  assert.deepEqual(await bodyOf(res), { error: "Unauthorized" });
  assert.equal(readLog.length, 0, "the body must not touch the DB when auth fails");
  assert.equal(fetchCalls.length, 0);
});

test("arr-state: a non-ADMIN session → 403 Forbidden; ISSUE_ADMIN is NOT admin here, body never runs", async () => {
  for (const role of ["USER", "ISSUE_ADMIN"]) {
    readLog.length = 0;
    fetchCalls.length = 0;
    const token = await mintSession(role);
    const res = await arrStateGET(arrReq(token, "?tmdbId=603&type=movie"), undefined);
    assert.equal(res.status, 403, `${role} must not pass withAdmin on arr-state`);
    assert.deepEqual(await bodyOf(res), { error: "Forbidden" });
    assert.equal(readLog.length, 0, `${role} was authenticated but the ADMIN-gated body must not run`);
    assert.equal(fetchCalls.length, 0);
  }
});

test("ratings-state: no session → 401 Unauthorized; the handler body never runs", async () => {
  const res = await ratingsStateGET(ratingsReq(null, "?tmdbId=603&type=movie"), undefined);
  assert.equal(res.status, 401);
  assert.deepEqual(await bodyOf(res), { error: "Unauthorized" });
  assert.equal(readLog.length, 0);
  assert.equal(fetchCalls.length, 0);
});

test("ratings-state: a non-ADMIN session (USER, ISSUE_ADMIN) → 403 Forbidden; body never runs", async () => {
  for (const role of ["USER", "ISSUE_ADMIN"]) {
    readLog.length = 0;
    const token = await mintSession(role);
    const res = await ratingsStateGET(ratingsReq(token, "?tmdbId=603&type=movie"), undefined);
    assert.equal(res.status, 403, `${role} must not pass withAdmin on ratings-state`);
    assert.deepEqual(await bodyOf(res), { error: "Forbidden" });
    assert.equal(readLog.length, 0);
  }
});

// ══ query-param validation (identical guards on both routes) ═════════════════

test("arr-state: missing tmdbId, bad type, and a non-positive/non-integer tmdbId each 400 with the documented message", async () => {
  const token = await mintSession();
  const missingId = await arrStateGET(arrReq(token, "?type=movie"), undefined);
  assert.equal(missingId.status, 400);
  assert.deepEqual(await bodyOf(missingId), { error: "tmdbId and type=movie|tv required" });

  const badType = await arrStateGET(arrReq(token, "?tmdbId=603&type=person"), undefined);
  assert.equal(badType.status, 400);
  assert.deepEqual(await bodyOf(badType), { error: "tmdbId and type=movie|tv required" });

  const missingType = await arrStateGET(arrReq(token, "?tmdbId=603"), undefined);
  assert.equal(missingType.status, 400, "type must be present and be movie|tv");

  for (const bad of ["abc", "0", "-5", "1.5"]) {
    const res = await arrStateGET(arrReq(token, `?tmdbId=${bad}&type=movie`), undefined);
    assert.equal(res.status, 400, `tmdbId=${bad} must 400`);
    assert.deepEqual(await bodyOf(res), { error: "tmdbId must be a positive integer" });
  }
  assert.equal(readLog.length, 0, "no validation path touches the pipeline");
});

test("ratings-state: the same tmdbId/type validation guards 400 before any provider or cache read", async () => {
  const token = await mintSession();
  const missingId = await ratingsStateGET(ratingsReq(token, "?type=tv"), undefined);
  assert.equal(missingId.status, 400);
  assert.deepEqual(await bodyOf(missingId), { error: "tmdbId and type=movie|tv required" });

  const badType = await ratingsStateGET(ratingsReq(token, "?tmdbId=99&type=book"), undefined);
  assert.equal(badType.status, 400);
  assert.deepEqual(await bodyOf(badType), { error: "tmdbId and type=movie|tv required" });

  const badId = await ratingsStateGET(ratingsReq(token, "?tmdbId=0&type=movie"), undefined);
  assert.equal(badId.status, 400);
  assert.deepEqual(await bodyOf(badId), { error: "tmdbId must be a positive integer" });
  assert.equal(readLog.length, 0);
  assert.equal(fetchCalls.length, 0);
});

// ══ arr-state response assembly ══════════════════════════════════════════════

test("arr-state: unconfigured Arr movie query returns the full documented section set with baseline values, zero fetches, zero writes", async () => {
  const token = await mintSession();
  const res = await arrStateGET(arrReq(token, "?tmdbId=603&type=movie"), undefined);
  assert.equal(res.status, 200);
  const body = await bodyOf(res);

  // The whole documented dump — every section present.
  assert.deepEqual(
    Object.keys(body).sort(),
    [
      "attachArrPendingReturns", "cacheTable", "fourK", "instances", "lastFullSync",
      "liveArrApi", "mediaRequests", "query", "tvdbInfo", "wantedTableTotals",
    ],
  );
  assert.deepEqual(body.query, { tmdbId: 603, type: "movie" });
  // Cache row section: keyed to the movie table, empty here.
  assert.deepEqual(body.cacheTable, { tableName: "radarrWantedItem", row: null, hasEntry: false });
  // 4K instance not configured → the whole 4K block reads negative, live check skipped.
  assert.deepEqual(body.fourK, { instanceConfigured: false, cacheRow: null, hasEntry: false, liveArrApi: null });
  // Generalized per-instance view: the synthesized default instance, no cache row,
  // and a live result of false (getCfg null ⇒ isMovieWantedInRadarr short-circuits false, no throw).
  assert.deepEqual(body.instances, [
    { slug: "", name: "Default", cacheRow: null, hasEntry: false, liveArrApi: { result: false } },
  ]);
  assert.equal(body.attachArrPendingReturns, false);
  assert.deepEqual(body.liveArrApi, { result: false });
  assert.deepEqual(body.mediaRequests, []);
  assert.equal(body.tvdbInfo, null, "the tvdb→tmdb section is TV-only; a movie query leaves it null");
  assert.deepEqual(body.wantedTableTotals, { radarr: 0, sonarr: 0 });
  assert.equal(body.lastFullSync, null, "no LIBRARY_SYNC audit row ⇒ null");

  assert.equal(fetchCalls.length, 0, "an unconfigured Arr never reaches the wire");
  assert.equal(writes.length, 0, "arr-state is read-only");
});

test("arr-state: a default-instance wanted cache row lights attachArrPendingReturns and the cacheTable row (delegate owned by arr-availability.test)", async () => {
  radarrWanted.rows.push({ tmdbId: 603, arrInstance: "" });
  const token = await mintSession();
  const body = await bodyOf(await arrStateGET(arrReq(token, "?tmdbId=603&type=movie"), undefined));

  assert.equal(body.attachArrPendingReturns, true, "the route must surface attachArrPending's cache-derived boolean");
  const cacheTable = body.cacheTable as { tableName: string; row: ArrRow | null; hasEntry: boolean };
  assert.equal(cacheTable.hasEntry, true);
  assert.deepEqual(cacheTable.row, { tmdbId: 603, arrInstance: "" });
  const instances = body.instances as Array<{ slug: string; cacheRow: ArrRow | null; hasEntry: boolean }>;
  assert.deepEqual(instances[0].cacheRow, { tmdbId: 603, arrInstance: "" });
  assert.equal(instances[0].hasEntry, true);
  assert.equal(writes.length, 0);
});

test("arr-state: wantedTableTotals reflect count(), mediaRequests come from the query, and lastFullSync parses the LIBRARY_SYNC audit JSON", async () => {
  // Rows for OTHER ids: they feed count() (totals) without lighting the queried id's badge.
  radarrWanted.rows.push({ tmdbId: 1, arrInstance: "" }, { tmdbId: 2, arrInstance: "" }, { tmdbId: 3, arrInstance: "4k" });
  sonarrWanted.rows.push({ tmdbId: 10, arrInstance: "" }, { tmdbId: 11, arrInstance: "" });
  mediaRequestRows = [{ id: "req-1", status: "PENDING", requestedBy: "u1", tvdbId: null }];
  const syncedAt = new Date("2026-07-18T00:00:00.000Z");
  auditRow = { createdAt: syncedAt, details: JSON.stringify({ movies: 42, series: 7 }) };

  const token = await mintSession();
  const body = await bodyOf(await arrStateGET(arrReq(token, "?tmdbId=999&type=movie"), undefined));

  assert.deepEqual(body.wantedTableTotals, { radarr: 3, sonarr: 2 });
  assert.deepEqual(body.mediaRequests, [{ id: "req-1", status: "PENDING", requestedBy: "u1", tvdbId: null }]);
  const lastFullSync = body.lastFullSync as { at: string; details: unknown };
  assert.equal(lastFullSync.at, syncedAt.toISOString());
  assert.deepEqual(lastFullSync.details, { movies: 42, series: 7 }, "the audit details string is parsed to JSON");
});

test("arr-state: a scripted live Radarr check drives liveArrApi.result=true even when the cache disagrees (authoritative-beats-heuristic diagnostic)", async () => {
  // No cache rows ⇒ attachArrPendingReturns=false, but Radarr live-reports the
  // movie as wanted ⇒ liveArrApi.result=true. The dump surfaces BOTH so an admin
  // can see a stale cache. isMovieWantedInRadarr internals are owned by arr.ts.
  configureRadarr();
  fetchImpl = (url) => {
    if (url.pathname.endsWith("/api/v3/movie")) return jsonResponse([{ tmdbId: 603, hasFile: false }]);
    throw new Error(`unexpected Arr path ${url.pathname}`);
  };
  const token = await mintSession();
  const body = await bodyOf(await arrStateGET(arrReq(token, "?tmdbId=603&type=movie"), undefined));

  assert.deepEqual(body.liveArrApi, { result: true });
  const instances = body.instances as Array<{ slug: string; liveArrApi: { result: boolean } }>;
  assert.deepEqual(instances[0].liveArrApi, { result: true }, "the per-instance live check ran too");
  assert.equal(body.attachArrPendingReturns, false, "the cache is empty — the live result legitimately disagrees");
  assert.ok(
    fetchCalls.some((u) => u.pathname.endsWith("/api/v3/movie") && u.searchParams.get("tmdbId") === "603"),
    "the live Radarr lookup went out over the wire",
  );
  assert.equal(writes.length, 0, "a live GET check writes nothing");
});

test("arr-state: a TV query with a configured Sonarr + scripted lookup surfaces the tvdb→tmdb section and the sonarr cache table", async () => {
  configureSonarr();
  // getCache reads the negative-cacheable tvdb→tmdb mapping row directly.
  seedCache("tvdb-to-tmdb:5678", { tmdbId: 1399 }, 60_000);
  fetchImpl = (url) => {
    if (url.pathname.endsWith("/series/lookup")) return jsonResponse([{ tvdbId: 5678 }]);
    if (url.pathname.endsWith("/api/v3/series")) return jsonResponse([{ tvdbId: 5678, statistics: { episodeFileCount: 0 } }]);
    throw new Error(`unexpected Arr path ${url.pathname}`);
  };
  const token = await mintSession();
  const body = await bodyOf(await arrStateGET(arrReq(token, "?tmdbId=1399&type=tv"), undefined));

  const cacheTable = body.cacheTable as { tableName: string };
  assert.equal(cacheTable.tableName, "sonarrWantedItem", "a TV query reads the Sonarr wanted table");
  assert.deepEqual(body.tvdbInfo, { tvdbId: 5678, cachedMapping: { tmdbId: 1399 } });
});

// ══ ratings-state response assembly ══════════════════════════════════════════

test("ratings-state: provider flags reflect configured keys (truthiness only) and both quota lockouts read false at rest", async () => {
  settings.set("mdblistApiKey", "mdb-key");
  settings.set("omdbApiKey", "   "); // whitespace-only ⇒ NOT configured (trim())
  // traktClientId absent ⇒ false
  const token = await mintSession();
  const body = await bodyOf(await ratingsStateGET(ratingsReq(token, "?tmdbId=603&type=movie"), undefined));

  assert.deepEqual(body.providers, { mdblist: true, omdb: false, trakt: false });
  assert.deepEqual(body.lockouts, { mdblistQuotaLocked: false, omdbQuotaLocked: false });
  assert.deepEqual(
    Object.keys(body).sort(),
    ["cache", "details", "lockouts", "now", "providers", "query"],
    "no `live` key without ?live=1",
  );
  assert.deepEqual(body.query, { tmdbId: 603, type: "movie", live: false });
});

test("ratings-state: the raw ratings cache section reports fresh values, a stale row, and a _notFound sentinel (data withheld)", async () => {
  const ratings = { imdbRating: "8.7", rottenTomatoes: "87%" };
  seedCache("mdblist:tmdb:movie:603", ratings, 60_000); // fresh value row
  seedCache("omdb:tmdb:movie:603", { _notFound: true }, -1_000); // stale sentinel
  const token = await mintSession();
  const body = await bodyOf(await ratingsStateGET(ratingsReq(token, "?tmdbId=603&type=movie"), undefined));

  const c = body.cache as { mdblist: Record<string, unknown>; omdb: Record<string, unknown> };
  assert.equal(c.mdblist.key, "mdblist:tmdb:movie:603");
  assert.equal(c.mdblist.exists, true);
  assert.equal(c.mdblist.stale, false);
  assert.equal(c.mdblist.notFoundSentinel, false);
  assert.deepEqual(c.mdblist.data, ratings, "a real value row echoes its parsed payload");

  assert.equal(c.omdb.exists, true);
  assert.equal(c.omdb.stale, true, "an expiresAt in the past reads stale");
  assert.equal(c.omdb.notFoundSentinel, true);
  assert.equal(c.omdb.data, null, "the sentinel is reported via the flag, not by dumping {_notFound:true}");

  assert.equal(writes.length, 0, "reading raw cache rows never mutates them (no getCache lazy-delete here)");
});

test("ratings-state: the details section surfaces the rating tri-state — null = authoritative none (present), undefined = never fetched (dropped)", async () => {
  // imdbRating null (authoritative none), rottenTomatoes ABSENT (never fetched),
  // plus certification/releaseDate which the Observability note calls out.
  seedCache("movie:603:details", { imdbId: "tt0133093", imdbRating: null, certification: "R", releaseDate: "1999-03-31" }, 60_000);
  const token = await mintSession();
  const body = await bodyOf(await ratingsStateGET(ratingsReq(token, "?tmdbId=603&type=movie"), undefined));

  const details = body.details as { key: string; exists: boolean; stale: boolean; fields: Record<string, unknown> };
  assert.equal(details.key, "movie:603:details");
  assert.equal(details.exists, true);
  assert.equal(details.stale, false);
  assert.equal("imdbRating" in details.fields, true);
  assert.equal(details.fields.imdbRating, null, "null survives serialization = authoritative 'no rating'");
  assert.equal("rottenTomatoes" in details.fields, false, "an undefined field is dropped = 'never fetched'");
  assert.equal(details.fields.certification, "R");
  assert.equal(details.fields.releaseDate, "1999-03-31");

  // No details row at all: exists=false and fields collapse to null.
  cache.clear();
  const empty = await bodyOf(await ratingsStateGET(ratingsReq(await mintSession(), "?tmdbId=603&type=movie"), undefined));
  const emptyDetails = empty.details as { exists: boolean; fields: unknown; cachedAt: unknown };
  assert.equal(emptyDetails.exists, false);
  assert.equal(emptyDetails.fields, null);
  assert.equal(emptyDetails.cachedAt, null);
});

test("ratings-state HEADLINE: WITHOUT &live=1 the live probe is skipped — no `live` key, zero provider fetches, zero writes (read-only)", async () => {
  settings.set("mdblistApiKey", "mdb-key"); // configured, but nothing must call it
  settings.set("omdbApiKey", "omdb-key");
  const token = await mintSession();
  const res = await ratingsStateGET(ratingsReq(token, "?tmdbId=603&type=movie"), undefined);
  assert.equal(res.status, 200);
  const body = await bodyOf(res);

  assert.equal("live" in body, false, "the live section must be absent without ?live=1");
  assert.equal(fetchCalls.length, 0, "fetchUnifiedRatings must NOT run — zero provider requests");
  assert.equal(writes.length, 0, "the non-live path is strictly read-only");
});

test("ratings-state HEADLINE: WITH &live=1 fetchUnifiedRatings runs — a `live` section is attached and a provider request goes out", async () => {
  settings.set("mdblistApiKey", "mdb-key");
  // Cold cache (no mdblist row for this id) ⇒ the live probe must fetch MDBList.
  fetchImpl = (url) => {
    if (url.hostname === "api.mdblist.com") return jsonResponse({ id: 550, ratings: [{ source: "imdb", value: 8.8, votes: 2_000_000 }] });
    throw new Error(`unexpected live-probe fetch to ${url.hostname}`);
  };
  const token = await mintSession();
  const res = await ratingsStateGET(ratingsReq(token, "?tmdbId=550&type=movie&live=1"), undefined);
  assert.equal(res.status, 200);
  const body = await bodyOf(res);

  assert.deepEqual(body.query, { tmdbId: 550, type: "movie", live: true });
  assert.equal("live" in body, true, "the opt-in live section must be present");
  const live = body.live as { found?: boolean };
  assert.equal(live.found, true);
  assert.ok(fetchCalls.length >= 1, "the live probe issued at least one provider request");
  assert.ok(fetchCalls.some((u) => u.hostname === "api.mdblist.com"), "MDBList (the primary source) was queried");
});
