// Route-level unit tests for all eleven POST /api/cron/* handlers:
//   purge-auth-sessions, scrub-audit-pii, sync-download-policies,
//   trash-diagnostic, trash-sync, warm-activity, warm-library,
//   warm-list-cache, warm-mdblist, warm-omdb, warm-recommendations
//
// These are the internet-facing entry points the container's own cron loop
// POSTs to with `Bearer ${CRON_SECRET}`, and they do the destructive
// housekeeping (session purge, audit-log deletion, PII scrub). They share one
// gate and one concurrency primitive, so the file is organized as a MATRIX over
// all ten rather than ten near-identical suites — which is also what makes it
// catch the regression that actually matters here: a NEW cron route, or an
// edited one, that quietly stops enforcing the shared invariant.
//
// The invariants, and why each is load-bearing:
//
//   1. isCronAuthorized ON EVERY ROUTE (guardrail 6). No route may re-implement
//      a CRON_SECRET check inline, and every one must reject before doing any
//      work. The matrix asserts unauthorized ⇒ 401 AND zero writes/locks for
//      all ten, so an added route with a forgotten gate fails here.
//   2. THE SECRET IS COMPARED, NOT MERELY PRESENT. A wrong secret, a prefix of
//      the real one, an empty bearer, and the secret in the wrong header or as
//      a query param all fail — the last one because these routes deliberately
//      do NOT take the ?token= fallback the Radarr/Sonarr webhooks need
//      (guardrail 2 is about those two handlers only).
//   3. THE ADVISORY LOCK IS HONORED. Every locking route returns the
//      `{skipped:true, reason:"already running"}` shape on a busy lock instead
//      of running concurrently, and RELEASES the lock afterwards — a leaked
//      lock wedges that job until the process restarts. Lock ids must also be
//      distinct per job, or two unrelated crons serialize against each other.
//   4. THE DESTRUCTIVE ROUTES ARE CUTOFF-BOUNDED. purge-auth-sessions and
//      scrub-audit-pii issue deleteMany/updateMany against the live tables, so
//      the tests pin that every delete carries a date predicate — an unbounded
//      deleteMany here erases the whole audit log.
//   5. purge-auth-sessions IS FAILURE-ISOLATED. Its ten deletes run under
//      Promise.allSettled and it reports a NON-2xx when any leg fails, so
//      withCronRunRecording marks the run failed while the body still carries
//      the counts that did succeed.
//
// Harness: real handlers invoked with a NextRequest, over in-memory prisma stubs
// and a monkey-patched `pg` Client.prototype (the tests/advisory-lock.test.mts /
// sync-orchestrator-route.test.mts seam) so the REAL lock control flow runs with
// zero network. No DB, no network.
import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { Client } from "pg";

process.env.TOKEN_ENCRYPTION_KEY = "ab".repeat(32);
process.env.NEXTAUTH_SECRET = "cron-routes-test-secret-0123456789abcdef";
process.env.AUTH_URL = "http://localhost:3000";
process.env.TRUST_PROXY = "true";
process.env.DATABASE_URL = "postgres://u:p@127.0.0.1:5432/db"; // Client.prototype is stubbed; never dialed
const CRON_SECRET = "cron-routes-cron-secret-0123456789abcdef"; // >=32 chars, boot-shaped
process.env.CRON_SECRET = CRON_SECRET;
process.env.TMDB_READ_TOKEN = "cron-routes-tmdb-token"; // warm-library's tmdbAuth() gate
(process.env as Record<string, string | undefined>).NODE_ENV = "test";

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
  query: (text: string, values?: unknown[]) => Promise<PgResult>;
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

// No network from any warm job.
const fetchCalls: URL[] = [];
globalThis.fetch = (async (input: RequestInfo | URL) => {
  const url = new URL(String(input));
  fetchCalls.push(url);
  // Every warm job tolerates an upstream failure; returning 503 keeps them from
  // reaching a real host while still exercising their error handling.
  return new Response("{}", { status: 503, headers: { "content-type": "application/json" } });
}) as unknown as typeof fetch;

