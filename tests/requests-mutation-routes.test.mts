// Route-level unit tests for the three uncovered /api/requests/* routes:
//   PATCH        /api/requests/batch             bulk approve / decline
//   PATCH/DELETE /api/requests/[id]              single-request transitions + cancel
//   GET          /api/requests/quality-profiles  the approve/request profile picker
//
// tests/requests-route.test.mts covers request CREATION; these are the routes
// that MUTATE an existing request, and every one of their sharp edges is a race
// or a data-loss bug the code comments already name:
//
//   1. EVERY TRANSITION IS A COMPARE-AND-SWAP ON THE CURRENT STATUS. batch claims
//      each row individually with `updateMany({ where: { id, status: "PENDING" }})`
//      and drives every side effect off the rows whose count came back 1 — the
//      older shared findMany-then-updateMany snapshot let two concurrent calls
//      both act on the same request and double-push it to ARR. requests/[id] does
//      the same against `existing.status` and answers 409 when the row moved
//      underneath it, because its transition-table check ran on a stale read.
//   2. THE adminNote GUARD IS ON THE **RAW** BODY FIELD. sanitizeOptional maps
//      undefined → null, so guarding on the sanitized value is always truthy and
//      wipes the stored note on EVERY status transition. Both routes guard on
//      `adminNote !== undefined` instead, and both are pinned here.
//   3. APPROVING CLEARS permanentlyDeclined. Otherwise an APPROVED row keeps the
//      sticky flag and the owner's future re-requests stay blocked by the gate in
//      requests/route.ts. Reopening a DECLINED row to PENDING must clear it too,
//      or the row reads PENDING while the user is still blocked.
//   4. A FAILED ARR PUSH ROLLS BACK TO PENDING AND IS NOT NOTIFIED. Otherwise the
//      user gets an "Approved!" ping for a request that is really back in the
//      queue with no ARR backing.
//   5. DELETE IS OWNERSHIP-GATED AND RACE-SAFE: an owner may cancel only their own
//      PENDING request, and both branches use a guarded deleteMany rather than
//      delete so a concurrent removal is a 404 instead of a P2025 500.
//   6. Permanent declines are capped at 25, below the general 100, so one click
//      can't blast a hundred users into the terminal state.
//
// Harness: real wrapped handlers, genuine signed session JWTs, a synthetic Next
// request scope, in-memory prisma stubs whose mediaRequest delegate MODELS the
// status state machine (updateMany honours the status predicate, so the CAS is
// actually exercised rather than assumed). No DB, no network.
import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { AsyncLocalStorage } from "node:async_hooks";
import dns from "node:dns/promises";

(globalThis as { AsyncLocalStorage?: unknown }).AsyncLocalStorage = AsyncLocalStorage;

process.env.TOKEN_ENCRYPTION_KEY = "ab".repeat(32);
process.env.NEXTAUTH_SECRET = "requests-mutation-secret-0123456789abc";
process.env.AUTH_URL = "http://localhost:3000";
process.env.TRUST_PROXY = "true";
process.env.TMDB_READ_TOKEN = "test-tmdb-read-token";
(process.env as Record<string, string | undefined>).NODE_ENV = "test";

const fakeLookup = async () => [{ address: "93.184.216.34", family: 4 }];
(dns as { lookup: unknown }).lookup = fakeLookup;
if ((dns as { lookup: unknown }).lookup !== fakeLookup) throw new Error("could not stub dns.lookup");

const warns: string[] = [];
const errors: string[] = [];
console.warn = (...args: unknown[]) => { warns.push(args.map(String).join(" ")); };
console.error = (...args: unknown[]) => { errors.push(args.map(String).join(" ")); };

// ── scripted upstreams ───────────────────────────────────────────────────────
const fetchCalls: Array<{ url: URL; method: string }> = [];
let arrOk = true;
let arrFailTmdbIds = new Set<number>();
let profilesOk = true;

globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
  const url = new URL(String(input));
  fetchCalls.push({ url, method: init?.method ?? "GET" });
  const json = (b: unknown, s = 200) => new Response(JSON.stringify(b), { status: s, headers: { "content-type": "application/json" } });

  if (url.pathname.includes("/api/v3/qualityprofile")) {
    return profilesOk ? json([{ id: 1, name: "HD-1080p" }, { id: 2, name: "Ultra-HD" }]) : json({ error: "ARR PROFILES DOWN" }, 500);
  }
  if (url.pathname.includes("/api/v3/rootfolder")) return json([{ path: "/media" }]);
  // LOOKUP comes before the add and must return an ARRAY containing the tmdbId
  // being requested — otherwise addMovieToRadarr / addSeriesToSonarr throw
  // "no movie found", every approve rolls back, and the whole file silently
  // tests the failure path instead of the success one.
  if (url.pathname.includes("/lookup")) {
    const term = url.searchParams.get("term") ?? "";
    const tmdbId = Number(term.replace(/^tmdb:/, "")) || 0;
    if (!arrOk) return json({ message: "ARR LOOKUP FAILED" }, 500);
    return json([{ tmdbId, tvdbId: 4242, title: "The Matrix", year: 1999, titleSlug: "the-matrix", images: [], seasons: [] }]);
  }
  // The actual add. Failure is keyed on the tmdbId in the POST body.
  if (url.pathname.includes("/api/v3/movie") || url.pathname.includes("/api/v3/series")) {
    const body = typeof init?.body === "string" ? init.body : "";
    // Match the tmdbId FIELD, not a bare substring: the lookup fixture carries
    // year 1999, so a substring test made a sentinel like 999 fail every add.
    const failing = [...arrFailTmdbIds].some((id) =>
      new RegExp(`"tmdbId"\\s*:\\s*${id}\\b`).test(body) || new RegExp(`"tvdbId"\\s*:\\s*${id}\\b`).test(body),
    );
    if (!arrOk || failing) return json({ message: "ARR ADD FAILED" }, 500);
    return json({ id: 1, tvdbId: 4242 });
  }
  if ((url.hostname === "themoviedb.org" || url.hostname.endsWith(".themoviedb.org"))) return json({ id: 603, title: "The Matrix", results: [] });
  return json({});
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

