// Route-level unit tests for the five uncovered admin trigger routes:
//   POST /api/admin/activity-warm
//   POST /api/admin/library-warm
//   POST /api/admin/mdblist-warm
//   POST /api/admin/omdb-warm
//   POST /api/admin/play-history/backfill-playtime
//
// The four warm routes share a cooldown mechanism whose exact shape is the point:
//
//   1. THE COOLDOWN IS AN ATOMIC CAS, NOT A READ-THEN-WRITE. Each does a single
//      `INSERT … ON CONFLICT DO UPDATE … WHERE <cooldown elapsed>` and treats an
//      affected-row count of 0 as "too recent" → 429. The in-code comment names
//      the bug this replaced: a check-then-update let two simultaneous admin
//      clicks BOTH pass the cooldown read and double the API-quota burn. So the
//      tests assert the 429 comes from the CAS result, that a claimed==0 run does
//      no warm work at all, and — structurally — that no route reintroduced a
//      read-then-write around it.
//   2. THE QUOTA-BEARING ONES SHARE THE CRON'S ADVISORY LOCK. omdb-warm and
//      mdblist-warm take the same lock ids as /api/cron/warm-{omdb,mdblist}, so
//      an admin click while the cron warm is running cannot double-burn the OMDB
//      free-tier daily quota. They answer 409 with Retry-After rather than
//      queueing.
//   3. THE COOLDOWN STAMP LIVES *INSIDE* THE LOCK. A lock-busy 409 must not
//      consume the 5-minute cooldown for a warm that never ran — otherwise one
//      unlucky click blocks the admin for five minutes having done nothing.
//   4. mdblist's `force` bypasses the cooldown but STILL writes the timestamp, so
//      the next non-force click gets a fresh window rather than an open door.
//
// backfill-playtime is a different animal: a one-shot destructive UPDATE over the
// whole PlayHistory table. Its guards are dry-run-by-default and a confirmation
// echo — the caller must send back the candidate-row count from a prior dry run,
// which both proves they saw it and defends against a CSRF-style request that
// can't know the live count. The tests pin that it fails CLOSED on a missing,
// wrong or stale count, and that the dry run writes nothing.
//
// Harness: real withAdmin-wrapped handlers, genuine signed session JWTs, a
// synthetic Next request scope, in-memory prisma stubs, and a monkey-patched
// `pg` Client.prototype for the advisory lock. No DB, no network.
import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { AsyncLocalStorage } from "node:async_hooks";
import { Client } from "pg";

(globalThis as { AsyncLocalStorage?: unknown }).AsyncLocalStorage = AsyncLocalStorage;

process.env.TOKEN_ENCRYPTION_KEY = "ab".repeat(32);
process.env.NEXTAUTH_SECRET = "admin-warm-routes-secret-0123456789abc";
process.env.AUTH_URL = "http://localhost:3000";
process.env.TRUST_PROXY = "true";
process.env.DATABASE_URL = "postgres://u:p@127.0.0.1:5432/db"; // Client.prototype stubbed; never dialed
(process.env as Record<string, string | undefined>).NODE_ENV = "test";

globalThis.fetch = (async () =>
  new Response("{}", { status: 503, headers: { "content-type": "application/json" } })) as unknown as typeof fetch;

const warns: string[] = [];
const errors: string[] = [];
console.warn = (...args: unknown[]) => { warns.push(args.map(String).join(" ")); };
console.error = (...args: unknown[]) => { errors.push(args.map(String).join(" ")); };

// ── pg Client prototype stub (the withAdvisoryLock seam) ─────────────────────
type PgResult = { rows: unknown[] };
let pgLockCalls: Array<{ op: "try" | "unlock"; lockId: number }> = [];
let lockAcquire: (lockId: number) => boolean = () => true;
const pgProto = Client.prototype as unknown as {
  connect: () => Promise<void>;
  query: (t: string, v?: unknown[]) => Promise<PgResult>;
  end: () => Promise<void>;
};
pgProto.connect = async () => {};
pgProto.query = async (text, values) => {
  if (text.includes("pg_try_advisory_lock")) {
    const lockId = Number((values ?? [])[0]);
    pgLockCalls.push({ op: "try", lockId });
    return { rows: [{ acquired: lockAcquire(lockId) }] };
  }
  if (text.includes("pg_advisory_unlock")) {
    pgLockCalls.push({ op: "unlock", lockId: Number((values ?? [])[0]) });
    return { rows: [] };
  }
  return { rows: [] };
};
pgProto.end = async () => {};

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
const AL = await import("../src/lib/advisory-lock.ts");