const { NextRequest } = await import("next/server");
const { prisma } = await import("../src/lib/prisma.ts");
const { shadowPrismaModel, shadowPrismaClientMethod } = await import("./_helpers.mts");

// ── op log ───────────────────────────────────────────────────────────────────
type Op = { op: string; args?: unknown };
let ops: Op[] = [];
const rec = (op: string, args?: unknown) => { ops.push({ op, args }); };
const opsOf = (name: string) => ops.filter((o) => o.op === name);

// "Did the job actually do work?" — deliberately EXCLUDES the `cron:lastRun:*`
// bookkeeping upsert that withCronRunRecording writes. That row records a run
// was ATTEMPTED, so it is written even on a busy-lock skip; counting it as work
// would make the busy-lock assertions unwritable.
const CRON_BOOKKEEPING = /^cron:lastRun:/;
function isBookkeeping(o: Op): boolean {
  if (o.op !== "setting.upsert" && o.op !== "setting.update") return false;
  const key = (o.args as { where?: { key?: string } } | undefined)?.where?.key ?? "";
  return CRON_BOOKKEEPING.test(key);
}
const writeOps = () =>
  ops.filter((o) => /(deleteMany|updateMany|create|upsert|update)$/.test(o.op) && !isBookkeeping(o));

// ── prisma stubs ─────────────────────────────────────────────────────────────
// A deleteMany/updateMany stub that records its `where` so the cutoff-bounded
// assertions can inspect the predicate.
function counter(model: string) {
  return {
    deleteMany: async (args: { where?: unknown } = {}) => {
      rec(`${model}.deleteMany`, args.where);
      return { count: 0 };
    },
    updateMany: async (args: { where?: unknown; data?: unknown } = {}) => {
      rec(`${model}.updateMany`, args.where);
      return { count: 0 };
    },
    findMany: async () => { rec(`${model}.findMany`); return []; },
    findUnique: async () => { rec(`${model}.findUnique`); return null; },
    findFirst: async () => { rec(`${model}.findFirst`); return null; },
    count: async () => { rec(`${model}.count`); return 0; },
    create: async (args: unknown) => { rec(`${model}.create`, args); return { id: "x" }; },
    upsert: async (args: unknown) => { rec(`${model}.upsert`, args); return { id: "x" }; },
    update: async (args: unknown) => { rec(`${model}.update`, args); return { id: "x" }; },
    createMany: async (args: unknown) => { rec(`${model}.createMany`, args); return { count: 0 }; },
    aggregate: async () => ({ _count: { _all: 0 }, _sum: {}, _min: {}, _max: {} }),
    groupBy: async () => [],
  };
}

for (const model of [
  "authSession", "discordLinkToken", "discordMergeCode", "discordSearchCache",
  "webhookReplay", "plexTokenCache", "tmdbMediaCore", "ipLookupCache", "auditLog",
  "user", "mediaServerUser", "playHistory", "activeSession", "tmdbCache",
  "cronRun", "trashApplication", "trashSpec", "mediaRequest", "plexLibraryItem",
  "jellyfinLibraryItem", "notification", "pushSubscription", "deletionVote", "issue",
]) {
  shadowPrismaModel(prisma, model, counter(model));
}

// `setting` needs real read-back so the warm jobs' "is this provider configured"
// guards can be steered per test.
const settings = new Map<string, string>();
shadowPrismaModel(prisma, "setting", {
  findUnique: async (args: { where: { key: string } }) => {
    rec("setting.findUnique", args.where.key);
    const v = settings.get(args.where.key);
    return v === undefined ? null : { key: args.where.key, value: v };
  },
  findFirst: async () => null,
  findMany: async (args: { where?: { key?: { in?: string[] } } } = {}) => {
    rec("setting.findMany", args.where);
    const keys = args.where?.key?.in;
    const all = [...settings.entries()].map(([key, value]) => ({ key, value }));
    return keys ? all.filter((r) => keys.includes(r.key)) : all;
  },
  upsert: async (args: unknown) => { rec("setting.upsert", args); return { id: "x" }; },
  update: async (args: unknown) => { rec("setting.update", args); return { id: "x" }; },
  create: async (args: unknown) => { rec("setting.create", args); return { id: "x" }; },
  createMany: async (args: unknown) => { rec("setting.createMany", args); return { count: 1 }; },
  deleteMany: async (args: unknown) => { rec("setting.deleteMany", args); return { count: 0 }; },
});