// ── op log ───────────────────────────────────────────────────────────────────
type Op = { op: string; args?: unknown };
let ops: Op[] = [];
const rec = (op: string, args?: unknown) => { ops.push({ op, args }); };
const opsOf = (name: string) => ops.filter((o) => o.op === name);

// ── auth fixture ─────────────────────────────────────────────────────────────
type AppUser = Record<string, unknown> & { id: string; email: string };
let appUsers: AppUser[] = [];
const sessionRows = new Set<string>();

shadowPrismaModel(prisma, "authSession", {
  findUnique: async (args: { where: { sessionId: string } }) =>
    sessionRows.has(args.where.sessionId) ? { id: `row-${args.where.sessionId}`, sessionId: args.where.sessionId } : null,
  update: async () => ({}),
});
shadowPrismaModel(prisma, "user", {
  findUnique: async (args: { where: { id: string } }) => {
    const u = appUsers.find((x) => x.id === args.where.id);
    return u ? { ...u } : null;
  },
  findMany: async (args: { where?: { id?: { in?: string[] }; deactivatedAt?: unknown } } = {}) => {
    rec("user.findMany", args.where);
    let rows = appUsers;
    const ids = args.where?.id?.in;
    if (ids) rows = rows.filter((u) => ids.includes(u.id));
    if (args.where && "deactivatedAt" in args.where) rows = rows.filter((u) => u.deactivatedAt === args.where!.deactivatedAt);
    return rows.map((u) => ({ ...u }));
  },
  update: async () => ({}),
  count: async () => appUsers.length,
});

// ── MediaRequest store: MODELS the status state machine ──────────────────────
// updateMany honours a `status` predicate, so the compare-and-swap the routes
// rely on is genuinely exercised — a mutation that drops the predicate produces
// a different count here and the assertions move.
type ReqStatus = "PENDING" | "APPROVED" | "DECLINED" | "AVAILABLE";
type ReqRow = {
  id: string; tmdbId: number; mediaType: "MOVIE" | "TV"; arrInstance: string;
  requestedBy: string; title: string; posterPath: string | null; releaseYear: string | null;
  status: ReqStatus; permanentlyDeclined: boolean; adminNote: string | null;
  pendingNotifyAt: Date | null; availableAt: Date | null; qualityProfileId: number | null;
  tvdbId: number | null; createdAt: Date;
};
let reqRows: ReqRow[] = [];

function matchReq(r: ReqRow, where: Record<string, unknown> | undefined): boolean {
  if (!where) return true;
  for (const [k, v] of Object.entries(where)) {
    if (k === "id") {
      const idf = v as string | { in?: string[] };
      if (typeof idf === "string") { if (r.id !== idf) return false; continue; }
      if (idf.in && !idf.in.includes(r.id)) return false;
      continue;
    }
    if (k === "status") {
      const sf = v as string | { not?: string; in?: string[] };
      if (typeof sf === "string") { if (r.status !== sf) return false; continue; }
      if (sf.not !== undefined && r.status === sf.not) return false;
      if (sf.in && !sf.in.includes(r.status)) return false;
      continue;
    }
    if ((r as unknown as Record<string, unknown>)[k] !== v) return false;
  }
  return true;
}

shadowPrismaModel(prisma, "mediaRequest", {
  findUnique: async (args: { where: { id: string } }) => {
    rec("mediaRequest.findUnique", args.where);
    const r = reqRows.find((x) => x.id === args.where.id);
    return r ? { ...r } : null;
  },
  findFirst: async (args: { where?: Record<string, unknown> } = {}) => {
    rec("mediaRequest.findFirst", args.where);
    const r = reqRows.find((x) => matchReq(x, args.where));
    return r ? { ...r } : null;
  },
  findMany: async (args: { where?: Record<string, unknown> } = {}) => {
    rec("mediaRequest.findMany", args.where);
    return reqRows.filter((r) => matchReq(r, args.where)).map((r) => ({ ...r }));
  },
  updateMany: async (args: { where: Record<string, unknown>; data: Record<string, unknown> }) => {
    rec("mediaRequest.updateMany", args);
    let n = 0;
    for (const r of reqRows) {
      if (!matchReq(r, args.where)) continue;
      Object.assign(r, args.data);
      n++;
    }
    return { count: n };
  },
  update: async (args: { where: { id: string }; data: Record<string, unknown> }) => {
    rec("mediaRequest.update", args);
    const r = reqRows.find((x) => x.id === args.where.id);
    if (r) Object.assign(r, args.data);
    return r ? { ...r } : {};
  },
  deleteMany: async (args: { where: Record<string, unknown> }) => {
    rec("mediaRequest.deleteMany", args.where);
    const keep = reqRows.filter((r) => !matchReq(r, args.where));
    const removed = reqRows.length - keep.length;
    reqRows = keep;
    return { count: removed };
  },
  delete: async (args: unknown) => { rec("mediaRequest.delete", args); return {}; },
  count: async (args: { where?: Record<string, unknown> } = {}) => reqRows.filter((r) => matchReq(r, args.where)).length,
});