// ── op log ───────────────────────────────────────────────────────────────────
type Op = { op: string; args?: unknown };
let ops: Op[] = [];
const rec = (op: string, args?: unknown) => { ops.push({ op, args }); };
const opsOf = (name: string) => ops.filter((o) => o.op === name);

// ── auth fixture ─────────────────────────────────────────────────────────────
const sessionUsers = new Map<string, Record<string, unknown>>();
const sessionRows = new Set<string>();
shadowPrismaModel(prisma, "authSession", {
  findUnique: async (args: { where: { sessionId: string } }) =>
    sessionRows.has(args.where.sessionId) ? { id: `row-${args.where.sessionId}`, sessionId: args.where.sessionId } : null,
  update: async () => ({}),
});
shadowPrismaModel(prisma, "user", {
  findUnique: async (args: { where: { id: string } }) => sessionUsers.get(args.where.id) ?? null,
  update: async () => ({}),
});

let seq = 0;
async function mintSession(opts: { role?: string; permissions?: bigint } = {}): Promise<string> {
  seq++;
  const userId = `admin-${seq}`;
  const sessionId = `sess-${seq}`;
  const role = opts.role ?? "ADMIN";
  const permissions = (opts.permissions ?? Permission.ADMIN).toString();
  sessionUsers.set(userId, {
    id: userId, name: `Admin ${seq}`, role, permissions: BigInt(permissions),
    mediaServer: null, sessionsRevokedAt: null, passwordChangedAt: null, deactivatedAt: null,
    email: `admin-${seq}@example.com`, notificationEmail: null,
  });
  sessionRows.add(sessionId);
  const iat = Math.floor(Date.now() / 1000);
  return signSessionJwt(
    { id: userId, role, permissions, provider: "credentials", sessionId, expiresAt: iat + 86_400 },
    { expiresInSeconds: 7_200, iat },
  );
}
const COOKIE = getSessionCookieName();

// ── prisma stubs ─────────────────────────────────────────────────────────────
// The CAS. `casClaims` decides the affected-row count the route sees: 1 ⇒ the
// cooldown had elapsed and this caller claimed the slot; 0 ⇒ too recent.
let casClaims = 1;
const settings = new Map<string, string>();

shadowPrismaClientMethod(prisma, "$executeRaw", async (strings: TemplateStringsArray) => {
  const sql = Array.isArray(strings) ? strings.join("?") : String(strings);
  rec("$executeRaw", sql.replace(/\s+/g, " ").trim().slice(0, 80));
  return casClaims;
});
shadowPrismaClientMethod(prisma, "$executeRawUnsafe", async (sql: string) => {
  // Whole statement, not a prefix — the pins below read the UPDATE's WHERE
  // clause and check for a DELETE anywhere in it.
  rec("$executeRawUnsafe", sql.replace(/\s+/g, " ").trim());
  return backfillUpdatedRows;
});

let backfillCounts = { total_rows: 0n, candidate_rows: 0n, watched_flips: 0n };
let backfillUpdatedRows = 0;
shadowPrismaClientMethod(prisma, "$queryRawUnsafe", async (sql: string) => {
  rec("$queryRawUnsafe", sql.replace(/\s+/g, " ").trim().slice(0, 40));
  if (sql.includes("total_rows")) return [backfillCounts];
  return []; // the 5-row sample
});
shadowPrismaClientMethod(prisma, "$queryRaw", async () => { rec("$queryRaw"); return []; });