shadowPrismaClientMethod(prisma, "$queryRawUnsafe", async () => { rec("$queryRawUnsafe"); return []; });
shadowPrismaClientMethod(prisma, "$queryRaw", async () => { rec("$queryRaw"); return []; });
shadowPrismaClientMethod(prisma, "$executeRawUnsafe", async () => { rec("$executeRawUnsafe"); return 0; });
shadowPrismaClientMethod(prisma, "$transaction", async (arg: unknown) => {
  rec("$transaction");
  if (Array.isArray(arg)) return Promise.all(arg);
  return (arg as (tx: unknown) => Promise<unknown>)(prisma);
});

// ── the route matrix ─────────────────────────────────────────────────────────
// `lockId` is the advisory lock each route takes (null = takes no lock).
type CronRoute = {
  name: string;
  path: string;
  lockId: number | null;
  POST: (req: InstanceType<typeof NextRequest>) => Promise<Response>;
};

async function load(name: string, lockId: number | null): Promise<CronRoute> {
  const mod = await import(`../src/app/api/cron/${name}/route.ts`);
  return { name, path: `/api/cron/${name}`, lockId, POST: mod.POST };
}

// Lock ids are read from advisory-lock.ts where exported, so a renumbering
// there updates the expectation rather than silently diverging from it.
const AL = await import("../src/lib/advisory-lock.ts");

const ROUTES: CronRoute[] = [
  await load("purge-auth-sessions", 2001),
  await load("scrub-audit-pii", 2002),
  await load("sync-download-policies", 2009),
  await load("trash-diagnostic", null),
  await load("trash-sync", AL.TRASH_SYNC_LOCK_ID),
  await load("warm-activity", null),
  await load("warm-library", AL.WARM_LIBRARY_LOCK_ID),
  await load("warm-list-cache", null),
  await load("warm-mdblist", AL.WARM_MDBLIST_LOCK_ID),
  await load("warm-omdb", AL.WARM_OMDB_LOCK_ID),
  await load("warm-recommendations", AL.WARM_RECOMMENDATIONS_LOCK_ID),
];

const LOCKING = ROUTES.filter((r) => r.lockId !== null);

function req(route: CronRoute, headers: Record<string, string> = {}, query = ""): InstanceType<typeof NextRequest> {
  return new NextRequest(`http://localhost:3000${route.path}${query}`, { method: "POST", headers });
}

const authed = (route: CronRoute) => req(route, { authorization: `Bearer ${CRON_SECRET}` });

beforeEach(() => {
  ops = [];
  pgLockCalls = [];
  fetchCalls.length = 0;
  warns.length = 0;
  errors.length = 0;
  settings.clear();
  // The two provider-gated warm jobs short-circuit BEFORE their lock when
  // unconfigured, so the shared lock assertions need them configured. The
  // dedicated unconfigured-skip tests clear these again.
  settings.set("omdbApiKey", "an-omdb-key");
  settings.set("mdblistApiKey", "an-mdblist-key");
  lockAcquire = () => true;
});

// ── the matrix itself must not pass vacuously ────────────────────────────────

test("all eleven cron routes loaded and expose a POST handler", () => {
  assert.equal(ROUTES.length, 11);
  for (const r of ROUTES) assert.equal(typeof r.POST, "function", `${r.name} has no POST`);
});

test("the matrix covers every cron route on disk — a new one must be added here", async () => {
  const { readdirSync } = await import("node:fs");
  const onDisk = readdirSync("src/app/api/cron", { withFileTypes: true })
    .filter((e) => e.isDirectory())
    .map((e) => e.name)
    .sort();
  assert.deepEqual(ROUTES.map((r) => r.name).sort(), onDisk);
});

