// Route-level unit tests for all eighteen POST /api/cron/* handlers:
//   arr-watch, purge-auth-sessions, purge-notifications, refresh-arr-snapshots, refresh-upstream-watch, scrub-audit-pii, sync-download-policies,
//   sync-plex-watchlists, sync-trakt, trash-diagnostic, trash-sync, warm-activity, warm-library,
//   warm-list-cache, warm-mdblist, warm-omdb, warm-recommendations, watch-sync
//
// These are the internet-facing entry points the container's own cron loop
// POSTs to with `Bearer ${CRON_SECRET}`, and they do the destructive
// housekeeping (session purge, audit-log deletion, PII scrub). They share one
// gate and one concurrency primitive, so the file is organized as a MATRIX over
// all eleven rather than eleven near-identical suites — which is also what makes it
// catch the regression that actually matters here: a NEW cron route, or an
// edited one, that quietly stops enforcing the shared invariant.
//
// The invariants, and why each is load-bearing:
//
//   1. isCronAuthorized ON EVERY ROUTE (guardrail 6). No route may re-implement
//      a CRON_SECRET check inline, and every one must reject before doing any
//      work. The matrix asserts unauthorized ⇒ 401 AND zero writes/locks for
//      all eleven, so an added route with a forgotten gate fails here.
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
//   5. purge-auth-sessions IS FAILURE-ISOLATED. Its ten deletes run one at a
//      time, a failing leg never stops the others, and a failure answers 200
//      with X-Cron-Degraded, so withCronRunRecording marks the run failed while
//      the body still carries the counts that did succeed.
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
const { invalidateFeatureFlagCache } = await import("../src/lib/features.ts");

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
// Unanchored ON PURPOSE: an end-anchored pattern misses `<model>.createMany`,
// which is the bulk-insert shape guardrail 4 mandates (batchCreateMany) and the
// one warm-recommendations actually issues — so the "did no work" assertions
// below would have been blind to exactly the write they most need to see. Raw
// writes count too.
const writeOps = () =>
  ops.filter((o) => /(create|update|upsert|delete|\$executeRaw)/i.test(o.op) && !isBookkeeping(o));

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
  // warm-recommendations reaches these through warmRecommendationsCache: the
  // per-user shelf, and the server-wide graph it refreshes first (guardrail 40).
  // An unstubbed model here does not fail — it tries to open a real connection
  // and the suite hangs.
  "userRecommendation", "watchlistItem", "titleSuggestion", "recommendationTitle",
  // …and the guardrail-40c inputs: the servers' own history and its read
  // points, the co-watch edges (cleared while the switch is off), Trakt
  // ratings, and the episode counts the quit-show rule reads.
  "serverWatchedTitle", "serverWatchCursor", "coWatchSuggestion", "tVEpisodeCache",
  // sync-plex-watchlists: stored Plex tokens + the auto-request ledger.
  "account", "autoRequestLedger",
  // sync-trakt: the per-user Trakt connection and its imported history+ratings.
  "traktConnection", "traktWatchedItem", "traktRating",
  // refresh-upstream-watch: the media servers' own watch-record snapshot.
  "upstreamWatchEvidence",
  // watch-sync: the admin-made pairs and their per-pair ledger.
  "watchSyncPair", "watchSyncMark",
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
shadowPrismaClientMethod(prisma, "$executeRaw", async () => { rec("$executeRaw"); return 0; });
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
  await load("arr-watch", AL.ARR_WATCH_LOCK_ID),
  await load("purge-auth-sessions", AL.PURGE_AUTH_SESSIONS_LOCK_ID),
  await load("purge-notifications", AL.PURGE_NOTIFICATIONS_LOCK_ID),
  await load("refresh-arr-snapshots", AL.ARR_SNAPSHOT_LOCK_ID),
  await load("refresh-upstream-watch", AL.UPSTREAM_WATCH_LOCK_ID),
  await load("scrub-audit-pii", AL.SCRUB_AUDIT_PII_LOCK_ID),
  await load("sync-download-policies", AL.DOWNLOAD_POLICIES_LOCK_ID),
  await load("sync-plex-watchlists", AL.PLEX_WATCHLIST_LOCK_ID),
  await load("sync-trakt", AL.TRAKT_SYNC_LOCK_ID),
  await load("trash-diagnostic", null),
  await load("trash-sync", AL.TRASH_SYNC_LOCK_ID),
  await load("warm-activity", AL.WARM_ACTIVITY_LOCK_ID),
  await load("warm-library", AL.WARM_LIBRARY_LOCK_ID),
  await load("warm-list-cache", AL.WARM_LIST_CACHE_LOCK_ID),
  await load("warm-mdblist", AL.WARM_MDBLIST_LOCK_ID),
  await load("warm-omdb", AL.WARM_OMDB_LOCK_ID),
  await load("warm-recommendations", AL.WARM_RECOMMENDATIONS_LOCK_ID),
  await load("watch-sync", AL.WATCH_SYNC_LOCK_ID),
];