const settings = new Map<string, string>();
shadowPrismaModel(prisma, "setting", {
  findUnique: async (args: { where: { key: string } }) => {
    const v = settings.get(args.where.key);
    return v === undefined ? null : { key: args.where.key, value: v };
  },
  findMany: async (args: { where?: { key?: { in?: string[] } } } = {}) => {
    const keys = args.where?.key?.in;
    const all = [...settings.entries()].map(([key, value]) => ({ key, value }));
    return keys ? all.filter((r) => keys.includes(r.key)) : all;
  },
  upsert: async () => ({}), create: async () => ({}), update: async () => ({}), deleteMany: async () => ({ count: 0 }),
});

shadowPrismaModel(prisma, "auditLog", { create: async (args: unknown) => { rec("auditLog.create", args); return { id: "a1" }; } });
shadowPrismaModel(prisma, "notification", {
  createMany: async (args: { data: unknown[] }) => { rec("notification.createMany", args); return { count: args.data.length }; },
  create: async (args: unknown) => { rec("notification.create", args); return {}; },
  findMany: async () => [], count: async () => 0, deleteMany: async () => ({ count: 0 }), updateMany: async () => ({ count: 0 }),
});
for (const m of ["pushSubscription", "issue", "deletionVote", "plexLibraryItem", "jellyfinLibraryItem", "tmdbCache", "tmdbMediaCore", "radarrWantedItem", "sonarrWantedItem"]) {
  shadowPrismaModel(prisma, m, {
    findMany: async () => [], findUnique: async () => null, findFirst: async () => null, count: async () => 0,
    create: async () => ({}), createMany: async () => ({ count: 0 }), update: async () => ({}),
    updateMany: async () => ({ count: 0 }), deleteMany: async () => ({ count: 0 }), upsert: async () => ({}),
  });
}
shadowPrismaClientMethod(prisma, "$transaction", async (arg: unknown) =>
  Array.isArray(arg) ? Promise.all(arg) : (arg as (tx: unknown) => Promise<unknown>)(prisma));
shadowPrismaClientMethod(prisma, "$queryRaw", async () => []);
shadowPrismaClientMethod(prisma, "$queryRawUnsafe", async () => []);
shadowPrismaClientMethod(prisma, "$executeRaw", async () => 1);
shadowPrismaClientMethod(prisma, "$executeRawUnsafe", async () => 1);

const batchRoute = await import("../src/app/api/requests/batch/route.ts");
const idRoute = await import("../src/app/api/requests/[id]/route.ts");
const profilesRoute = await import("../src/app/api/requests/quality-profiles/route.ts");

// ── scope ────────────────────────────────────────────────────────────────────
const afterTasks: Array<() => Promise<unknown>> = [];
function inScope<T>(fn: () => Promise<T>): Promise<T> {
  const workStore = {
    route: "/requests-mutation.test", forceStatic: false, dynamicShouldError: false,
    afterContext: {
      after: (task: unknown) => {
        afterTasks.push(typeof task === "function" ? (task as () => Promise<unknown>) : async () => task);
      },
    },
  };
  const reqHeaders = new Headers();
  const requestStore = {
    type: "request", phase: "render",
    headers: HeadersAdapter.seal(reqHeaders),
    cookies: RequestCookiesAdapter.seal(new RequestCookies(reqHeaders)),
    usedDynamic: false,
  };
  return workAsyncStorage.run(workStore, () => workUnitAsyncStorage.run(requestStore, fn));
}

let seq = 0;
async function mintSession(opts: { permissions?: bigint; role?: string } = {}): Promise<{ userId: string; token: string }> {
  seq++;
  const userId = `actor-${seq}`;
  const sessionId = `sess-${seq}`;
  const role = opts.role ?? "USER";
  const permissions = (opts.permissions ?? 0n).toString();
  appUsers.push({
    id: userId, name: `Actor ${seq}`, email: `actor-${seq}@example.com`, role,
    permissions: BigInt(permissions), mediaServer: null, sessionsRevokedAt: null,
    passwordChangedAt: null, deactivatedAt: null, notificationEmail: null,
    emailOnApproved: true, emailOnDeclined: true,
  });
  sessionRows.add(sessionId);
  const iat = Math.floor(Date.now() / 1000);
  const token = await signSessionJwt(
    { id: userId, role, permissions, provider: "credentials", sessionId, expiresAt: iat + 86_400 },
    { expiresInSeconds: 7_200, iat },
  );
  return { userId, token };
}
const COOKIE = getSessionCookieName();
const manager = () => mintSession({ permissions: Permission.MANAGE_REQUESTS });

function mk(path: string, token: string | null, init: { method: string; body?: string; query?: string }) {
  return new NextRequest(`http://localhost:3000${path}${init.query ?? ""}`, {
    method: init.method,
    headers: { ...(token ? { cookie: `${COOKIE}=${token}` } : {}), "content-type": "application/json" },
    ...(init.body !== undefined ? { body: init.body } : {}),
  });
}
const doBatch = (t: string | null, body: unknown, raw?: string) =>
  inScope(() => batchRoute.PATCH(mk("/api/requests/batch", t, { method: "PATCH", body: raw ?? JSON.stringify(body) }), undefined));
const doPatch = (t: string | null, id: string, body: unknown, raw?: string) =>
  inScope(() => idRoute.PATCH(mk(`/api/requests/${id}`, t, { method: "PATCH", body: raw ?? JSON.stringify(body) }), { params: Promise.resolve({ id }) }));