// ── 1 + 2: the shared auth gate (guardrail 6) ────────────────────────────────

for (const route of ROUTES) {
  test(`${route.name}: an unauthenticated POST is 401 and does no work`, async () => {
    const res = await route.POST(req(route));
    assert.equal(res.status, 401);
    assert.equal((await res.json()).error, "Unauthorized");
    assert.deepEqual(writeOps(), [], `${route.name} wrote before authorizing`);
    assert.deepEqual(pgLockCalls, [], `${route.name} took a lock before authorizing`);
    assert.deepEqual(fetchCalls, [], `${route.name} hit the network before authorizing`);
  });
}

for (const route of ROUTES) {
  test(`${route.name}: a WRONG bearer secret is 401`, async () => {
    const res = await route.POST(req(route, { authorization: "Bearer not-the-secret-0123456789abcdefgh" }));
    assert.equal(res.status, 401);
    assert.deepEqual(pgLockCalls, []);
  });
}

for (const route of ROUTES) {
  test(`${route.name}: a PREFIX of the real secret is 401 — the compare is not a startsWith`, async () => {
    const res = await route.POST(req(route, { authorization: `Bearer ${CRON_SECRET.slice(0, -1)}` }));
    assert.equal(res.status, 401);
  });
}

for (const route of ROUTES) {
  test(`${route.name}: the secret as a ?token= query param is 401 — that fallback is webhooks-only`, async () => {
    // Guardrail 2's query-string fallback exists because the Sonarr/Radarr
    // webhook UIs have no header field. Cron callers always can set a header,
    // so accepting ?token= here would put the secret in access logs for nothing.
    const res = await route.POST(req(route, {}, `?token=${CRON_SECRET}`));
    assert.equal(res.status, 401);
    assert.deepEqual(pgLockCalls, []);
  });
}

for (const route of ROUTES) {
  test(`${route.name}: an empty bearer is 401`, async () => {
    assert.equal((await route.POST(req(route, { authorization: "Bearer " }))).status, 401);
  });
}

test("the secret in a non-Authorization header is refused", async () => {
  for (const route of ROUTES) {
    for (const header of ["x-cron-secret", "x-api-key", "authentication"]) {
      const res = await route.POST(req(route, { [header]: `Bearer ${CRON_SECRET}` }));
      assert.equal(res.status, 401, `${route.name} accepted the secret in ${header}`);
    }
  }
});

test("a Basic-auth style credential carrying the secret is refused", async () => {
  const basic = Buffer.from(`cron:${CRON_SECRET}`).toString("base64");
  for (const route of ROUTES) {
    assert.equal((await route.POST(req(route, { authorization: `Basic ${basic}` }))).status, 401);
  }
});

for (const route of ROUTES) {
  test(`${route.name}: a valid bearer secret is accepted`, async () => {
    const res = await route.POST(authed(route));
    assert.notEqual(res.status, 401, `${route.name} rejected a valid CRON_SECRET`);
  });
}

// ── 3: the advisory lock ─────────────────────────────────────────────────────

for (const route of LOCKING) {
  test(`${route.name}: a BUSY lock returns the skipped shape instead of running`, async () => {
    lockAcquire = () => false;
    const res = await route.POST(authed(route));
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), { skipped: true, reason: "already running" });
    assert.deepEqual(writeOps(), [], `${route.name} did work while another run held the lock`);
  });
}

for (const route of LOCKING) {
  test(`${route.name}: takes lock ${route.lockId} and RELEASES it`, async () => {
    await route.POST(authed(route));
    const tries = pgLockCalls.filter((c) => c.op === "try");
    assert.ok(tries.some((c) => c.lockId === route.lockId), `${route.name} never tried lock ${route.lockId}`);
    const unlocks = pgLockCalls.filter((c) => c.op === "unlock" && c.lockId === route.lockId);
    assert.equal(unlocks.length, 1, `${route.name} leaked advisory lock ${route.lockId}`);
  });
}