const LOCKING = ROUTES.filter((r) => r.lockId !== null);

// refresh-arr-snapshots short-circuits before its lock unless an admin arr view
// is due; beforeEach plants one (a queue view read 10 minutes ago, whose route
// handler answers an empty report — no DB, no network).
const SNAP = await import("../src/lib/arr-snapshot.ts");
async function plantDueArrView(): Promise<void> {
  SNAP.resetArrSnapshotsForTests();
  const url = "http://localhost:3000/api/admin/queue";
  await SNAP.snapshotted(async () => Response.json({ items: [] }))(new NextRequest(url, { headers: { "accept-language": "en" } }), {}, { user: { id: "admin-1", role: "ADMIN", permissions: BigInt(0) } });
  SNAP.rememberSnapshot(SNAP.snapshotKey(url, "en")!, '{"items":[]}', Date.now() - 10 * 60_000, { url, locale: "en", viewed: true });
}

function req(route: CronRoute, headers: Record<string, string> = {}, query = ""): InstanceType<typeof NextRequest> {
  return new NextRequest(`http://localhost:3000${route.path}${query}`, { method: "POST", headers });
}

const authed = (route: CronRoute) => req(route, { authorization: `Bearer ${CRON_SECRET}` });

beforeEach(async () => {
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
  // refresh-upstream-watch also short-circuits before its lock unless a feature
  // that reads its snapshot is on — pin one on rather than lean on a default.
  settings.set("feature.admin.neverWatched", "true");
  // watch-sync short-circuits before its lock while its feature (default OFF) is off.
  settings.set("feature.admin.watchSync", "true");
  // trash-sync too (TRaSH Guides is OFF by default). A fresh last-refresh stamp
  // keeps its run off GitHub: it only walks the (empty) application list.
  settings.set("trashGuidesEnabled", "true");
  settings.set("trashLastRefreshAt", new Date().toISOString());
  // arr-watch short-circuits before its lock unless a Radarr/Sonarr instance is
  // configured. An RFC1918 literal: admin-configured SSRF mode, no DNS; every
  // read answers the stub's 503.
  settings.set("radarrUrl", "http://10.0.0.5:7878");
  settings.set("radarrApiKey", "cron-routes-radarr-key");
  invalidateFeatureFlagCache();
  lockAcquire = () => true;
  await plantDueArrView();
});

// ── the matrix itself must not pass vacuously ────────────────────────────────

test("all eighteen cron routes loaded and expose a POST handler", () => {
  assert.equal(ROUTES.length, 18);
  for (const r of ROUTES) assert.equal(typeof r.POST, "function", `${r.name} has no POST`);
});

test("writeOps() counts bulk inserts and raw writes — the 'did no work' assertions must not be blind to them", () => {
  // The whole matrix's "zero writes before auth / while the lock is busy"
  // assertions are only as good as this classifier. An end-anchored pattern
  // silently excluded `<model>.createMany` — the shape batchCreateMany issues
  // (guardrail 4) and the one warm-recommendations reaches through
  // warmRecommendationsCache — so those assertions passed vacuously.
  ops = [
    { op: "userRecommendation.createMany" },
    { op: "$executeRawUnsafe" },
    { op: "auditLog.deleteMany" },
    { op: "setting.upsert", args: { where: { key: "cron:lastRun:warm-omdb" } } },
    { op: "tmdbCache.findMany" },
    { op: "$queryRawUnsafe" },
  ];
  assert.deepEqual(writeOps().map((o) => o.op), [
    "userRecommendation.createMany",
    "$executeRawUnsafe",
    "auditLog.deleteMany",
  ]);
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
    // The skip header is what withCronRunRecording/the run ledger reads: a bare
    // NextResponse.json({skipped}) records a busy lock as a successful run.
    assert.equal(res.headers.get("x-cron-skipped"), "1", `${route.name} must answer through cronSkippedResponse`);
    assert.deepEqual(writeOps(), [], `${route.name} did work while another run held the lock`);
  });
}