const doDelete = (t: string | null, id: string) =>
  inScope(() => idRoute.DELETE(mk(`/api/requests/${id}`, t, { method: "DELETE" }), { params: Promise.resolve({ id }) }));
const doProfiles = (t: string | null, q: string) =>
  inScope(() => profilesRoute.GET(mk("/api/requests/quality-profiles", t, { method: "GET", query: q }), undefined));

function reqRow(over: Partial<ReqRow> & { id: string; requestedBy: string }): ReqRow {
  return {
    tmdbId: 603, mediaType: "MOVIE", arrInstance: "", title: "The Matrix",
    posterPath: null, releaseYear: "1999", status: "PENDING", permanentlyDeclined: false,
    adminNote: null, pendingNotifyAt: null, availableAt: null, qualityProfileId: null,
    tvdbId: null, createdAt: new Date(), ...over,
  };
}
async function drainAfter(): Promise<void> {
  const tasks = [...afterTasks];
  afterTasks.length = 0;
  for (const t of tasks) await t();
}

beforeEach(() => {
  ops = [];
  appUsers = [];
  reqRows = [];
  afterTasks.length = 0;
  fetchCalls.length = 0;
  warns.length = 0;
  errors.length = 0;
  settings.clear();
  settings.set("radarrUrl", "http://10.0.0.2:7878");
  settings.set("radarrApiKey", "radarr-key");
  settings.set("sonarrUrl", "http://10.0.0.3:8989");
  settings.set("sonarrApiKey", "sonarr-key");
  arrOk = true;
  arrFailTmdbIds = new Set();
  profilesOk = true;
});

// ── gating ───────────────────────────────────────────────────────────────────

test("all three routes refuse an anonymous caller with 401", async () => {
  assert.equal((await doBatch(null, { ids: ["r1"], status: "APPROVED" })).status, 401);
  assert.equal((await doPatch(null, "r1", { status: "APPROVED" })).status, 401);
  assert.equal((await doDelete(null, "r1")).status, 401);
  assert.equal((await doProfiles(null, "?mediaType=MOVIE")).status, 401);
});

test("batch and the single PATCH require MANAGE_REQUESTS", async () => {
  const { token } = await mintSession();
  assert.equal((await doBatch(token, { ids: ["r1"], status: "APPROVED" })).status, 403);
  assert.equal((await doPatch(token, "r1", { status: "APPROVED" })).status, 403);
  assert.equal(opsOf("mediaRequest.updateMany").length, 0);
});

test("quality-profiles admits MANAGE_REQUESTS or REQUEST_ADVANCED, not just admins", async () => {
  // It is deliberately NOT withAdmin: settings/arr-options is ADMIN-only and
  // would 403 a non-admin approver or an advanced requester.
  for (const perm of [Permission.MANAGE_REQUESTS, Permission.REQUEST_ADVANCED]) {
    const { token } = await mintSession({ permissions: perm });
    assert.equal((await doProfiles(token, "?mediaType=MOVIE")).status, 200, `perm ${perm} should be admitted`);
  }
  const plain = await mintSession();
  assert.equal((await doProfiles(plain.token, "?mediaType=MOVIE")).status, 403);
});

// ── 1: the batch compare-and-swap ────────────────────────────────────────────

test("batch claims each row individually and drives side effects off the CLAIMED set", async () => {
  const { token, userId } = await manager();
  const owner = await mintSession();
  reqRows = [
    reqRow({ id: "r1", requestedBy: owner.userId, tmdbId: 1 }),
    reqRow({ id: "r2", requestedBy: owner.userId, tmdbId: 2, status: "APPROVED" }), // already moved
    reqRow({ id: "r3", requestedBy: owner.userId, tmdbId: 3 }),
  ];
  void userId;
  const res = await doBatch(token, { ids: ["r1", "r2", "r3"], status: "APPROVED" });
  assert.equal(res.status, 200);
  // Each claim is its OWN updateMany carrying the PENDING predicate.
  const claims = opsOf("mediaRequest.updateMany").filter(
    (o) => (o.args as { where: { status?: string } }).where.status === "PENDING",
  );
  assert.equal(claims.length, 3, "one claim per id, not one bulk update");
  for (const c of claims) {
    assert.equal((c.args as { where: { status: string } }).where.status, "PENDING");
  }
});

test("a row that is ALREADY non-PENDING is skipped, not re-approved", async () => {
  // A concurrent batch on the same ids finds them non-PENDING (count 0), so the
  // ARR push and notifications can't double-fire.
  const { token } = await manager();
  const owner = await mintSession();
  reqRows = [reqRow({ id: "r1", requestedBy: owner.userId, status: "DECLINED" })];
  await doBatch(token, { ids: ["r1"], status: "APPROVED" });
  assert.equal(reqRows[0].status, "DECLINED", "a non-PENDING row must not transition");
  assert.deepEqual(fetchCalls.filter((c) => c.method === "POST"), [], "no ARR push for an unclaimed row");
});

test("batch approve pushes to ARR once per claimed row", async () => {
  const { token } = await manager();
  const owner = await mintSession();
  reqRows = [
    reqRow({ id: "r1", requestedBy: owner.userId, tmdbId: 11 }),
    reqRow({ id: "r2", requestedBy: owner.userId, tmdbId: 22 }),
  ];
  await doBatch(token, { ids: ["r1", "r2"], status: "APPROVED" });
  const adds = fetchCalls.filter((c) => c.method === "POST" && c.url.pathname.includes("/api/v3/movie"));
  assert.equal(adds.length, 2);
});