test("a busy lock is not unlocked — releasing another run's lock would let two run at once", async () => {
  lockAcquire = () => false;
  for (const route of LOCKING) {
    pgLockCalls = [];
    await route.POST(authed(route));
    assert.deepEqual(pgLockCalls.filter((c) => c.op === "unlock"), [], `${route.name} unlocked a lock it never held`);
  }
});

test("every locking cron job uses a DISTINCT lock id", () => {
  const ids = LOCKING.map((r) => r.lockId);
  assert.equal(new Set(ids).size, ids.length, `duplicate cron lock ids: ${ids.join(", ")}`);
});

test("no cron lock id collides with the sync orchestrator's lock 2000", () => {
  assert.ok(!LOCKING.some((r) => r.lockId === 2000), "a cron job would serialize against /api/sync");
});

// ── 4: the destructive routes are cutoff-bounded ─────────────────────────────

const purge = ROUTES.find((r) => r.name === "purge-auth-sessions")!;
const scrub = ROUTES.find((r) => r.name === "scrub-audit-pii")!;

test("purge-auth-sessions: EVERY delete carries a date predicate — none is unbounded", async () => {
  await purge.POST(authed(purge));
  const deletes = ops.filter((o) => o.op.endsWith(".deleteMany") && o.op !== "setting.deleteMany");
  assert.ok(deletes.length >= 9, `expected the full purge fan-out, saw ${deletes.length}`);
  for (const d of deletes) {
    const where = d.args as Record<string, unknown> | undefined;
    assert.ok(where && Object.keys(where).length > 0, `${d.op} ran with no where clause — that empties the table`);
    const json = JSON.stringify(where);
    assert.ok(
      /"(lt|gt|lte|gte)"/.test(json),
      `${d.op} has no date bound: ${json}`,
    );
  }
});

test("purge-auth-sessions: the AuthSession sweep is `expiresAt < now`, so a native session's never-expires sentinel is never swept", async () => {
  // A native (iOS) session's AuthSession.expiresAt is the far-future sentinel
  // from session-lifetime.ts (guardrail 6c) — the row is the session's only
  // revocation anchor, and the only housekeeping that may delete it is this
  // expiry sweep. Pin the predicate's SHAPE: a bound on expiresAt, strictly
  // below the sentinel. A "sessions older than N days" sweep on createdAt /
  // lastSeenAt would sign every iOS user out on the first nightly run.
  const { NEVER_EXPIRES_AT_MS } = await import("../src/lib/session-lifetime.ts");
  await purge.POST(authed(purge));
  const [sweep] = opsOf("authSession.deleteMany");
  const where = sweep.args as { expiresAt?: { lt?: Date }; createdAt?: unknown; lastSeenAt?: unknown };
  assert.ok(where.expiresAt?.lt instanceof Date, `the AuthSession sweep must bound expiresAt with lt: ${JSON.stringify(where)}`);
  assert.ok(where.expiresAt.lt.getTime() < NEVER_EXPIRES_AT_MS, "the cutoff must sit below the never-expires sentinel");
  assert.equal(where.createdAt, undefined, "no age-based sweep on createdAt");
  assert.equal(where.lastSeenAt, undefined, "no idle-based sweep on lastSeenAt");
});

test("purge-auth-sessions: sweeps every table the job claims to, and only those", async () => {
  await purge.POST(authed(purge));
  const swept = ops.filter((o) => o.op.endsWith(".deleteMany")).map((o) => o.op.replace(".deleteMany", "")).sort();
  assert.deepEqual(swept, [
    "auditLog", "authSession", "discordLinkToken", "discordMergeCode",
    "discordSearchCache", "ipLookupCache", "plexTokenCache", "plexTokenCache",
    "tmdbMediaCore", "webhookReplay",
  ]);
});