// The withCronRunRecording-wrapped routes mark their busy answer X-Cron-Skipped
// so NO ledger row is written for a run that never happened — otherwise the
// System tab's runs/h (guardrail 7b's cadence readout) over-counts whenever a
// run outlasts its tick. sync-plex-watchlists still answers a plain 200 skip
// and is recorded — not changed here.
for (const name of ["trash-sync", "sync-download-policies", "sync-trakt", "refresh-upstream-watch", "arr-watch", "refresh-arr-snapshots", "watch-sync"]) {
  test(`${name}: a BUSY lock writes NO cron:lastRun ledger row`, async () => {
    const route = ROUTES.find((r) => r.name === name)!;
    lockAcquire = () => false;
    const res = await route.POST(authed(route));
    assert.equal(res.headers.get("X-Cron-Skipped"), "1");
    assert.equal(ops.filter(isBookkeeping).length, 0, `${name} recorded a run it skipped`);
  });
}

// Every warm-* route answers a busy lock through cronSkippedResponse (the
// X-Cron-Skipped marker) and records no run.
for (const name of ["warm-recommendations", "warm-library", "warm-activity", "warm-mdblist", "warm-omdb", "warm-list-cache"]) {
  test(`${name}: a BUSY lock answers X-Cron-Skipped and records no run`, async () => {
    const route = ROUTES.find((r) => r.name === name)!;
    lockAcquire = () => false;
    const res = await route.POST(authed(route));
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), { skipped: true, reason: "already running" });
    assert.equal(res.headers.get("x-cron-skipped"), "1", `${name} must answer through cronSkippedResponse`);
    assert.equal(ops.filter(isBookkeeping).length, 0, `${name} recorded a run it skipped`);
  });
}

test("trash-sync: TRaSH Guides OFF (the default) is a 200 skip — no 500, no audit row, no degraded header", async () => {
  // runTrashSync answers a disabled feature with errors:["trashGuidesEnabled is
  // off"]; turned into a 500 that made the DAILY job a 300s retry loop on every
  // stock deployment (288 failed runs + 288 SETTINGS_CHANGE audit rows a day).
  settings.delete("trashGuidesEnabled");
  invalidateFeatureFlagCache();
  const route = ROUTES.find((r) => r.name === "trash-sync")!;
  const res = await route.POST(authed(route));
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { skipped: true, reason: "TRaSH Guides disabled" });
  assert.equal(res.headers.get("x-cron-degraded"), null);
  assert.equal(opsOf("auditLog.create").length, 0, "a disabled feature is not a settings change");
  // No run happened: it is decided before the lock (no pg connection) and kept
  // out of the run history (guardrail 7b).
  assert.equal(res.headers.get("x-cron-skipped"), "1");
  assert.equal(ops.filter(isBookkeeping).length, 0, "a disabled run must not be recorded");
  assert.deepEqual(pgLockCalls, []);
});

test("trash-diagnostic: a starter-pack probe that throws reads as NOT resolvable", async () => {
  // Its errored report has neither count, and comparing two undefineds used to
  // call it resolvable.
  const route = ROUTES.find((r) => r.name === "trash-diagnostic")!;
  shadowPrismaModel(prisma, "trashSpec", {
    ...counter("trashSpec"),
    findMany: async () => { throw new Error("trashSpec read exploded (unit test)"); },
  });
  try {
    const res = await route.POST(authed(route));
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.match(body.report.starterPack.error, /exploded/);
    assert.equal(body.summary.starterPackResolvable, false);
  } finally {
    shadowPrismaModel(prisma, "trashSpec", counter("trashSpec"));
  }
});

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

test("every named advisory lock id is distinct — the registry is the collision check", () => {
  // A route passing a literal id would dodge this; every withAdvisoryLock
  // caller names its id from advisory-lock.ts (the scan below).
  const named = Object.entries(AL).filter(([k, v]) => k.endsWith("_LOCK_ID") && typeof v === "number") as Array<[string, number]>;
  assert.ok(named.length >= 20, `expected the whole registry, saw ${named.length}`);
  const byId = new Map<number, string[]>();
  for (const [k, v] of named) byId.set(v, [...(byId.get(v) ?? []), k]);
  const clashes = [...byId.entries()].filter(([, ks]) => ks.length > 1);
  assert.deepEqual(clashes, [], `advisory lock ids claimed twice: ${JSON.stringify(clashes)}`);
});