// ── 4: failed ARR push rolls back and is not notified ────────────────────────

test("a FAILED ARR push rolls the row back to PENDING", async () => {
  const { token } = await manager();
  const owner = await mintSession();
  reqRows = [
    reqRow({ id: "ok", requestedBy: owner.userId, tmdbId: 100 }),
    reqRow({ id: "bad", requestedBy: owner.userId, tmdbId: 999 }),
  ];
  arrFailTmdbIds = new Set([999]);
  const res = await doBatch(token, { ids: ["ok", "bad"], status: "APPROVED" });
  assert.equal(res.status, 200);
  assert.equal(reqRows.find((r) => r.id === "ok")!.status, "APPROVED");
  assert.equal(reqRows.find((r) => r.id === "bad")!.status, "PENDING", "a failed push must not leave the row APPROVED");
  assert.equal(reqRows.find((r) => r.id === "bad")!.pendingNotifyAt, null);
});

test("a rolled-back row is NOT notified — no misleading Approved ping", async () => {
  const { token } = await manager();
  const owner = await mintSession();
  reqRows = [reqRow({ id: "bad", requestedBy: owner.userId, tmdbId: 999 })];
  arrFailTmdbIds = new Set([999]);
  await doBatch(token, { ids: ["bad"], status: "APPROVED" });
  await drainAfter();
  const inbox = opsOf("notification.createMany");
  const rows = inbox.flatMap((o) => (o.args as { data: Array<{ userId: string }> }).data);
  assert.equal(rows.length, 0, "a request that rolled back must not produce an approval notification");
});

test("a successful batch approve DOES write an inbox row for the owner", async () => {
  const { token } = await manager();
  const owner = await mintSession();
  reqRows = [reqRow({ id: "r1", requestedBy: owner.userId })];
  await doBatch(token, { ids: ["r1"], status: "APPROVED" });
  await drainAfter();
  const rows = opsOf("notification.createMany").flatMap((o) => (o.args as { data: Array<{ userId: string; type: string }> }).data);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].userId, owner.userId);
  assert.equal(rows[0].type, "REQUEST_APPROVED");
});

test("the acting admin gets no self-notification for their OWN request", async () => {
  const { token, userId } = await manager();
  reqRows = [reqRow({ id: "mine", requestedBy: userId })];
  await doBatch(token, { ids: ["mine"], status: "APPROVED" });
  await drainAfter();
  const rows = opsOf("notification.createMany").flatMap((o) => (o.args as { data: Array<{ userId: string }> }).data);
  assert.ok(!rows.some((r) => r.userId === userId), "no self-ping");
});

test("a DEACTIVATED owner is excluded from the email fan-out (guardrail 33)", async () => {
  const { token } = await manager();
  const owner = await mintSession();
  appUsers.find((u) => u.id === owner.userId)!.deactivatedAt = new Date();
  reqRows = [reqRow({ id: "r1", requestedBy: owner.userId })];
  await doBatch(token, { ids: ["r1"], status: "APPROVED" });
  await drainAfter();
  const emailQuery = opsOf("user.findMany").find((o) => {
    const w = o.args as { deactivatedAt?: unknown } | undefined;
    return w && "deactivatedAt" in w;
  });
  assert.ok(emailQuery, "the email fan-out must filter on deactivatedAt");
  assert.equal((emailQuery.args as { deactivatedAt: unknown }).deactivatedAt, null);
});

// ── 2: the adminNote raw-field guard ─────────────────────────────────────────

test("batch: OMITTING adminNote leaves the stored note intact", async () => {
  // sanitizeOptional maps undefined → null, so guarding on the SANITIZED value
  // is always truthy and wipes the note on every transition.
  const { token } = await manager();
  const owner = await mintSession();
  reqRows = [reqRow({ id: "r1", requestedBy: owner.userId, adminNote: "keep me" })];
  await doBatch(token, { ids: ["r1"], status: "APPROVED" });
  assert.equal(reqRows[0].adminNote, "keep me");
});

test("batch: SUPPLYING adminNote overwrites it", async () => {
  const { token } = await manager();
  const owner = await mintSession();
  reqRows = [reqRow({ id: "r1", requestedBy: owner.userId, adminNote: "old" })];
  await doBatch(token, { ids: ["r1"], status: "DECLINED", adminNote: "new reason" });
  assert.equal(reqRows[0].adminNote, "new reason");
});

test("single PATCH: omitting adminNote leaves the stored note intact", async () => {
  const { token } = await manager();
  const owner = await mintSession();
  reqRows = [reqRow({ id: "r1", requestedBy: owner.userId, adminNote: "keep me" })];
  await doPatch(token, "r1", { status: "APPROVED" });
  assert.equal(reqRows[0].adminNote, "keep me");
});

test("single PATCH: supplying adminNote overwrites it", async () => {
  const { token } = await manager();
  const owner = await mintSession();
  reqRows = [reqRow({ id: "r1", requestedBy: owner.userId, adminNote: "old" })];
  await doPatch(token, "r1", { status: "DECLINED", adminNote: "not this one" });
  assert.equal(reqRows[0].adminNote, "not this one");
});

// ── 3: permanentlyDeclined lifecycle ─────────────────────────────────────────