test("purge-auth-sessions: the audit-log cutoff is far longer than the PII-scrub cutoff", async () => {
  // Row DELETION at 365d must not outrun PII SCRUBBING at 90d, or rows would be
  // destroyed before the scrub had a chance to redact them.
  await purge.POST(authed(purge));
  const auditDelete = opsOf("auditLog.deleteMany")[0].args as { createdAt: { lt: Date } };
  const ageDays = (Date.now() - auditDelete.createdAt.lt.getTime()) / 86_400_000;
  assert.ok(ageDays > 300 && ageDays < 400, `audit deletion cutoff is ${ageDays.toFixed(0)}d, expected ~365d`);
});

test("purge-auth-sessions: the legacy Plex-token sweep is bounded by verifiedAt, not just a null check", async () => {
  await purge.POST(authed(purge));
  const legacy = opsOf("plexTokenCache.deleteMany")
    .map((o) => o.args as Record<string, unknown>)
    .find((w) => w.expiresAt === null);
  assert.ok(legacy, "the legacy (expiresAt:null) sweep is missing");
  assert.ok(legacy.verifiedAt, "the legacy sweep must be age-bounded or it deletes every legacy row");
});

test("scrub-audit-pii: the scrub is cutoff-bounded and redacts all three PII columns", async () => {
  await scrub.POST(authed(scrub));
  const updates = opsOf("auditLog.updateMany");
  assert.ok(updates.length >= 1);
  for (const u of updates) {
    const where = u.args as { createdAt?: { lt?: Date } };
    assert.ok(where.createdAt?.lt instanceof Date, "the scrub must be bounded by createdAt");
    const ageDays = (Date.now() - where.createdAt.lt.getTime()) / 86_400_000;
    assert.ok(ageDays > 80 && ageDays < 100, `scrub cutoff is ${ageDays.toFixed(0)}d, expected ~90d`);
  }
});

test("scrub-audit-pii: it UPDATES rather than deletes — the audit trail survives redaction", async () => {
  await scrub.POST(authed(scrub));
  assert.equal(opsOf("auditLog.deleteMany").length, 0, "the PII scrub must never delete audit rows");
  assert.ok(opsOf("auditLog.updateMany").length > 0);
});

test("scrub-audit-pii: the auth-details clear is narrowed to the login-event actions", async () => {
  await scrub.POST(authed(scrub));
  const actions = opsOf("auditLog.updateMany")
    .map((o) => (o.args as { action?: { in?: string[] } }).action?.in)
    .find((list): list is string[] => Array.isArray(list));
  assert.ok(actions, "the auth-details pass is missing");
  assert.deepEqual([...actions].sort(), ["AUTH_LOGIN", "AUTH_LOGIN_FAILED", "AUTH_LOGOUT"]);
});

// ── 5: purge-auth-sessions failure isolation ─────────────────────────────────

test("purge-auth-sessions: one failing delete does NOT abort the other nine", async () => {
  shadowPrismaModel(prisma, "webhookReplay", {
    ...counter("webhookReplay"),
    deleteMany: async () => {
      rec("webhookReplay.deleteMany");
      throw new Error("simulated delete failure");
    },
  });
  const res = await purge.POST(authed(purge));
  const swept = ops.filter((o) => o.op.endsWith(".deleteMany")).length;
  assert.ok(swept >= 9, `only ${swept} deletes were attempted — allSettled should run all of them`);
  const body = await res.json();
  assert.equal(body.errorCount, 1);
  // Non-2xx so withCronRunRecording marks the run failed…
  assert.equal(res.status, 500);
  // …while the body still carries the counts that DID succeed.
  assert.equal(typeof body.deleted.authSessions, "number");
  shadowPrismaModel(prisma, "webhookReplay", counter("webhookReplay"));
});

test("purge-auth-sessions: an all-clean run is 200 with errorCount 0", async () => {
  const res = await purge.POST(authed(purge));
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.ok, true);
  assert.equal(body.errorCount, 0);
});

test("purge-auth-sessions: a failing leg is logged for the operator (guardrail 7 scope prefix)", async () => {
  shadowPrismaModel(prisma, "auditLog", {
    ...counter("auditLog"),
    deleteMany: async () => { throw new Error("boom"); },
  });
  await purge.POST(authed(purge));
  assert.ok(errors.some((e) => e.includes("[cron/purge-auth-sessions]")), `no scoped error log: ${errors.join(" | ")}`);
  shadowPrismaModel(prisma, "auditLog", counter("auditLog"));
});