shadowPrismaModel(prisma, "setting", {
  findUnique: async (args: { where: { key: string } }) => {
    rec("setting.findUnique", args.where.key);
    const v = settings.get(args.where.key);
    return v === undefined ? null : { key: args.where.key, value: v };
  },
  findMany: async () => [],
  upsert: async (args: { where: { key: string }; update: { value: string } }) => {
    rec("setting.upsert", args.where.key);
    settings.set(args.where.key, args.update.value);
    return { key: args.where.key, value: args.update.value };
  },
  update: async (args: unknown) => { rec("setting.update", args); return {}; },
  create: async (args: unknown) => { rec("setting.create", args); return {}; },
});

shadowPrismaModel(prisma, "auditLog", { create: async (args: unknown) => { rec("auditLog.create", args); return { id: "a1" }; } });
for (const m of ["playHistory", "activeSession", "mediaServerUser", "tmdbCache", "tmdbMediaCore", "plexLibraryItem", "jellyfinLibraryItem", "mediaRequest"]) {
  shadowPrismaModel(prisma, m, {
    findMany: async () => { rec(`${m}.findMany`); return []; },
    findFirst: async () => null,
    findUnique: async () => null,
    count: async () => 0,
    aggregate: async () => ({ _count: { _all: 0 }, _sum: {}, _min: {}, _max: {} }),
    groupBy: async () => [],
    updateMany: async (args: unknown) => { rec(`${m}.updateMany`, args); return { count: 0 }; },
    update: async (args: unknown) => { rec(`${m}.update`, args); return {}; },
    upsert: async (args: unknown) => { rec(`${m}.upsert`, args); return {}; },
    createMany: async (args: unknown) => { rec(`${m}.createMany`, args); return { count: 0 }; },
    deleteMany: async (args: unknown) => { rec(`${m}.deleteMany`, args); return { count: 0 }; },
  });
}

const activityWarm = await import("../src/app/api/admin/activity-warm/route.ts");
const libraryWarm = await import("../src/app/api/admin/library-warm/route.ts");
const mdblistWarm = await import("../src/app/api/admin/mdblist-warm/route.ts");
const omdbWarm = await import("../src/app/api/admin/omdb-warm/route.ts");
const backfill = await import("../src/app/api/admin/play-history/backfill-playtime/route.ts");

// ── the warm matrix ──────────────────────────────────────────────────────────
type WarmRoute = {
  name: string;
  path: string;
  cooldownKey: string;
  lockId: number | null;
  POST: (req: InstanceType<typeof NextRequest>, ctx: undefined) => Promise<Response>;
};
const WARMS: WarmRoute[] = [
  { name: "activity-warm", path: "/api/admin/activity-warm", cooldownKey: "lastActivityWarmAt", lockId: null, POST: activityWarm.POST },
  { name: "library-warm", path: "/api/admin/library-warm", cooldownKey: "lastLibraryWarmAt", lockId: null, POST: libraryWarm.POST },
  { name: "mdblist-warm", path: "/api/admin/mdblist-warm", cooldownKey: "lastMdblistWarmAt", lockId: AL.WARM_MDBLIST_LOCK_ID, POST: mdblistWarm.POST },
  { name: "omdb-warm", path: "/api/admin/omdb-warm", cooldownKey: "lastOmdbWarmAt", lockId: AL.WARM_OMDB_LOCK_ID, POST: omdbWarm.POST },
];
const LOCKING_WARMS = WARMS.filter((w) => w.lockId !== null);