test("batch approve CLEARS permanentlyDeclined", async () => {
  // Otherwise the row is APPROVED while the owner stays blocked from re-requesting.
  const { token } = await manager();
  const owner = await mintSession();
  reqRows = [reqRow({ id: "r1", requestedBy: owner.userId, permanentlyDeclined: true })];
  await doBatch(token, { ids: ["r1"], status: "APPROVED" });
  assert.equal(reqRows[0].permanentlyDeclined, false);
});

test("single approve CLEARS permanentlyDeclined", async () => {
  const { token } = await manager();
  const owner = await mintSession();
  reqRows = [reqRow({ id: "r1", requestedBy: owner.userId, status: "DECLINED", permanentlyDeclined: true })];
  await doPatch(token, "r1", { status: "APPROVED" });
  assert.equal(reqRows[0].permanentlyDeclined, false);
});

test("reopening a DECLINED request to PENDING clears the sticky flag", async () => {
  // Else the row reads PENDING while the user is still blocked by the
  // permanentlyDeclined gate in requests/route.ts.
  const { token } = await manager();
  const owner = await mintSession();
  reqRows = [reqRow({ id: "r1", requestedBy: owner.userId, status: "DECLINED", permanentlyDeclined: true })];
  await doPatch(token, "r1", { status: "PENDING" });
  assert.equal(reqRows[0].status, "PENDING");
  assert.equal(reqRows[0].permanentlyDeclined, false);
});

test("a permanent batch decline sets the flag; a normal one does not", async () => {
  const { token } = await manager();
  const owner = await mintSession();
  reqRows = [reqRow({ id: "p", requestedBy: owner.userId }), reqRow({ id: "n", requestedBy: owner.userId })];
  await doBatch(token, { ids: ["p"], status: "DECLINED", permanent: true });
  await doBatch(token, { ids: ["n"], status: "DECLINED" });
  assert.equal(reqRows.find((r) => r.id === "p")!.permanentlyDeclined, true);
  assert.equal(reqRows.find((r) => r.id === "n")!.permanentlyDeclined, false);
});

test("`permanent` is ignored on an APPROVE — it only qualifies a decline", async () => {
  const { token } = await manager();
  const owner = await mintSession();
  reqRows = [reqRow({ id: "r1", requestedBy: owner.userId })];
  await doBatch(token, { ids: ["r1"], status: "APPROVED", permanent: true });
  assert.equal(reqRows[0].permanentlyDeclined, false);
});

// ── 6: batch validation and caps ─────────────────────────────────────────────

for (const [label, body] of [
  ["a missing ids array", { status: "APPROVED" }],
  ["an empty ids array", { ids: [], status: "APPROVED" }],
  ["ids as a string", { ids: "r1", status: "APPROVED" }],
  ["non-string ids", { ids: ["r1", 2], status: "APPROVED" }],
  ["a missing status", { ids: ["r1"] }],
  ["an unknown status", { ids: ["r1"], status: "AVAILABLE" }],
  ["a lowercase status", { ids: ["r1"], status: "approved" }],
  ["a non-boolean permanent", { ids: ["r1"], status: "DECLINED", permanent: "yes" }],
] as const) {
  test(`batch with ${label} is 400 and transitions nothing`, async () => {
    const { token } = await manager();
    const owner = await mintSession();
    reqRows = [reqRow({ id: "r1", requestedBy: owner.userId })];
    const res = await doBatch(token, body);
    assert.equal(res.status, 400);
    assert.equal(reqRows[0].status, "PENDING");
  });
}

test("batch caps the id list at 100", async () => {
  const { token } = await manager();
  const ids = Array.from({ length: 101 }, (_, i) => `r${i}`);
  const res = await doBatch(token, { ids, status: "APPROVED" });
  assert.equal(res.status, 400);
});

test("batch accepts exactly 100 ids", async () => {
  const { token } = await manager();
  const ids = Array.from({ length: 100 }, (_, i) => `r${i}`);
  assert.equal((await doBatch(token, { ids, status: "APPROVED" })).status, 200);
});

test("PERMANENT declines are capped at 25, well below the general 100", async () => {
  // A terminal state that blocks re-requests; one click must not blast a hundred
  // users into it.
  const { token } = await manager();
  const ids = Array.from({ length: 26 }, (_, i) => `r${i}`);
  const res = await doBatch(token, { ids, status: "DECLINED", permanent: true });
  assert.equal(res.status, 400);
  assert.equal((await res.json()).error, "permanent-batch-too-large");
});

test("a NON-permanent decline of 26 is fine — the tighter cap is permanent-only", async () => {
  const { token } = await manager();
  const ids = Array.from({ length: 26 }, (_, i) => `r${i}`);
  assert.equal((await doBatch(token, { ids, status: "DECLINED" })).status, 200);
});

test("batch rejects an over-long adminNote", async () => {
  const { token } = await manager();
  const res = await doBatch(token, { ids: ["r1"], status: "DECLINED", adminNote: "x".repeat(1001) });
  assert.equal(res.status, 400);
});

test("batch is rate-limited per acting admin", async () => {
  const { token } = await manager();
  for (let i = 0; i < 10; i++) {
    assert.notEqual((await doBatch(token, { ids: ["nope"], status: "APPROVED" })).status, 429, `call ${i + 1}`);
  }
  assert.equal((await doBatch(token, { ids: ["nope"], status: "APPROVED" })).status, 429);
});

test("batch rejects a malformed body with 400", async () => {
  const { token } = await manager();
  assert.equal((await doBatch(token, undefined, "{nope")).status, 400);
});

// ── requests/[id] PATCH: the CAS and 409 ─────────────────────────────────────