// ── warm jobs: the unconfigured-provider short circuit ───────────────────────

test("warm-library skips cleanly, and BEFORE taking its lock, when TMDB credentials are absent", async () => {
  // Its gate is the TMDB_READ_TOKEN env (tmdbAuth), not a Setting — same
  // pre-lock short-circuit contract as the provider-keyed warm jobs.
  const saved = process.env.TMDB_READ_TOKEN;
  delete process.env.TMDB_READ_TOKEN;
  try {
    const route = ROUTES.find((r) => r.name === "warm-library")!;
    const res = await route.POST(authed(route));
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), { skipped: true, reason: "no TMDB credentials configured" });
    assert.deepEqual(pgLockCalls, []);
  } finally {
    process.env.TMDB_READ_TOKEN = saved;
  }
});

for (const [name, key, reason] of [
  ["warm-omdb", "omdbApiKey", "no OMDB API key configured"],
  ["warm-mdblist", "mdblistApiKey", "no MDBList API key configured"],
] as const) {
  test(`${name} skips cleanly, and BEFORE taking its lock, when unconfigured`, async () => {
    // Taking and releasing a lock every tick to do nothing is pure churn, and it
    // would also make the job look "running" to a concurrent operator trigger.
    settings.delete(key);
    const route = ROUTES.find((r) => r.name === name)!;
    const res = await route.POST(authed(route));
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), { skipped: true, reason });
    assert.deepEqual(pgLockCalls, []);
  });

  test(`${name} proceeds to its lock once ${key} exists`, async () => {
    const route = ROUTES.find((r) => r.name === name)!;
    await route.POST(authed(route));
    assert.ok(pgLockCalls.some((c) => c.op === "try"), `${name} must take its lock when configured`);
  });

  test(`${name} treats a whitespace-only ${key} as unconfigured`, async () => {
    settings.set(key, "");
    const route = ROUTES.find((r) => r.name === name)!;
    assert.equal((await route.POST(authed(route))).status, 200);
    assert.deepEqual(pgLockCalls, [], `${name} locked on an empty key`);
  });
}

// ── response hygiene across the matrix ───────────────────────────────────────

test("no cron route ever echoes CRON_SECRET back in its response", async () => {
  for (const route of ROUTES) {
    const res = await route.POST(authed(route));
    const text = await res.text();
    assert.ok(!text.includes(CRON_SECRET), `${route.name} leaked the cron secret`);
  }
});

test("every cron route answers with JSON, never an HTML error page", async () => {
  for (const route of ROUTES) {
    for (const r of [await route.POST(req(route)), await route.POST(authed(route))]) {
      assert.match(r.headers.get("content-type") ?? "", /application\/json/, `${route.name} returned non-JSON`);
    }
  }
});

test("guardrail 7: a successful cron run emits no console.log chatter", async () => {
  // Silent success is the convention — warn/error are the only sanctioned
  // channels. Captured for real rather than asserted structurally, so an
  // indirect log from a lib the route calls is caught too.
  const logs: string[] = [];
  const realLog = console.log;
  console.log = (...args: unknown[]) => { logs.push(args.map(String).join(" ")); };
  try {
    for (const route of ROUTES) await route.POST(authed(route));
  } finally {
    console.log = realLog;
  }
  assert.deepEqual(logs, [], `cron routes logged on the happy path: ${logs.join(" | ")}`);
});

test("no cron route source contains a console.log call (guardrail 7)", async () => {
  const { readFileSync } = await import("node:fs");
  for (const route of ROUTES) {
    const src = readFileSync(`src/app/api/cron/${route.name}/route.ts`, "utf-8");
    const code = src.split("\n").map((l) => { const i = l.indexOf("//"); return i === -1 ? l : l.slice(0, i); });
    assert.ok(!code.some((l) => /console\.log\s*\(/.test(l)), `${route.name} has a console.log`);
  }
});