test("no withAdvisoryLock caller passes a literal lock id", async () => {
  const { readFileSync, readdirSync } = await import("node:fs");
  const { join } = await import("node:path");
  const files: string[] = [];
  const walk = (dir: string) => {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      const p = join(dir, e.name);
      if (e.isDirectory()) { if (e.name !== "generated") walk(p); }
      else if (/\.tsx?$/.test(e.name)) files.push(p);
    }
  };
  walk("src");
  const literal: string[] = [];
  for (const f of files) {
    if (f.endsWith("advisory-lock.ts")) continue;
    if (/withAdvisoryLock\(\s*\d/.test(readFileSync(f, "utf8"))) literal.push(f);
  }
  assert.deepEqual(literal, [], "name the id in advisory-lock.ts instead of passing a number");
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

test("scrub-audit-pii: the userName pass writes and skips on the viewer's REDACTED_USER_NAME, not a private literal", async () => {
  // The admin viewer renders a row as "redacted" by comparing with this
  // constant; a scrub writing its own copy would drift from it, and re-touch
  // every old row on each run once the two disagreed.
  const { REDACTED_USER_NAME } = await import("../src/lib/audit.ts");
  const seen: Array<{ where: Record<string, unknown>; data: Record<string, unknown> }> = [];
  shadowPrismaModel(prisma, "auditLog", {
    ...counter("auditLog"),
    updateMany: async (args: { where: Record<string, unknown>; data: Record<string, unknown> }) => {
      seen.push(args);
      return { count: 0 };
    },
  });
  try {
    await scrub.POST(authed(scrub));
    const pii = seen.find((u) => "userName" in u.data);
    assert.ok(pii, "the PII column pass is missing");
    assert.equal(pii.data.userName, REDACTED_USER_NAME);
    assert.deepEqual(
      (pii.where.OR as Array<Record<string, unknown>>).find((o) => "userName" in o),
      { userName: { not: REDACTED_USER_NAME } },
    );
  } finally {
    shadowPrismaModel(prisma, "auditLog", counter("auditLog"));
  }
  // The values match today, so the run above can't tell the constant from a
  // copy of it: the one scrub both paths run must name the constant, never the
  // literal, and neither path may carry a scrub of its own.
  const { readFileSync } = await import("node:fs");
  const read = (file: string) => readFileSync(new URL(`../${file}`, import.meta.url), "utf8");
  const scrubSrc = read("src/lib/audit-pii-scrub.ts");
  assert.doesNotMatch(scrubSrc, /["'`]\[redacted\]["'`]/, "the scrub carries its own \"[redacted]\" literal");
  assert.match(scrubSrc, /userName: \{ not: REDACTED_USER_NAME \}/, "the scrub must skip rows already redacted by the constant");
  assert.match(scrubSrc, /userName: REDACTED_USER_NAME \}/, "the scrub must write the constant");
  for (const file of ["src/app/api/cron/scrub-audit-pii/route.ts", "src/app/api/admin/audit-log/route.ts"]) {
    const src = read(file);
    assert.match(src, /await scrubAuditPii\(cutoff\)/, `${file} runs the shared scrub`);
    assert.doesNotMatch(src, /auditLog\.updateMany|REDACTED_USER_NAME/, `${file} carries a scrub of its own`);
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

test("scrub-audit-pii: aged admin-action rows lose the TARGET user's name/email from their details; recent rows keep them", async () => {
  type Row = { id: string; createdAt: Date; action: string; details: string | null };
  const aged = new Date(Date.now() - 200 * 86_400_000);
  const rows: Row[] = [
    { id: "a1", createdAt: aged, action: "USER_ROLE_CHANGE", details: JSON.stringify({ targetUser: "Alice", targetEmail: "alice@example.com", before: { role: "USER" } }) },
    { id: "a2", createdAt: new Date(), action: "USER_ROLE_CHANGE", details: JSON.stringify({ targetUser: "Bob", targetEmail: "bob@example.com" }) },
    { id: "a3", createdAt: aged, action: "USER_PURGE", details: JSON.stringify({ targetUser: "Carol", targetEmail: "carol@example.com", historyPreserved: { mediaRequests: 2 } }) },
  ];
  const aged_ = (r: Row, w: { createdAt?: { lt?: Date } }) => !w.createdAt?.lt || r.createdAt < w.createdAt.lt;
  shadowPrismaModel(prisma, "auditLog", {
    ...counter("auditLog"),
    findMany: async (args: { where: { createdAt?: { lt?: Date }; AND?: Array<{ OR?: Array<{ details: { contains: string } }> }> }; cursor?: { id: string } }) => {
      rec("auditLog.findMany", args.where);
      if (args.cursor) return [];
      // The PII-key OR is one of the where's AND terms (the caller's own OR is never overwritten).
      const keyTerms = (args.where.AND ?? []).flatMap((t) => t.OR ?? []);
      return rows
        .filter((r) => aged_(r, args.where) && keyTerms.some((o) => r.details?.includes(o.details.contains)))
        .map((r) => ({ id: r.id, details: r.details }));
    },
    updateMany: async (args: { where: { createdAt?: { lt?: Date }; id?: string; details?: string }; data: { details?: string | null } }) => {
      rec("auditLog.updateMany", args.where);
      if (args.where.id === undefined) return { count: 0 };
      const r = rows.find((x) => x.id === args.where.id && x.details === args.where.details && aged_(x, args.where));
      if (!r) return { count: 0 };
      r.details = args.data.details ?? null;
      return { count: 1 };
    },
  });
  try {
    const res = await scrub.POST(authed(scrub));
    const body = await res.json();
    assert.equal(body.adminDetailsScrubbed, 2);
    assert.deepEqual(JSON.parse(rows[0].details!), { before: { role: "USER" } });
    assert.deepEqual(JSON.parse(rows[2].details!), { historyPreserved: { mediaRequests: 2 } }, "a purge record keeps what happened, not who it was");
    assert.match(rows[1].details!, /bob@example\.com/, "a row inside the retention window is untouched");
    // The audit scrub's every write stays cutoff-bounded (the test above pins it for the column passes).
    for (const u of opsOf("auditLog.updateMany")) {
      assert.ok((u.args as { createdAt?: { lt?: Date } }).createdAt?.lt instanceof Date);
    }
  } finally {
    shadowPrismaModel(prisma, "auditLog", counter("auditLog"));
  }
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
  assert.equal(swept, 10, `only ${swept} deletes were attempted — a failing leg must not stop the rest`);
  const body = await res.json();
  assert.equal(body.errorCount, 1);
  // 200 + X-Cron-Degraded, like every other cron, so withCronRunRecording
  // marks the run failed without the entrypoint re-running a daily job every
  // 300s (its fast retry on a non-2xx)…
  assert.equal(res.status, 200);
  assert.equal(res.headers.get("x-cron-degraded"), "1");
  assert.equal(body.ok, false);
  assert.match(body.error, /1 table purge\(s\) failed/);
  assert.equal(ledgerOk("auth-sessions:purge-expired"), false, "the ledger records the failed run");
  // …while the body still carries the counts that DID succeed.
  assert.equal(typeof body.deleted.authSessions, "number");
  shadowPrismaModel(prisma, "webhookReplay", counter("webhookReplay"));
});

test("purge-auth-sessions: the legs run one at a time, never all at once on the small Prisma pool", async () => {
  let inFlight = 0;
  let peak = 0;
  const slow = (model: string) => ({
    ...counter(model),
    deleteMany: async (args: { where?: unknown } = {}) => {
      inFlight++;
      peak = Math.max(peak, inFlight);
      await new Promise((r) => setImmediate(r));
      inFlight--;
      rec(`${model}.deleteMany`, args.where);
      return { count: 0 };
    },
  });
  const models = ["authSession", "discordLinkToken", "discordMergeCode", "discordSearchCache", "webhookReplay", "plexTokenCache", "tmdbMediaCore", "ipLookupCache", "auditLog"];
  for (const m of models) shadowPrismaModel(prisma, m, slow(m));
  try {
    const res = await purge.POST(authed(purge));
    assert.equal(res.status, 200);
    assert.equal(opsOf("auditLog.deleteMany").length, 1);
    assert.equal(peak, 1, `${peak} purge deletes ran at once`);
  } finally {
    for (const m of models) shadowPrismaModel(prisma, m, counter(m));
  }
});

test("purge-auth-sessions: an all-clean run is 200 with errorCount 0", async () => {
  const res = await purge.POST(authed(purge));
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.ok, true);
  assert.equal(body.errorCount, 0);
  assert.equal(body.aborted, false);
  assert.equal(res.headers.get("x-cron-degraded"), null);
});

test("purge-auth-sessions: a failing leg reports 0 under ITS key and is logged by name; the other counts stand", async () => {
  shadowPrismaModel(prisma, "ipLookupCache", {
    ...counter("ipLookupCache"),
    deleteMany: async () => { throw new Error("ip cache delete exploded"); },
  });
  shadowPrismaModel(prisma, "authSession", {
    ...counter("authSession"),
    deleteMany: async () => ({ count: 7 }),
  });
  try {
    const res = await purge.POST(authed(purge));
    assert.equal(res.status, 200);
    assert.equal(res.headers.get("x-cron-degraded"), "1");
    const body = await res.json() as { errorCount: number; deleted: Record<string, number> };
    assert.equal(body.errorCount, 1);
    assert.equal(body.deleted.ipLookupCache, 0);
    assert.equal(body.deleted.authSessions, 7, "a leg that succeeded keeps its own count");
    assert.deepEqual(Object.keys(body.deleted), [
      "authSessions", "discordLinkTokens", "discordMergeCodes", "discordSearchCache", "webhookReplays",
      "plexTokensExpired", "plexTokensLegacy", "tmdbMediaCore", "ipLookupCache", "auditLogs",
    ]);
    const line = errors.find((e) => e.includes("[cron/purge-auth-sessions]"));
    assert.ok(line, `no scoped error log: ${errors.join(" | ")}`);
    assert.match(line, /ipLookupCache/, "the log must name the table that failed, not an index");
    assert.match(line, /ip cache delete exploded/);
  } finally {
    shadowPrismaModel(prisma, "ipLookupCache", counter("ipLookupCache"));
    shadowPrismaModel(prisma, "authSession", counter("authSession"));
  }
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
    // No run happened: answered as a skip and kept out of the run history.
    assert.equal(res.headers.get("x-cron-skipped"), "1");
    assert.equal(ops.filter(isBookkeeping).length, 0, "an unconfigured skip must not be recorded");
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
    // No run happened: answered as a skip and kept out of the run history.
    assert.equal(res.headers.get("x-cron-skipped"), "1");
    assert.equal(ops.filter(isBookkeeping).length, 0, "an unconfigured skip must not be recorded");
    assert.deepEqual(pgLockCalls, []);
  });

  test(`${name} proceeds to its lock once ${key} exists`, async () => {
    const route = ROUTES.find((r) => r.name === name)!;
    await route.POST(authed(route));
    assert.ok(pgLockCalls.some((c) => c.op === "try"), `${name} must take its lock when configured`);
  });

  test(`${name} treats an EMPTY ${key} as unconfigured`, async () => {
    // An empty value only, not a whitespace-only one: neither the route
    // (`!apiKey?.value`) nor getApiKey in omdb.ts/mdblist.ts trims, so "   "
    // counts as configured today and this test must not claim otherwise.
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

// ── the response verdict must match the ledger verdict ──────────────────────
// The admin "Run now" badge judges `res.ok && !data.error` (cron-job-table.tsx),
// deliberately ignoring `ok`. These five routes used to hardcode `ok: true` and
// emit no `error`, so a run in which every task failed painted the badge green
// while recordCronRun wrote ok:false — the two only re-agreed after a reload.
// Status stays 200: the container reschedules any non-2xx every
// CRON_RETRY_INTERVAL, so the degraded signal is `error` + X-Cron-Degraded.

const DERIVED_OK_ROUTES = ["warm-library", "warm-list-cache", "warm-mdblist", "warm-omdb", "warm-recommendations", "sync-download-policies"] as const;

function ledgerOk(target: string): boolean | undefined {
  const row = opsOf("setting.upsert")
    .map((o) => o.args as { where: { key: string }; update: { value: string } })
    .find((a) => a.where.key === `cron:lastRun:${target}`);
  if (!row) return undefined;
  return (JSON.parse(row.update.value) as { ok: boolean }).ok;
}

function ledgerWrites(target: string): number {
  return opsOf("setting.upsert")
    .filter((o) => (o.args as { where: { key: string } }).where.key === `cron:lastRun:${target}`).length;
}

const LEDGER_TARGET: Record<(typeof DERIVED_OK_ROUTES)[number], string> = {
  "warm-library": "library",
  "warm-list-cache": "list-cache",
  "warm-mdblist": "mdblist",
  "warm-omdb": "omdb",
  "warm-recommendations": "recommendations",
  "sync-download-policies": "download-policies",
};

for (const name of DERIVED_OK_ROUTES) {
  test(`${name}: body.ok, the error key, X-Cron-Degraded and the ledger all tell the SAME story`, async () => {
    const route = ROUTES.find((r) => r.name === name)!;
    const res = await route.POST(authed(route));
    assert.equal(res.status, 200, "status stays 200 — the entrypoint fast-retries any non-2xx");
    const body = await res.json() as { ok: boolean; error?: unknown };
    assert.equal(typeof body.ok, "boolean");
    const recorded = ledgerOk(LEDGER_TARGET[name]);
    assert.equal(recorded, body.ok, `${name}: ledger ok=${recorded} but body ok=${body.ok}`);
    assert.equal(ledgerWrites(LEDGER_TARGET[name]), 1, `${name}: the run must be recorded exactly once`);
    if (body.ok) {
      assert.equal(body.error, undefined, "a clean run must not carry an error key — the badge reads it as failure");
      assert.equal(res.headers.get("x-cron-degraded"), null);
    } else {
      assert.equal(typeof body.error, "string");
      assert.ok(res.headers.get("x-cron-degraded"), "a degraded run must carry X-Cron-Degraded");
    }
  });
}

test("warm-list-cache: with upstream list fetches failing, the 200 body says ok:false + error and the ledger agrees", async () => {
  // Under this harness every upstream answers 503; the list helpers that don't
  // settle their pages internally reject, so Promise.allSettled counts them.
  const route = ROUTES.find((r) => r.name === "warm-list-cache")!;
  const res = await route.POST(authed(route));
  assert.equal(res.status, 200, "status stays 200 — the entrypoint fast-retries any non-2xx");
  const body = await res.json() as { ok: boolean; error?: string; errors: number };
  assert.ok(body.errors > 0, `expected rejected list fetches, got ${JSON.stringify(body)}`);
  assert.equal(body.ok, false);
  assert.equal(typeof body.error, "string");
  assert.match(body.error!, /list fetches failed/);
  assert.equal(res.headers.get("x-cron-degraded"), String(body.errors));
  assert.equal(ledgerOk("list-cache"), false);
  // Each failure is logged by the task's name (its key in the body), with why.
  const failedTasks = Object.entries(body).filter(([k, v]) => v === 0 && errors.some((e) => e.startsWith(`[warm-list-cache] ${k} failed:`)));
  assert.equal(failedTasks.length, body.errors, `one named log line per failed task: ${errors.join(" | ")}`);
});

// The paged TMDB lists settle their own pages and answer [] on an outage (and
// during the backoff after one), so nothing rejected and the run could be
// recorded ok with TMDB down. Each is read with its `complete` flag instead.
const PAGED_TMDB_TASKS = ["trending", "popularMovies", "popularTV", "upcomingMovies", "upcomingTV", "onAirTV", "topRatedMovies", "topRatedTV"];

test("warm-list-cache: every paged TMDB list that came back incomplete is counted and logged as a failed task", async () => {
  const { __resetTmdbBackoffsForTests } = await import("../src/lib/tmdb.ts");
  __resetTmdbBackoffsForTests();
  const route = ROUTES.find((r) => r.name === "warm-list-cache")!;
  const res = await route.POST(authed(route));
  const body = await res.json() as Record<string, unknown> & { errors: number };
  for (const name of PAGED_TMDB_TASKS) {
    assert.ok(
      errors.some((e) => e.startsWith(`[warm-list-cache] ${name} failed:`)),
      `${name} answered empty with TMDB down and was not counted: ${errors.join(" | ")}`,
    );
    assert.equal(body[name], 0);
  }
  assert.ok(body.errors >= PAGED_TMDB_TASKS.length);
  // Same answer inside the all-pages-failed backoff, which serves [] without a fetch.
  errors.length = 0;
  const again = await (await route.POST(authed(route))).json() as { errors: number };
  assert.ok(again.errors >= PAGED_TMDB_TASKS.length, "a run inside the backoff window must not read as warmed");
  __resetTmdbBackoffsForTests();
});

test("warm-list-cache: a list with titles but a failed page is a failed task too — it was served, not cached", async () => {
  const { __resetTmdbBackoffsForTests } = await import("../src/lib/tmdb.ts");
  __resetTmdbBackoffsForTests();
  const realFetch = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = new URL(String(input));
    if (url.pathname.endsWith("/movie/popular") && url.searchParams.get("page") === "1") {
      return new Response(JSON.stringify({ page: 1, total_pages: 9, results: [{ id: 603, title: "The Matrix" }] }), {
        status: 200, headers: { "content-type": "application/json" },
      });
    }
    return realFetch(input);
  }) as unknown as typeof fetch;
  try {
    const route = ROUTES.find((r) => r.name === "warm-list-cache")!;
    const res = await route.POST(authed(route));
    await res.json();
    const line = errors.find((e) => e.startsWith("[warm-list-cache] popularMovies failed:"));
    assert.ok(line, `a partly-fetched list was reported as warmed: ${errors.join(" | ")}`);
    assert.match(line, /1 item\(s\), not cached/);
  } finally {
    globalThis.fetch = realFetch;
    __resetTmdbBackoffsForTests();
  }
});

test("warm-library: an all-clean run is ok:true with NO error key and no degraded header", async () => {
  const route = ROUTES.find((r) => r.name === "warm-library")!;
  const res = await route.POST(authed(route));
  assert.equal(res.status, 200);
  const body = await res.json() as { ok: boolean; error?: unknown; failed: number };
  assert.equal(body.failed, 0);
  assert.equal(body.ok, true);
  assert.equal(body.error, undefined);
  assert.equal(res.headers.get("x-cron-degraded"), null);
  assert.equal(ledgerOk("library"), true);
});

test("no warm route hardcodes `ok: true` in its response body — the verdict is derived", async () => {
  const { readFileSync } = await import("node:fs");
  for (const name of DERIVED_OK_ROUTES) {
    const src = readFileSync(`src/app/api/cron/${name}/route.ts`, "utf-8");
    assert.ok(!/ok:\s*true\b/.test(src), `${name} still answers a literal ok: true`);
  }
});

// ── a run that THROWS is recorded as a failed run, exactly once ─────────────
// The warm-* routes go through withCronRunRecording, so anything that escapes
// the work — the warm itself, the lock connection, a lock timeout — lands in
// the run history as ok:false instead of leaving the last green run standing.
const WARM_LEDGER: Record<string, string> = {
  "warm-activity": "activity",
  "warm-library": "library",
  "warm-list-cache": "list-cache",
  "warm-mdblist": "mdblist",
  "warm-omdb": "omdb",
  "warm-recommendations": "recommendations",
};

for (const [name, target] of Object.entries(WARM_LEDGER)) {
  test(`${name}: a lock connection that fails is recorded once as a failed run`, async () => {
    const route = ROUTES.find((r) => r.name === name)!;
    const realConnect = pgProto.connect;
    pgProto.connect = async () => { throw new Error("connect refused (unit test)"); };
    try {
      await assert.rejects(route.POST(authed(route)), /connect refused/);
    } finally {
      pgProto.connect = realConnect;
    }
    assert.equal(ledgerWrites(target), 1, `${name} must record the failed run exactly once`);
    assert.equal(ledgerOk(target), false);
  });
}

// ── attribution comes from the SAME session read that authorized ────────────

test("every cron route resolves its actor through getCronActor — no second readActiveSummonarrSessionFromRequest", async () => {
  const { readFileSync } = await import("node:fs");
  for (const route of ROUTES) {
    const src = readFileSync(`src/app/api/cron/${route.name}/route.ts`, "utf-8");
    // defineCronRoute / withCronActor (src/lib/cron-route.ts) call getCronActor
    // first; tests/cron-route.test.mts pins that.
    const usesAuth = /getCronActor\(|isCronAuthorized\(|defineCronRoute\(|withCronActor\(/.test(src);
    assert.ok(usesAuth, `${route.name} has no cron gate`);
    assert.ok(!src.includes("readActiveSummonarrSessionFromRequest"), `${route.name} re-reads the session for attribution — use getCronActor`);
  }
});

test("every locking cron route is built on defineCronRoute — one shape for auth, skip, ledger, lock and answer", async () => {
  const { readFileSync } = await import("node:fs");
  for (const route of LOCKING) {
    const code = readFileSync(`src/app/api/cron/${route.name}/route.ts`, "utf-8")
      .split("\n").map((l) => { const i = l.indexOf("//"); return i === -1 ? l : l.slice(0, i); }).join("\n");
    assert.match(code, /export const POST = defineCronRoute\(/, `${route.name} hand-rolls its cron plumbing`);
    for (const piece of ["withAdvisoryLock(", "withCronRunRecording(", "getCronActor(", "X-Cron-Degraded"]) {
      assert.ok(!code.includes(piece), `${route.name} still spells out ${piece} itself`);
    }
  }
});

test("warm-recommendations: a failed graph refresh is degraded with a COUNT in X-Cron-Degraded and the reason in `error`", async () => {
  // It used to send the word "graph", the one cron whose header was not a count.
  const route = ROUTES.find((r) => r.name === "warm-recommendations")!;
  // The graph's source walk reads the watchlist; failing it fails the refresh.
  shadowPrismaModel(prisma, "watchlistItem", {
    ...counter("watchlistItem"),
    findMany: async () => { throw new Error("graph store unavailable (unit test)"); },
  });
  try {
    const res = await route.POST(authed(route));
    assert.equal(res.status, 200);
    const body = await res.json() as { ok: boolean; graphFailed: boolean; error?: string };
    assert.equal(body.graphFailed, true, "the harness must actually fail the graph refresh");
    assert.equal(body.ok, false);
    assert.match(body.error ?? "", /graph refresh failed/);
    assert.equal(res.headers.get("x-cron-degraded"), "1");
    assert.equal(ledgerOk("recommendations"), false);
  } finally {
    shadowPrismaModel(prisma, "watchlistItem", counter("watchlistItem"));
  }
});