test("single PATCH 404s an unknown id", async () => {
  const { token } = await manager();
  assert.equal((await doPatch(token, "nope", { status: "APPROVED" })).status, 404);
});

test("a normal approve transitions the row and stamps pendingNotifyAt", async () => {
  const { token } = await manager();
  const owner = await mintSession();
  reqRows = [reqRow({ id: "r1", requestedBy: owner.userId })];
  const res = await doPatch(token, "r1", { status: "APPROVED" });
  assert.equal(res.status, 200);
  assert.equal(reqRows[0].status, "APPROVED");
  assert.ok(reqRows[0].pendingNotifyAt instanceof Date);
});

test("the approve write carries a CAS predicate on the CURRENT status", async () => {
  // The transition-table check ran against a stale read, so two concurrent
  // admins could both pass it; the status predicate makes the write atomic.
  const { token } = await manager();
  const owner = await mintSession();
  reqRows = [reqRow({ id: "r1", requestedBy: owner.userId })];
  await doPatch(token, "r1", { status: "APPROVED" });
  const claim = opsOf("mediaRequest.updateMany")[0].args as { where: { id: string; status?: string } };
  assert.equal(claim.where.id, "r1");
  assert.equal(claim.where.status, "PENDING", "the CAS must pin the status it read");
});

test("a row that moved underneath the read yields 409, not a silent overwrite", async () => {
  const { token } = await manager();
  const owner = await mintSession();
  reqRows = [reqRow({ id: "r1", requestedBy: owner.userId })];
  // Simulate the concurrent move: the route reads PENDING, then the row flips.
  const realFindUnique = (prisma as unknown as { mediaRequest: { findUnique: unknown } }).mediaRequest.findUnique;
  let flipped = false;
  (prisma as unknown as { mediaRequest: Record<string, unknown> }).mediaRequest.findUnique = async (args: { where: { id: string } }) => {
    rec("mediaRequest.findUnique", args.where);
    const r = reqRows.find((x) => x.id === args.where.id);
    const snapshot = r ? { ...r } : null;
    if (r && !flipped) { flipped = true; r.status = "DECLINED"; } // moves after the read
    return snapshot;
  };
  const res = await doPatch(token, "r1", { status: "APPROVED" });
  assert.equal(res.status, 409);
  assert.match((await res.json()).error, /concurrently/i);
  (prisma as unknown as { mediaRequest: Record<string, unknown> }).mediaRequest.findUnique = realFindUnique;
});

test("marking AVAILABLE stamps availableAt and clears pendingNotifyAt", async () => {
  const { token } = await manager();
  const owner = await mintSession();
  reqRows = [reqRow({ id: "r1", requestedBy: owner.userId, status: "APPROVED", pendingNotifyAt: new Date() })];
  await doPatch(token, "r1", { status: "AVAILABLE" });
  assert.equal(reqRows[0].status, "AVAILABLE");
  assert.ok(reqRows[0].availableAt instanceof Date);
  assert.equal(reqRows[0].pendingNotifyAt, null);
});

test("single PATCH rejects an over-long adminNote and a bad qualityProfileId", async () => {
  const { token } = await manager();
  const owner = await mintSession();
  reqRows = [reqRow({ id: "r1", requestedBy: owner.userId })];
  assert.equal((await doPatch(token, "r1", { status: "DECLINED", adminNote: "x".repeat(1001) })).status, 400);
  for (const qp of [0, -1, 1.5, "1"]) {
    assert.equal((await doPatch(token, "r1", { status: "APPROVED", qualityProfileId: qp })).status, 400, `qp ${qp}`);
  }
});

// ── requests/[id] DELETE: ownership + race safety ────────────────────────────

test("DELETE 404s an unknown id", async () => {
  const { token } = await mintSession();
  assert.equal((await doDelete(token, "nope")).status, 404);
});

test("an OWNER may cancel their own PENDING request", async () => {
  const owner = await mintSession();
  reqRows = [reqRow({ id: "r1", requestedBy: owner.userId })];
  const res = await doDelete(owner.token, "r1");
  assert.equal(res.status, 200);
  assert.equal(reqRows.length, 0);
});

test("an owner may NOT cancel their own APPROVED request", async () => {
  // It has already been pushed to ARR; cancelling is an admin action.
  const owner = await mintSession();
  reqRows = [reqRow({ id: "r1", requestedBy: owner.userId, status: "APPROVED" })];
  const res = await doDelete(owner.token, "r1");
  assert.equal(res.status, 403);
  assert.equal(reqRows.length, 1);
});

test("a NON-owner without MANAGE_REQUESTS cannot delete someone else's request", async () => {
  const owner = await mintSession();
  const stranger = await mintSession();
  reqRows = [reqRow({ id: "r1", requestedBy: owner.userId })];
  const res = await doDelete(stranger.token, "r1");
  assert.equal(res.status, 403);
  assert.equal(reqRows.length, 1);
});

test("a MANAGE_REQUESTS holder may delete any request, in any status", async () => {
  const { token } = await manager();
  const owner = await mintSession();
  reqRows = [reqRow({ id: "r1", requestedBy: owner.userId, status: "AVAILABLE" })];
  assert.equal((await doDelete(token, "r1")).status, 200);
  assert.equal(reqRows.length, 0);
});