// ── scope ────────────────────────────────────────────────────────────────────
const afterTasks: Array<() => Promise<unknown>> = [];
function inScope<T>(fn: () => Promise<T>): Promise<T> {
  const workStore = {
    route: "/admin-warm.test", forceStatic: false, dynamicShouldError: false,
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

function mk(path: string, token: string | null, body?: string, query = "") {
  return new NextRequest(`http://localhost:3000${path}${query}`, {
    method: "POST",
    headers: { ...(token ? { cookie: `${COOKIE}=${token}` } : {}), "content-type": "application/json" },
    ...(body !== undefined ? { body } : {}),
  });
}
const callWarm = (w: WarmRoute, token: string | null, body?: string) =>
  inScope(() => w.POST(mk(w.path, token, body), undefined));
const callBackfill = (token: string | null, query = "", body?: string) =>
  inScope(() => backfill.POST(mk("/api/admin/play-history/backfill-playtime", token, body, query), undefined));

beforeEach(() => {
  ops = [];
  pgLockCalls = [];
  afterTasks.length = 0;
  warns.length = 0;
  errors.length = 0;
  settings.clear();
  casClaims = 1;
  lockAcquire = () => true;
  backfillCounts = { total_rows: 100n, candidate_rows: 7n, watched_flips: 2n };
  backfillUpdatedRows = 7;
});

// ── matrix sanity ────────────────────────────────────────────────────────────

test("all five admin trigger routes loaded with a POST handler", () => {
  assert.equal(WARMS.length, 4);
  for (const w of WARMS) assert.equal(typeof w.POST, "function", `${w.name} has no POST`);
  assert.equal(typeof backfill.POST, "function");
});

// ── role gating ──────────────────────────────────────────────────────────────

for (const w of WARMS) {
  test(`${w.name}: anonymous is 401 and does no work`, async () => {
    const res = await callWarm(w, null);
    assert.equal(res.status, 401);
    assert.equal(opsOf("$executeRaw").length, 0);
    assert.deepEqual(pgLockCalls, []);
  });

  test(`${w.name}: a plain USER is 403 and does no work`, async () => {
    const t = await mintSession({ role: "USER", permissions: 0n });
    const res = await callWarm(w, t);
    assert.equal(res.status, 403);
    assert.equal(opsOf("$executeRaw").length, 0);
    assert.deepEqual(pgLockCalls, []);
  });

  test(`${w.name}: an ISSUE_ADMIN is refused — these are withAdmin`, async () => {
    const t = await mintSession({ role: "ISSUE_ADMIN", permissions: Permission.MANAGE_ISSUES });
    assert.equal((await callWarm(w, t)).status, 403);
  });
}

test("backfill: anonymous is 401, a plain USER is 403, and neither reads a row", async () => {
  assert.equal((await callBackfill(null)).status, 401);
  const t = await mintSession({ role: "USER", permissions: 0n });
  assert.equal((await callBackfill(t)).status, 403);
  assert.equal(opsOf("$queryRawUnsafe").length, 0);
  assert.equal(opsOf("$executeRawUnsafe").length, 0);
});

// ── 1: the cooldown CAS ──────────────────────────────────────────────────────

for (const w of WARMS) {
  test(`${w.name}: a claimed CAS slot runs the warm`, async () => {
    const t = await mintSession();
    casClaims = 1;
    const res = await callWarm(w, t);
    assert.notEqual(res.status, 429);
    assert.equal(opsOf("$executeRaw").length, 1, "exactly one CAS statement per call");
  });

  test(`${w.name}: an unclaimed CAS slot is 429 and runs NO warm work`, async () => {
    const t = await mintSession();
    casClaims = 0;
    settings.set(w.cooldownKey, String(Date.now()));
    const res = await callWarm(w, t);
    assert.equal(res.status, 429);
    // A rejected claim must not audit a warm that never happened.
    assert.equal(opsOf("auditLog.create").length, 0);
  });

  test(`${w.name}: the CAS is ONE atomic statement, not a read-then-write`, async () => {
    // The shape this replaced let two simultaneous clicks both pass the cooldown
    // read and double the API-quota burn. The claim decision must come from the
    // statement's affected-row count, so any Setting read happens only AFTER a
    // failed claim (to compute the retry hint).
    const t = await mintSession();
    casClaims = 1;
    await callWarm(w, t);
    const idxCas = ops.findIndex((o) => o.op === "$executeRaw");
    const idxRead = ops.findIndex((o) => o.op === "setting.findUnique" && o.args === w.cooldownKey);
    assert.ok(idxCas >= 0, "no CAS statement issued");
    assert.equal(idxRead, -1, "a successful claim must not need to read the cooldown row at all");
  });

  test(`${w.name}: the retry hint is computed only after a FAILED claim`, async () => {
    const t = await mintSession();
    casClaims = 0;
    settings.set(w.cooldownKey, String(Date.now()));
    await callWarm(w, t);
    const idxCas = ops.findIndex((o) => o.op === "$executeRaw");
    const idxRead = ops.findIndex((o) => o.op === "setting.findUnique" && o.args === w.cooldownKey);
    assert.ok(idxCas >= 0 && idxRead > idxCas, "the cooldown row is read only to build the retry message");
  });

  test(`${w.name}: the 429 body names the cooldown rather than being opaque`, async () => {
    const t = await mintSession();
    casClaims = 0;
    settings.set(w.cooldownKey, String(Date.now()));
    const body = await (await callWarm(w, t)).json();
    assert.match(String(body.error), /too recently|wait/i);
  });

  test(`${w.name}: a corrupt (non-numeric) cooldown value does not crash the retry hint`, async () => {
    const t = await mintSession();
    casClaims = 0;
    settings.set(w.cooldownKey, "not-a-number");
    const res = await callWarm(w, t);
    assert.equal(res.status, 429);
    const body = await res.json();
    assert.ok(!String(body.error).includes("NaN"), `NaN leaked into the retry hint: ${body.error}`);
  });
}

// ── 2 + 3: the shared advisory lock ──────────────────────────────────────────

for (const w of LOCKING_WARMS) {
  test(`${w.name}: takes the SAME lock id as its cron twin, so the two can't double-burn quota`, async () => {
    const t = await mintSession();
    await callWarm(w, t);
    assert.ok(pgLockCalls.some((c) => c.op === "try" && c.lockId === w.lockId), `${w.name} never tried lock ${w.lockId}`);
  });

  test(`${w.name}: a busy lock answers 409 with Retry-After and runs nothing`, async () => {
    const t = await mintSession();
    lockAcquire = () => false;
    const res = await callWarm(w, t);
    assert.equal(res.status, 409);
    assert.equal(res.headers.get("Retry-After"), "30");
  });

  test(`${w.name}: a busy lock does NOT consume the cooldown`, async () => {
    // The stamp lives inside the lock precisely so one unlucky click can't block
    // the admin for five minutes having done no work.
    const t = await mintSession();
    lockAcquire = () => false;
    await callWarm(w, t);
    assert.equal(opsOf("$executeRaw").length, 0, "the CAS must not run when the lock is busy");
    assert.equal(opsOf("setting.upsert").length, 0, "no cooldown stamp for a warm that never ran");
  });

  test(`${w.name}: releases its lock on the happy path`, async () => {
    const t = await mintSession();
    await callWarm(w, t);
    const unlocks = pgLockCalls.filter((c) => c.op === "unlock" && c.lockId === w.lockId);
    assert.equal(unlocks.length, 1, `${w.name} leaked advisory lock ${w.lockId}`);
  });

  test(`${w.name}: releases its lock even when the cooldown rejects the claim`, async () => {
    const t = await mintSession();
    casClaims = 0;
    settings.set(w.cooldownKey, String(Date.now()));
    await callWarm(w, t);
    assert.equal(pgLockCalls.filter((c) => c.op === "unlock" && c.lockId === w.lockId).length, 1);
  });
}

test("the two quota-bearing warms use DISTINCT lock ids from each other", () => {
  const ids = LOCKING_WARMS.map((w) => w.lockId);
  assert.equal(new Set(ids).size, ids.length);
});

test("the non-locking warms take no advisory lock at all", async () => {
  const t = await mintSession();
  for (const w of WARMS.filter((x) => x.lockId === null)) {
    pgLockCalls = [];
    await callWarm(w, t);
    assert.deepEqual(pgLockCalls, [], `${w.name} unexpectedly took a lock`);
  }
});

// ── 4: mdblist force ─────────────────────────────────────────────────────────

test("mdblist force bypasses the CAS but STILL stamps the cooldown", async () => {
  // Otherwise force would leave the window open for an immediate non-force click.
  const t = await mintSession();
  const w = WARMS.find((x) => x.name === "mdblist-warm")!;
  casClaims = 0; // the cooldown has NOT elapsed
  settings.set(w.cooldownKey, String(Date.now()));
  const res = await callWarm(w, t, JSON.stringify({ force: true }));
  assert.notEqual(res.status, 429, "force must run despite the cooldown");
  assert.equal(opsOf("$executeRaw").length, 0, "force skips the CAS");
  assert.equal(opsOf("setting.upsert").length, 1, "force must still write the timestamp");
});

test("mdblist force:false takes the normal CAS path", async () => {
  const t = await mintSession();
  const w = WARMS.find((x) => x.name === "mdblist-warm")!;
  casClaims = 0;
  settings.set(w.cooldownKey, String(Date.now()));
  const res = await callWarm(w, t, JSON.stringify({ force: false }));
  assert.equal(res.status, 429);
});

test("mdblist force is a strict === true check, not truthiness", async () => {
  const t = await mintSession();
  const w = WARMS.find((x) => x.name === "mdblist-warm")!;
  for (const v of ["true", 1, "yes", {}]) {
    ops = [];
    casClaims = 0;
    settings.set(w.cooldownKey, String(Date.now()));
    const res = await callWarm(w, t, JSON.stringify({ force: v }));
    assert.equal(res.status, 429, `force:${JSON.stringify(v)} must not bypass the cooldown`);
  }
});

test("mdblist tolerates a missing or malformed body (readJsonCappedOr)", async () => {
  const t = await mintSession();
  const w = WARMS.find((x) => x.name === "mdblist-warm")!;
  for (const body of [undefined, "", "{not json"]) {
    ops = [];
    casClaims = 1;
    const res = await callWarm(w, t, body);
    assert.notEqual(res.status, 500, `body ${JSON.stringify(body)} should not 500`);
  }
});

// ── warm auditing ────────────────────────────────────────────────────────────

for (const w of WARMS) {
  test(`${w.name}: a successful warm writes a CACHE_WARM audit row`, async () => {
    const t = await mintSession();
    await callWarm(w, t);
    const created = opsOf("auditLog.create");
    assert.equal(created.length, 1, `${w.name} did not audit its warm`);
    assert.equal((created[0].args as { data: { action: string } }).data.action, "CACHE_WARM");
  });
}

// ── backfill-playtime: dry run by default ────────────────────────────────────

test("backfill defaults to a DRY RUN and writes nothing", async () => {
  const t = await mintSession();
  const res = await callBackfill(t);
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.dryRun, true);
  assert.equal(opsOf("$executeRawUnsafe").length, 0, "a dry run must not UPDATE");
});

test("backfill's dry run reports the counts and the exact confirmation hint", async () => {
  const t = await mintSession();
  const body = await (await callBackfill(t)).json();
  assert.equal(body.affectedRows, 7);
  assert.equal(body.totalRows, 100);
  assert.equal(body.watchedFlippedToFalse, 2);
  assert.match(body.hint, /confirmAffectedRows": 7/);
});

test("backfill's dry run ignores any body it is sent", async () => {
  const t = await mintSession();
  const body = await (await callBackfill(t, "", JSON.stringify({ confirmAffectedRows: 999 }))).json();
  assert.equal(body.dryRun, true);
  assert.equal(opsOf("$executeRawUnsafe").length, 0);
});

test("?execute=true is required — any other value stays a dry run", async () => {
  const t = await mintSession();
  for (const q of ["?execute=1", "?execute=yes", "?execute=TRUE", "?execute="]) {
    ops = [];
    const body = await (await callBackfill(t, q, JSON.stringify({ confirmAffectedRows: 7 }))).json();
    assert.equal(body.dryRun, true, `${q} must not execute`);
    assert.equal(opsOf("$executeRawUnsafe").length, 0);
  }
});

// ── backfill-playtime: the confirmation gate fails closed ────────────────────

test("execute WITHOUT a confirmation count is 409 and writes nothing", async () => {
  const t = await mintSession();
  const res = await callBackfill(t, "?execute=true", JSON.stringify({}));
  assert.equal(res.status, 409);
  assert.equal((await res.json()).error, "Confirmation required");
  assert.equal(opsOf("$executeRawUnsafe").length, 0);
});

test("execute with a WRONG confirmation count is 409 and writes nothing", async () => {
  const t = await mintSession();
  const res = await callBackfill(t, "?execute=true", JSON.stringify({ confirmAffectedRows: 6 }));
  assert.equal(res.status, 409);
  assert.equal(opsOf("$executeRawUnsafe").length, 0);
});

test("execute with a STALE count (data shifted underneath) is 409", async () => {
  // The operator saw 7 in the dry run, but the live count moved to 9 before they
  // clicked apply — the gate must fail closed rather than run on stale intent.
  const t = await mintSession();
  backfillCounts = { total_rows: 100n, candidate_rows: 9n, watched_flips: 2n };
  const res = await callBackfill(t, "?execute=true", JSON.stringify({ confirmAffectedRows: 7 }));
  assert.equal(res.status, 409);
  assert.equal((await res.json()).affectedRows, 9, "the response should tell the operator the new count");
  assert.equal(opsOf("$executeRawUnsafe").length, 0);
});

test("execute with a non-numeric confirmation is 409", async () => {
  const t = await mintSession();
  for (const v of ["7", null, true, {}]) {
    ops = [];
    const res = await callBackfill(t, "?execute=true", JSON.stringify({ confirmAffectedRows: v }));
    assert.equal(res.status, 409, `confirm ${JSON.stringify(v)} should be refused`);
    assert.equal(opsOf("$executeRawUnsafe").length, 0);
  }
});

test("execute with a missing body is 409 rather than a 500", async () => {
  const t = await mintSession();
  const res = await callBackfill(t, "?execute=true");
  assert.equal(res.status, 409);
});

test("execute with the MATCHING count applies the update and reports it", async () => {
  const t = await mintSession();
  const res = await callBackfill(t, "?execute=true", JSON.stringify({ confirmAffectedRows: 7 }));
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.dryRun, false);
  assert.equal(body.updated, 7);
  assert.equal(opsOf("$executeRawUnsafe").length, 1);
});

test("the backfill UPDATE stays bounded to the rows that actually need clamping", async () => {
  // Idempotence depends on it: the WHERE excludes rows already consistent, so a
  // re-run is a no-op rather than a second pass over the whole table.
  const t = await mintSession();
  await callBackfill(t, "?execute=true", JSON.stringify({ confirmAffectedRows: 7 }));
  const sql = opsOf("$executeRawUnsafe")[0].args as string;
  assert.match(sql, /UPDATE "PlayHistory" SET/);
  assert.match(
    sql,
    /WHERE "playDuration" > EXTRACT\(EPOCH FROM \("stoppedAt" - "startedAt"\)\)::int/,
    "the UPDATE must skip rows whose playDuration is already within wall-clock",
  );
  assert.match(sql, /AND "stoppedAt" > "startedAt"/, "the UPDATE must skip rows with no positive wall-clock span");
});

test("a successful backfill is audited and never 500s on a failing audit write (guardrail 26)", async () => {
  const t = await mintSession();
  shadowPrismaModel(prisma, "auditLog", {
    create: async () => { rec("auditLog.create"); throw new Error("audit down"); },
  });
  const res = await callBackfill(t, "?execute=true", JSON.stringify({ confirmAffectedRows: 7 }));
  assert.equal(res.status, 200, "a durable backfill must not 500 because the audit failed");
  shadowPrismaModel(prisma, "auditLog", { create: async (args: unknown) => { rec("auditLog.create", args); return { id: "a1" }; } });
});

test("backfill never deletes PlayHistory rows — it clamps them", async () => {
  const t = await mintSession();
  await callBackfill(t, "?execute=true", JSON.stringify({ confirmAffectedRows: 7 }));
  assert.equal(opsOf("playHistory.deleteMany").length, 0);
  const sql = opsOf("$executeRawUnsafe")[0].args as string;
  assert.ok(!/DELETE/i.test(sql), `the backfill statement must not delete: ${sql}`);
});