test("both DELETE branches use a GUARDED deleteMany, never a bare delete", async () => {
  // A concurrent removal between the stale read and the write would make a bare
  // delete throw P2025 → 500; deleteMany reports count 0 → 404.
  const owner = await mintSession();
  reqRows = [reqRow({ id: "r1", requestedBy: owner.userId })];
  await doDelete(owner.token, "r1");
  assert.equal(opsOf("mediaRequest.delete").length, 0);
  assert.ok(opsOf("mediaRequest.deleteMany").length > 0);

  ops = [];
  const { token } = await manager();
  const o2 = await mintSession();
  reqRows = [reqRow({ id: "r2", requestedBy: o2.userId })];
  await doDelete(token, "r2");
  assert.equal(opsOf("mediaRequest.delete").length, 0);
});

test("the owner self-cancel delete is scoped to owner AND still-PENDING", async () => {
  // An admin may have approved (and pushed to ARR) between the read and the
  // write; the scoped delete turns that race into a 404 rather than deleting an
  // approved row out from under the ARR push.
  const owner = await mintSession();
  reqRows = [reqRow({ id: "r1", requestedBy: owner.userId })];
  await doDelete(owner.token, "r1");
  const where = opsOf("mediaRequest.deleteMany")[0].args as Record<string, unknown>;
  assert.equal(where.requestedBy, owner.userId);
  assert.equal(where.status, "PENDING");
});

// ── quality-profiles ─────────────────────────────────────────────────────────

for (const bad of [undefined, "", "movie", "ANIME"]) {
  test(`quality-profiles rejects mediaType ${JSON.stringify(bad)}`, async () => {
    const { token } = await manager();
    const q = bad === undefined ? "" : `?mediaType=${encodeURIComponent(bad)}`;
    assert.equal((await doProfiles(token, q)).status, 400);
  });
}

for (const bad of ["Bad Slug", "UPPER", "with/slash"]) {
  test(`quality-profiles rejects the invalid instance slug ${JSON.stringify(bad)}`, async () => {
    const { token } = await manager();
    const res = await doProfiles(token, `?mediaType=MOVIE&instance=${encodeURIComponent(bad)}`);
    assert.equal(res.status, 400);
    assert.equal((await res.json()).error, "Invalid instance");
  });
}

test("quality-profiles routes MOVIE to radarr and TV to sonarr", async () => {
  const { token } = await manager();
  await doProfiles(token, "?mediaType=MOVIE");
  assert.ok(fetchCalls.some((c) => c.url.hostname === "10.0.0.2"), "MOVIE should hit radarr");
  fetchCalls.length = 0;
  await doProfiles(token, "?mediaType=TV");
  assert.ok(fetchCalls.some((c) => c.url.hostname === "10.0.0.3"), "TV should hit sonarr");
});

test("quality-profiles returns the profile list and the default id", async () => {
  const { token } = await manager();
  const body = await (await doProfiles(token, "?mediaType=MOVIE")).json();
  assert.deepEqual(body.qualityProfiles, [{ id: 1, name: "HD-1080p" }, { id: 2, name: "Ultra-HD" }]);
  assert.ok("defaultId" in body);
});

test("the legacy ?is4k=true shorthand selects the 4k instance", async () => {
  const { token } = await manager();
  settings.set("radarr4kUrl", "http://10.0.0.4:7878");
  settings.set("radarr4kApiKey", "radarr-4k-key");
  await doProfiles(token, "?mediaType=MOVIE&is4k=true");
  assert.ok(fetchCalls.some((c) => c.url.hostname === "10.0.0.4"));
});

test("an explicit ?instance= wins over the legacy ?is4k=", async () => {
  const { token } = await manager();
  await doProfiles(token, "?mediaType=MOVIE&instance=&is4k=true");
  assert.ok(fetchCalls.some((c) => c.url.hostname === "10.0.0.2"), "instance='' should select the default");
});

test("quality-profiles is 422 when the target instance is unconfigured", async () => {
  const { token } = await manager();
  settings.delete("radarrUrl");
  settings.delete("radarrApiKey");
  const res = await doProfiles(token, "?mediaType=MOVIE");
  assert.equal(res.status, 422);
  assert.match((await res.json()).error, /not configured/);
});

test("quality-profiles maps a connection failure to 502 without leaking the body", async () => {
  const { token } = await manager();
  profilesOk = false;
  const res = await doProfiles(token, "?mediaType=MOVIE");
  assert.equal(res.status, 502);
  assert.deepEqual(await res.json(), { error: "Could not connect to radarr" });
  assert.ok(errors.some((e) => e.includes("[requests/quality-profiles]")));
});

test("quality-profiles never echoes the arr API key", async () => {
  const { token } = await manager();
  const text = await (await doProfiles(token, "?mediaType=MOVIE")).text();
  assert.ok(!text.includes("radarr-key"));
});

// ── auditing ─────────────────────────────────────────────────────────────────

test("a batch transition is audited", async () => {
  const { token } = await manager();
  const owner = await mintSession();
  reqRows = [reqRow({ id: "r1", requestedBy: owner.userId })];
  await doBatch(token, { ids: ["r1"], status: "APPROVED" });
  await drainAfter();
  assert.ok(opsOf("auditLog.create").length > 0);
});

test("a single approve is audited with the before/after status", async () => {
  const { token } = await manager();
  const owner = await mintSession();
  reqRows = [reqRow({ id: "r1", requestedBy: owner.userId })];
  await doPatch(token, "r1", { status: "APPROVED" });
  await drainAfter();
  const data = (opsOf("auditLog.create")[0].args as { data: { action: string; details: string } }).data;
  assert.equal(data.action, "REQUEST_APPROVE");
  const details = JSON.parse(data.details);
  assert.equal(details.before.status, "PENDING");
  assert.equal(details.after.status, "APPROVED");
});

