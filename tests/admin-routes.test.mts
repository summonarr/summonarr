// Route-level unit tests for the destructive ADMIN handlers that shipped the
// guardrail-26 / guardrail-27 / guardrail-28 regressions. This file invokes the
// exported route handlers directly with constructed NextRequests + a REAL signed
// admin session, and pins the exact post-mutation contracts CLAUDE.md enumerates.
// Division of labour with the leaf-module suites (owned elsewhere, NOT re-pinned):
//   - tests/audit.test.mts OWNS logAudit-vs-logAuditOrFail semantics (swallow vs
//     propagate, field mapping). Here we pin which VARIANT each route chose.
//   - tests/anonymize-user.test.mts OWNS anonymizeUserInTx's write set + the
//     last-admin CAS. Here we pin the user-DELETE route's WIRING of it (runs it in
//     a $transaction, maps LastAdminError → 400, never hard-deletes the row).
//   - tests/session-revocation.test.mts OWNS the force-revoke ledger Set. Here we
//     pin the revoke ROUTE's ordering (mark lands only after the DB write commits).
//   - tests/api-auth.test.mts OWNS the withAuth/withAdmin/withPermission wrapper
//     matrix. Here we spot-check that the gate fronts these specific routes.
//
// THE HEADLINE — GUARDRAIL 26. Each of user-delete, role-change, play-history
// delete, Plex terminate, and Jellyfin terminate calls the SWALLOWING `logAudit`
// AFTER its mutation has committed (a bare `void logAudit(...)`), NOT
// `logAuditOrFail`. We pin it behaviorally: with the audit write STUBBED TO THROW
// (auditLog.create rejects), the destructive op STILL returns success (200/204),
// the mutation is recorded as having happened, and the `[audit] Failed to write
// audit log:` swallow line is logged. Had the route used `await logAuditOrFail`,
// the throw would propagate and the handler would reject / 500 — so "returns
// success AND the swallow line fired" is the exact discriminator between the two
// variants, and the regression that shipped (a 500 on a successful destructive op,
// whose retry then 404s with no trail or double-applies).
//   DB-restore (/api/admin/backup/db-import) is a 6th guardrail-26 route but its
// success path runs processBackupImport (PBKDF2(600k) decrypt + a destructive
// TRUNCATE+INSERT transaction), which can't be reached without a real encrypted
// blob + BACKUP_DB_PASSWORD + a live DB, and processBackupImport is a named ESM
// import this loader can't stub. We cover its pre-import GATING instead (authz +
// the 503 config gates) and SKIP the audit-throw assertion — see the report.
//
// GUARDRAIL 27. The session-revoke route calls revokeSessionById /
// revokeAllUserSessions (auth.ts), which mark the in-memory force-revoke ledger
// only AFTER the $transaction commits. With the DB delete stubbed to throw, the
// route surfaces the failure (rejects) AND leaves NO phantom mark (shouldForceDbCheck
// stays false) — pinned via the throwing stub + the ledger read.
//
// GUARDRAIL 28. Admin user-delete ANONYMIZES; the tx's mediaServerUser.deleteMany
// throws, so a green delete proves the identity was severed by UNLINK
// (updateMany userId→null), never a hard delete that would restrict/cascade play
// history.
//
// No DB, no network, no DNS: globalThis.prisma is a recording fake seeded BEFORE
// the module graph loads (the sync-routes.test.mts idiom), fetch is scripted per
// test, and the Plex/Jellyfin server URLs are RFC1918 IP literals so
// safeFetchAdminConfigured's SSRF stack short-circuits on isIP with no lookup.
// Admin sessions are REAL jose JWTs over in-memory AuthSession/User rows; claims
// mirror the rows so the privilege-rotation path never fires.
import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";

process.env.TOKEN_ENCRYPTION_KEY = "ab".repeat(32); // prisma.ts pulls in token-crypto at load
process.env.NEXTAUTH_SECRET = "admin-routes-test-secret-0123456789abcdef";
process.env.AUTH_URL = "http://localhost:3000"; // unprefixed cookie name + trusted origin
process.env.TRUST_PROXY = "true"; // silence rate-limit's module-load warning

// ── console capture (guardrail 7: warn/error only; the swallow logs on error) ─
const warns: string[] = [];
const errors: string[] = [];
console.warn = (...args: unknown[]) => { warns.push(args.map(String).join(" ")); };
console.error = (...args: unknown[]) => { errors.push(args.map(String).join(" ")); };

// ── scripted fetch (terminate routes only) ──────────────────────────────────
type FetchCall = { url: URL; method: string };
const fetchCalls: FetchCall[] = [];
let respond: (url: URL) => Response | Promise<Response> = (url) => {
  throw new Error(`unexpected fetch ${url} — script a responder for this test`);
};
globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
  const url = new URL(String(input));
  fetchCalls.push({ url, method: init?.method ?? "GET" });
  return respond(url);
}) as typeof fetch;

const okJson = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

// ── recording fake prisma (seeded on globalThis before the module graph) ─────
type DbUser = {
  id: string; role: string; permissions: bigint; name: string | null; email: string | null;
  mediaServer: string | null; notificationEmail: string | null;
  sessionsRevokedAt: Date | null; passwordChangedAt: Date | null; deactivatedAt: Date | null;
};
type AuthRow = { userId: string; deviceLabel: string | null; createdAt: Date };

const usersById = new Map<string, DbUser>();
const authSessionsById = new Map<string, AuthRow>();
const settings = new Map<string, string>();
const playHistoryById = new Map<string, Record<string, unknown>>();
const trashAppsById = new Map<string, { id: string; trashSpec: { trashId: string; kind: string } }>();

// Per-test knobs, reset in beforeEach.
let auditThrows = false;
let casRows = 1; // rows the in-tx CAS ($executeRaw) reports affected
let txAuthDeleteThrows = false; // simulate the AuthSession DB delete failing (guardrail 27)
let counts = { requests: 0, issues: 0, votes: 0 };
let tmdbDeleteCount = 3;
let trashDeleteCount = 1;

// Audit surface: attempts are recorded even on throw (proves logAudit was
// invoked); committed rows only land in auditRows (proves the write succeeded).
const auditAttempts: Array<Record<string, unknown>> = [];
const auditRows: Array<Record<string, unknown>> = [];

// Every op the in-tx callback issues, in order — lets us pin the anonymize write
// shape + the guardrail-28 "unlink, never hard-delete" property.
type TxOp = { op: string; args?: unknown };
let txOps: TxOp[] = [];

function makeTx() {
  const rec = (op: string) => (args?: unknown) => { txOps.push({ op, args }); return Promise.resolve({ count: 0 }); };
  return {
    $executeRawUnsafe: async (sql: string) => { txOps.push({ op: "$executeRawUnsafe", args: sql }); return 0; },
    // Tagged-template form: strings array + interpolated bind values. Both the
    // role-change CAS and anonymize's last-admin CAS read the row count back.
    $executeRaw: async (strings: TemplateStringsArray, ...values: unknown[]) => {
      txOps.push({ op: "$executeRaw", args: { sql: strings.join("?"), values } });
      return casRows;
    },
    account: { deleteMany: rec("account.deleteMany") },
    pushSubscription: { deleteMany: rec("pushSubscription.deleteMany") },
    discordLinkToken: { deleteMany: rec("discordLinkToken.deleteMany") },
    discordMergeCode: { deleteMany: rec("discordMergeCode.deleteMany") },
    mediaServerUser: {
      updateMany: rec("mediaServerUser.updateMany"),
      deleteMany: async () => {
        throw new Error("guardrail 28 violated: MediaServerUser must never be hard-deleted");
      },
    },
    authSession: {
      findUnique: async (args: { where: { sessionId: string } }) => {
        const row = authSessionsById.get(args.where.sessionId);
        return row ? { userId: row.userId, createdAt: row.createdAt } : null;
      },
      delete: async (args: { where: { sessionId: string } }) => {
        if (txAuthDeleteThrows) throw new Error("AuthSession delete exploded (unit test)");
        txOps.push({ op: "authSession.delete", args });
        authSessionsById.delete(args.where.sessionId);
        return {};
      },
      deleteMany: async (args: { where: { userId: string } }) => {
        if (txAuthDeleteThrows) throw new Error("AuthSession deleteMany exploded (unit test)");
        txOps.push({ op: "authSession.deleteMany", args });
        return { count: 1 };
      },
      findMany: async (args: { where: { userId: string } }) =>
        [...authSessionsById.entries()]
          .filter(([, r]) => r.userId === args.where.userId)
          .map(([sessionId]) => ({ sessionId })),
    },
    user: {
      findUnique: async (args: { where: { id: string } }) => {
        const u = usersById.get(args.where.id);
        return u ? { sessionsRevokedAt: u.sessionsRevokedAt } : null;
      },
      update: rec("user.update"),
    },
  };
}

const fakePrisma = {
  user: {
    findUnique: async (args: { where: { id: string } }) => {
      const u = usersById.get(args.where.id);
      return u ? { ...u } : null;
    },
    update: async (args: unknown) => { txOps.push({ op: "user.update(top)", args }); return {}; },
    findMany: async () => [],
  },
  authSession: {
    findUnique: async (args: { where: { sessionId: string } }) => {
      const row = authSessionsById.get(args.where.sessionId);
      return row
        ? { id: `row-${args.where.sessionId}`, sessionId: args.where.sessionId, userId: row.userId, deviceLabel: row.deviceLabel }
        : null;
    },
    update: async () => ({}), // lastSeenAt fire-and-forget touch
    findMany: async () => [],
  },
  setting: {
    findUnique: async (args: { where: { key: string } }) => {
      const value = settings.get(args.where.key);
      return value === undefined ? null : { key: args.where.key, value };
    },
  },
  mediaRequest: { count: async () => counts.requests },
  issue: { count: async () => counts.issues },
  deletionVote: { count: async () => counts.votes },
  playHistory: {
    findUnique: async (args: { where: { id: string } }) => playHistoryById.get(args.where.id) ?? null,
    delete: async (args: { where: { id: string } }) => { txOps.push({ op: "playHistory.delete", args }); return {}; },
  },
  tmdbCache: {
    deleteMany: async (args: unknown) => { txOps.push({ op: "tmdbCache.deleteMany", args }); return { count: tmdbDeleteCount }; },
  },
  trashApplication: {
    findUnique: async (args: { where: { id: string } }) => trashAppsById.get(args.where.id) ?? null,
    deleteMany: async (args: unknown) => { txOps.push({ op: "trashApplication.deleteMany", args }); return { count: trashDeleteCount }; },
  },
  auditLog: {
    create: async (args: { data: Record<string, unknown> }) => {
      auditAttempts.push(args.data);
      if (auditThrows) throw new Error("audit insert exploded (unit test)");
      auditRows.push(args.data);
      return args.data;
    },
  },
  $transaction: async (arg: unknown, _opts?: { timeout?: number }) => {
    if (typeof arg === "function") return (arg as (t: unknown) => Promise<unknown>)(makeTx());
    return Promise.all(arg as Promise<unknown>[]);
  },
  $queryRaw: async () => { throw new Error("unexpected top-level $queryRaw"); },
  $executeRaw: async () => { throw new Error("unexpected top-level $executeRaw"); },
};
(globalThis as unknown as { prisma: unknown }).prisma = fakePrisma;

// ── dynamic imports (env + globalThis stubs must precede the module graph) ───
const { NextRequest } = await import("next/server");
const { signSessionJwt } = await import("../src/lib/session-jwt.ts");
const { shouldForceDbCheck } = await import("../src/lib/session-revocation.ts");

const { DELETE: clearCache } = await import("../src/app/api/admin/clear-cache/route.ts");
const { DELETE: playHistoryDelete } = await import("../src/app/api/play-history/[id]/route.ts");
const { PATCH: userPatch, DELETE: userDelete } = await import("../src/app/api/admin/users/[id]/route.ts");
const { DELETE: sessionsRevoke } = await import("../src/app/api/admin/users/[id]/sessions/route.ts");
const { DELETE: trashDelete } = await import("../src/app/api/admin/trash-guides/applications/[id]/route.ts");
const { POST: plexTerminate } = await import("../src/app/api/admin/play-history/terminate-session/route.ts");
const { POST: jellyfinTerminate } = await import("../src/app/api/admin/play-history/terminate-jellyfin-session/route.ts");
const { POST: dbImport } = await import("../src/app/api/admin/backup/db-import/route.ts");

type Req = InstanceType<typeof NextRequest>;
type Ctx = { params: Promise<{ id: string }> };

// RFC1918 literals ⇒ admin SSRF mode, isIP short-circuit, no DNS.
const PLEX_BASE = "http://10.88.0.1:32400";
const JF_BASE = "http://10.88.0.2:8096";

// ── fixtures ────────────────────────────────────────────────────────────────
let seq = 0;

// Mint a real signed session JWT backed by an in-memory User + AuthSession row.
async function mintSession(role: string): Promise<{ userId: string; token: string; header: Record<string, string> }> {
  seq++;
  const userId = `actor-${seq}`;
  const sessionId = `actor-sess-${seq}`;
  usersById.set(userId, {
    id: userId, role, permissions: 0n, name: `Actor ${seq}`, email: "actor@example.com",
    mediaServer: null, notificationEmail: null,
    sessionsRevokedAt: null, passwordChangedAt: null, deactivatedAt: null,
  });
  authSessionsById.set(sessionId, { userId, deviceLabel: "actor-device", createdAt: new Date() });
  const token = await signSessionJwt(
    { id: userId, role, permissions: "0", provider: "credentials", sessionId, expiresAt: Math.floor(Date.now() / 1000) + 86_400 },
    { expiresInSeconds: 7_200 },
  );
  // Bearer transport: skips the UA-fingerprint check + the sliding Set-Cookie,
  // so responses stay clean; the DB-checked auth still runs in full.
  return { userId, token, header: { authorization: `Bearer ${token}` } };
}

// Seed a target user row (the account being acted upon).
function seedUser(role: string): string {
  seq++;
  const id = `target-${seq}`;
  usersById.set(id, {
    id, role, permissions: 0n, name: `Target ${seq}`, email: `target-${seq}@example.com`,
    mediaServer: null, notificationEmail: null,
    sessionsRevokedAt: null, passwordChangedAt: null, deactivatedAt: null,
  });
  return id;
}

function req(url: string, opts: { method: string; headers?: Record<string, string>; body?: string } = { method: "GET" }): Req {
  return new NextRequest(url, {
    method: opts.method,
    headers: opts.headers,
    ...(opts.body !== undefined ? { body: opts.body } : {}),
  });
}
const ctxFor = (id: string): Ctx => ({ params: Promise.resolve({ id }) });

// Drain the microtask/macrotask queue so a `void logAudit(...)` fire-and-forget
// settles before we read auditRows / the swallow log.
const flush = () => new Promise((r) => setTimeout(r, 5));

beforeEach(() => {
  auditThrows = false;
  casRows = 1;
  txAuthDeleteThrows = false;
  counts = { requests: 0, issues: 0, votes: 0 };
  tmdbDeleteCount = 3;
  trashDeleteCount = 1;
  auditAttempts.length = 0;
  auditRows.length = 0;
  txOps = [];
  fetchCalls.length = 0;
  warns.length = 0;
  errors.length = 0;
  respond = (url) => { throw new Error(`unexpected fetch ${url}`); };
  delete process.env.BACKUP_DB_PASSWORD;
  // Per-test seed stores keyed by shared/reused ids — clear so one test's Plex/
  // Jellyfin config (the `settings` keys) can't leak into the next (usersById /
  // authSessionsById are keyed by a unique seq and re-minted, so they don't).
  settings.clear();
  playHistoryById.clear();
  trashAppsById.clear();
});

const SWALLOW = "[audit] Failed to write audit log:";
const sawSwallow = () => errors.some((e) => e.includes(SWALLOW));

// ════════════════════════════════════════════════════════════════════════════
// Authorization fronting (guardrail 6a) — spot-checked, not re-enumerated
// ════════════════════════════════════════════════════════════════════════════

test("clear-cache: no session → 401, a plain USER → 403, and the TmdbCache wipe never runs either way", async () => {
  // Spot-check that withAdmin fronts this destructive route (the full wrapper
  // matrix is owned by tests/api-auth.test.mts). 401 = authn, 403 = wrong role.
  const anon = await clearCache(req("http://localhost:3000/api/admin/clear-cache?source=all", { method: "DELETE" }), undefined);
  assert.equal(anon.status, 401);
  const user = await mintSession("USER");
  const forbidden = await clearCache(req("http://localhost:3000/api/admin/clear-cache?source=all", { method: "DELETE", headers: user.header }), undefined);
  assert.equal(forbidden.status, 403);
  assert.deepEqual(await forbidden.json(), { error: "Forbidden" });
  assert.equal(txOps.filter((o) => o.op === "tmdbCache.deleteMany").length, 0, "the destructive wipe must never run for an unauthorized caller");
});

test("user-delete: no session → 401; a USER without MANAGE_USERS → 403; neither anonymizes", async () => {
  const targetId = seedUser("USER");
  const anon = await userDelete(req(`http://localhost:3000/api/admin/users/${targetId}`, { method: "DELETE" }), ctxFor(targetId));
  assert.equal(anon.status, 401);
  const user = await mintSession("USER");
  const forbidden = await userDelete(req(`http://localhost:3000/api/admin/users/${targetId}`, { method: "DELETE", headers: user.header }), ctxFor(targetId));
  assert.equal(forbidden.status, 403);
  assert.equal(txOps.filter((o) => o.op === "mediaServerUser.updateMany").length, 0, "the handler body must not run for an unauthorized caller");
});

// ════════════════════════════════════════════════════════════════════════════
// GUARDRAIL 26 — the audit write throws, the destructive op still succeeds
// ════════════════════════════════════════════════════════════════════════════

test("GUARDRAIL 26 (clear-cache): auditLog throws → 200 kept, the wipe already ran, swallow logged", async () => {
  const admin = await mintSession("ADMIN");
  auditThrows = true;
  tmdbDeleteCount = 7;
  const res = await clearCache(req("http://localhost:3000/api/admin/clear-cache?source=tmdb", { method: "DELETE", headers: admin.header }), undefined);
  assert.equal(res.status, 200, "a failed audit write must not 500 a successful cache clear (logAudit, not logAuditOrFail)");
  assert.deepEqual(await res.json(), { source: "tmdb", cleared: 7 });
  assert.equal(txOps.filter((o) => o.op === "tmdbCache.deleteMany").length, 1, "the destructive deleteMany committed before the audit");
  await flush();
  assert.equal(auditAttempts.length, 1, "logAudit WAS invoked (proves it isn't skipped)");
  assert.equal(auditRows.length, 0, "the throwing write left no committed row");
  assert.ok(sawSwallow(), "the swallowing variant must log the scoped failure line");
});

test("clear-cache: happy path writes exactly one RATINGS_CACHE_CLEAR audit row after the wipe", async () => {
  const admin = await mintSession("ADMIN");
  tmdbDeleteCount = 12;
  const res = await clearCache(req("http://localhost:3000/api/admin/clear-cache?source=all", { method: "DELETE", headers: admin.header }), undefined);
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { source: "all", cleared: 12 });
  await flush();
  assert.equal(auditRows.length, 1);
  assert.equal(auditRows[0].action, "RATINGS_CACHE_CLEAR");
  assert.equal(auditRows[0].target, "tmdbCache");
});

test("GUARDRAIL 26 (play-history delete): auditLog throws → 204 kept, the row is already gone, swallow logged", async () => {
  const admin = await mintSession("ADMIN");
  playHistoryById.set("ph1", { id: "ph1", mediaServerUserId: "ms1", title: "The Matrix", source: "plex", tmdbId: 603, startedAt: new Date("2026-07-18T00:00:00Z"), stoppedAt: new Date("2026-07-18T02:00:00Z") });
  auditThrows = true;
  const res = await playHistoryDelete(req("http://localhost:3000/api/play-history/ph1", { method: "DELETE", headers: admin.header }), ctxFor("ph1"));
  assert.equal(res.status, 204, "a failed audit write must not 500 a successful play-history delete");
  assert.equal(txOps.filter((o) => o.op === "playHistory.delete").length, 1, "the row was deleted before the audit");
  await flush();
  assert.equal(auditAttempts.length, 1);
  assert.ok(sawSwallow());
});

test("play-history delete: unknown id → 404 with no delete and no audit", async () => {
  const admin = await mintSession("ADMIN");
  const res = await playHistoryDelete(req("http://localhost:3000/api/play-history/missing", { method: "DELETE", headers: admin.header }), ctxFor("missing"));
  assert.equal(res.status, 404);
  assert.equal(txOps.filter((o) => o.op === "playHistory.delete").length, 0);
  await flush();
  assert.equal(auditAttempts.length, 0, "a 404 must not audit a delete that didn't happen");
});

test("play-history delete: happy path → 204 and one PLAY_HISTORY_DELETE audit row", async () => {
  const admin = await mintSession("ADMIN");
  playHistoryById.set("ph2", { id: "ph2", mediaServerUserId: "ms2", title: "Dune", source: "jellyfin", tmdbId: 438631, startedAt: new Date("2026-07-01T10:00:00Z"), stoppedAt: new Date("2026-07-01T12:30:00Z") });
  const res = await playHistoryDelete(req("http://localhost:3000/api/play-history/ph2", { method: "DELETE", headers: admin.header }), ctxFor("ph2"));
  assert.equal(res.status, 204);
  await flush();
  assert.equal(auditRows.length, 1);
  assert.equal(auditRows[0].action, "PLAY_HISTORY_DELETE");
  assert.equal(auditRows[0].target, "play-history:ph2");
});

test("GUARDRAIL 26 (user-delete): auditLog throws → 200 {ok:true} kept, the anonymize ran, swallow logged", async () => {
  const admin = await mintSession("ADMIN");
  const targetId = seedUser("USER");
  auditThrows = true;
  const res = await userDelete(req(`http://localhost:3000/api/admin/users/${targetId}`, { method: "DELETE", headers: admin.header }), ctxFor(targetId));
  assert.equal(res.status, 200, "a failed audit write must not 500 an already-committed anonymize (guardrail 26)");
  assert.deepEqual(await res.json(), { ok: true });
  assert.equal(txOps.filter((o) => o.op === "user.update").length, 1, "the in-place identity scrub committed before the audit");
  await flush();
  assert.equal(auditAttempts.length, 1);
  assert.ok(sawSwallow());
});

test("user-delete: happy path → 200 and one USER_DELETE (anonymize) audit row", async () => {
  const admin = await mintSession("ADMIN");
  const targetId = seedUser("USER");
  counts = { requests: 4, issues: 1, votes: 2 };
  const res = await userDelete(req(`http://localhost:3000/api/admin/users/${targetId}`, { method: "DELETE", headers: admin.header }), ctxFor(targetId));
  assert.equal(res.status, 200);
  await flush();
  assert.equal(auditRows.length, 1);
  assert.equal(auditRows[0].action, "USER_DELETE");
  assert.equal(auditRows[0].target, `user:${targetId}`);
});

test("GUARDRAIL 26 (role-change): auditLog throws → 200 kept, the demotion CAS ran, swallow logged", async () => {
  const admin = await mintSession("ADMIN");
  const targetId = seedUser("ADMIN"); // demoting an admin routes through the last-admin CAS
  casRows = 1; // another active admin remains → the CAS demoted the row
  auditThrows = true;
  const res = await userPatch(req(`http://localhost:3000/api/admin/users/${targetId}`, { method: "PATCH", headers: { ...admin.header, "content-type": "application/json" }, body: JSON.stringify({ role: "USER" }) }), ctxFor(targetId));
  assert.equal(res.status, 200, "a failed audit write must not 500 an already-committed role change (guardrail 26)");
  assert.deepEqual(await res.json(), { id: targetId, role: "USER" });
  assert.equal(txOps.filter((o) => o.op === "$executeRaw").length, 1, "the demotion CAS committed before the audit");
  await flush();
  assert.equal(auditAttempts.length, 1);
  assert.ok(sawSwallow());
});

test("role-change: happy path → 200 and exactly one USER_ROLE_CHANGE audit row (no double-audit)", async () => {
  const admin = await mintSession("ADMIN");
  const targetId = seedUser("ADMIN");
  casRows = 1;
  const res = await userPatch(req(`http://localhost:3000/api/admin/users/${targetId}`, { method: "PATCH", headers: { ...admin.header, "content-type": "application/json" }, body: JSON.stringify({ role: "USER" }) }), ctxFor(targetId));
  assert.equal(res.status, 200);
  await flush();
  assert.equal(auditRows.length, 1, "a single successful role change must audit exactly once");
  assert.equal(auditRows[0].action, "USER_ROLE_CHANGE");
});

test("GUARDRAIL 26 (Plex terminate): auditLog throws → 200 {ok:true} kept, the terminate fired, swallow logged", async () => {
  const admin = await mintSession("ADMIN");
  settings.set("plexServerUrl", PLEX_BASE);
  settings.set("plexAdminToken", "plex-token-1");
  respond = (url) => {
    if (url.pathname === "/status/sessions") return okJson({ MediaContainer: { Metadata: [{ sessionKey: "77", Session: { id: "plex-guid-77" }, type: "movie", title: "Terminator", User: { id: 9, title: "neo" } }] } });
    if (url.pathname === "/status/sessions/terminate") return new Response(null, { status: 200 });
    throw new Error(`unexpected Plex fetch ${url}`);
  };
  auditThrows = true;
  const res = await plexTerminate(req("http://localhost:3000/api/admin/play-history/terminate-session", { method: "POST", headers: { ...admin.header, "content-type": "application/json" }, body: JSON.stringify({ sessionKey: "77" }) }), undefined);
  assert.equal(res.status, 200, "a failed audit write must not 500 an already-terminated Plex session");
  assert.deepEqual(await res.json(), { ok: true });
  assert.ok(fetchCalls.some((c) => c.url.pathname === "/status/sessions/terminate"), "the terminate POST fired before the audit");
  await flush();
  assert.equal(auditAttempts.length, 1);
  assert.ok(sawSwallow());
});

test("Plex terminate: happy path → 200 and one PLEX_SESSION_TERMINATE audit row", async () => {
  const admin = await mintSession("ADMIN");
  settings.set("plexServerUrl", PLEX_BASE);
  settings.set("plexAdminToken", "plex-token-1");
  respond = (url) => {
    if (url.pathname === "/status/sessions") return okJson({ MediaContainer: { Metadata: [{ sessionKey: "77", Session: { id: "plex-guid-77" }, type: "movie", title: "Terminator", User: { id: 9, title: "neo" } }] } });
    if (url.pathname === "/status/sessions/terminate") return new Response(null, { status: 200 });
    throw new Error(`unexpected Plex fetch ${url}`);
  };
  const res = await plexTerminate(req("http://localhost:3000/api/admin/play-history/terminate-session", { method: "POST", headers: { ...admin.header, "content-type": "application/json" }, body: JSON.stringify({ sessionKey: "77", reason: "please stop" }) }), undefined);
  assert.equal(res.status, 200);
  await flush();
  assert.equal(auditRows.length, 1);
  assert.equal(auditRows[0].action, "PLEX_SESSION_TERMINATE");
  assert.equal(auditRows[0].target, "77");
});

test("Plex terminate: unknown sessionKey → 404 (session gone) with no terminate and no audit", async () => {
  const admin = await mintSession("ADMIN");
  settings.set("plexServerUrl", PLEX_BASE);
  settings.set("plexAdminToken", "plex-token-1");
  respond = (url) => {
    if (url.pathname === "/status/sessions") return okJson({ MediaContainer: { Metadata: [] } });
    throw new Error(`unexpected Plex fetch ${url}`);
  };
  const res = await plexTerminate(req("http://localhost:3000/api/admin/play-history/terminate-session", { method: "POST", headers: { ...admin.header, "content-type": "application/json" }, body: JSON.stringify({ sessionKey: "does-not-exist" }) }), undefined);
  assert.equal(res.status, 404);
  assert.ok(!fetchCalls.some((c) => c.url.pathname === "/status/sessions/terminate"), "no terminate must be issued for a missing session");
  await flush();
  assert.equal(auditAttempts.length, 0);
});

test("GUARDRAIL 26 (Jellyfin terminate): auditLog throws → 200 {ok:true} kept, the stop fired, swallow logged", async () => {
  const admin = await mintSession("ADMIN");
  settings.set("jellyfinUrl", JF_BASE);
  settings.set("jellyfinApiKey", "jf-key-1");
  respond = (url) => {
    if (url.pathname === "/Sessions") return okJson([{ Id: "jf-uuid", PlaySessionId: "jf-play-key", NowPlayingItem: { Id: "i1", Name: "Arrival", Type: "Movie" }, PlayState: {}, UserName: "louise" }]);
    if (url.pathname.endsWith("/Playing/Stop")) return new Response(null, { status: 204 });
    if (url.pathname.endsWith("/Command")) return new Response(null, { status: 204 });
    throw new Error(`unexpected Jellyfin fetch ${url}`);
  };
  auditThrows = true;
  const res = await jellyfinTerminate(req("http://localhost:3000/api/admin/play-history/terminate-jellyfin-session", { method: "POST", headers: { ...admin.header, "content-type": "application/json" }, body: JSON.stringify({ sessionKey: "jf-play-key" }) }), undefined);
  assert.equal(res.status, 200, "a failed audit write must not 500 an already-terminated Jellyfin session");
  assert.deepEqual(await res.json(), { ok: true });
  assert.ok(fetchCalls.some((c) => c.url.pathname.endsWith("/Playing/Stop")), "the Stop POST fired before the audit");
  await flush();
  assert.equal(auditAttempts.length, 1);
  assert.ok(sawSwallow());
});

test("Jellyfin terminate: happy path → 200 and one JELLYFIN_SESSION_TERMINATE audit row", async () => {
  const admin = await mintSession("ADMIN");
  settings.set("jellyfinUrl", JF_BASE);
  settings.set("jellyfinApiKey", "jf-key-1");
  respond = (url) => {
    if (url.pathname === "/Sessions") return okJson([{ Id: "jf-uuid", PlaySessionId: "jf-play-key", NowPlayingItem: { Id: "i1", Name: "Arrival", Type: "Movie" }, PlayState: {}, UserName: "louise" }]);
    if (url.pathname.endsWith("/Playing/Stop")) return new Response(null, { status: 204 });
    if (url.pathname.endsWith("/Command")) return new Response(null, { status: 204 });
    throw new Error(`unexpected Jellyfin fetch ${url}`);
  };
  const res = await jellyfinTerminate(req("http://localhost:3000/api/admin/play-history/terminate-jellyfin-session", { method: "POST", headers: { ...admin.header, "content-type": "application/json" }, body: JSON.stringify({ sessionKey: "jf-play-key", reason: "wrap it up" }) }), undefined);
  assert.equal(res.status, 200);
  await flush();
  assert.equal(auditRows.length, 1);
  assert.equal(auditRows[0].action, "JELLYFIN_SESSION_TERMINATE");
});

test("Jellyfin terminate: server not configured → 400 before any fetch or audit", async () => {
  const admin = await mintSession("ADMIN");
  // No jellyfinUrl/jellyfinApiKey settings seeded.
  const res = await jellyfinTerminate(req("http://localhost:3000/api/admin/play-history/terminate-jellyfin-session", { method: "POST", headers: { ...admin.header, "content-type": "application/json" }, body: JSON.stringify({ sessionKey: "jf-play-key" }) }), undefined);
  assert.equal(res.status, 400);
  assert.equal(fetchCalls.length, 0, "an unconfigured server must short-circuit before touching the network");
  await flush();
  assert.equal(auditAttempts.length, 0);
});

// ════════════════════════════════════════════════════════════════════════════
// GUARDRAIL 27 — the force-revoke ledger mark lands only after the DB write
// ════════════════════════════════════════════════════════════════════════════

test("GUARDRAIL 27 (revoke one): the DB delete throws → route surfaces it AND leaves no phantom ledger mark", async () => {
  const admin = await mintSession("ADMIN");
  const targetId = seedUser("USER");
  const targetSession = `rev-sess-${seq}`;
  authSessionsById.set(targetSession, { userId: targetId, deviceLabel: "phone", createdAt: new Date() });
  txAuthDeleteThrows = true; // the AuthSession delete inside revokeSessionById fails

  await assert.rejects(
    () => sessionsRevoke(req(`http://localhost:3000/api/admin/users/${targetId}/sessions`, { method: "DELETE", headers: { ...admin.header, "content-type": "application/json" }, body: JSON.stringify({ sessionId: targetSession }) }), ctxFor(targetId)),
    "a failed revoke must propagate (500), not audit a phantom revocation",
  );
  assert.equal(shouldForceDbCheck(targetId, targetSession), false, "guardrail 27: the mark must NOT be set when the DB write never committed");
  await flush();
  assert.equal(auditAttempts.length, 0, "no SESSION_REVOKE audit for a revoke that failed");
});

test("GUARDRAIL 27 (revoke one): happy path → 200, the ledger mark is set (post-commit), audited once", async () => {
  const admin = await mintSession("ADMIN");
  const targetId = seedUser("USER");
  const targetSession = `rev-sess-ok-${seq}`;
  authSessionsById.set(targetSession, { userId: targetId, deviceLabel: "laptop", createdAt: new Date() });
  assert.equal(shouldForceDbCheck(targetId, targetSession), false, "precondition: unmarked before the revoke");

  const res = await sessionsRevoke(req(`http://localhost:3000/api/admin/users/${targetId}/sessions`, { method: "DELETE", headers: { ...admin.header, "content-type": "application/json" }, body: JSON.stringify({ sessionId: targetSession }) }), ctxFor(targetId));
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { ok: true, revoked: targetSession });
  assert.equal(shouldForceDbCheck(targetId, targetSession), true, "the mark is set only after the DB delete committed");
  await flush();
  assert.equal(auditRows.length, 1);
  assert.equal(auditRows[0].action, "SESSION_REVOKE");
});

test("revoke all: happy path → 200 {revoked:'all'}, the whole-user mark is set, audited once", async () => {
  const admin = await mintSession("ADMIN");
  const targetId = seedUser("USER");
  authSessionsById.set(`rev-all-a-${seq}`, { userId: targetId, deviceLabel: "a", createdAt: new Date() });
  const res = await sessionsRevoke(req(`http://localhost:3000/api/admin/users/${targetId}/sessions`, { method: "DELETE", headers: { ...admin.header, "content-type": "application/json" }, body: JSON.stringify({ all: true }) }), ctxFor(targetId));
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { ok: true, revoked: "all" });
  assert.equal(shouldForceDbCheck(targetId, "any-session-of-this-user"), true, "revoke-all force-revalidates every session of the user");
  await flush();
  assert.equal(auditRows.length, 1);
  assert.equal(auditRows[0].action, "SESSION_REVOKE");
});

// ════════════════════════════════════════════════════════════════════════════
// GUARDRAIL 28 — user-delete unlinks MediaServerUser, never hard-deletes it
// ════════════════════════════════════════════════════════════════════════════

test("GUARDRAIL 28 (user-delete): identity is severed by UNLINK (userId→null), never a hard delete", async () => {
  const admin = await mintSession("ADMIN");
  const targetId = seedUser("USER");
  // makeTx().mediaServerUser.deleteMany throws, so a green delete proves no
  // hard-delete was attempted — play history stays attached, just unattributed.
  const res = await userDelete(req(`http://localhost:3000/api/admin/users/${targetId}`, { method: "DELETE", headers: admin.header }), ctxFor(targetId));
  assert.equal(res.status, 200);
  const unlink = txOps.find((o) => o.op === "mediaServerUser.updateMany");
  assert.ok(unlink, "the anonymize must UNLINK the MediaServerUser rows");
  assert.deepEqual(unlink.args, { where: { userId: targetId }, data: { userId: null } });
  assert.equal(txOps.filter((o) => o.op === "mediaServerUser.deleteMany").length, 0, "guardrail 28: never a hard delete");
});

// ════════════════════════════════════════════════════════════════════════════
// Last-admin protection + self-guard (no lockout, no double-audit)
// ════════════════════════════════════════════════════════════════════════════

test("role-change: demoting the LAST admin → 400 (CAS matched 0 rows) with no audit", async () => {
  const admin = await mintSession("ADMIN");
  const targetId = seedUser("ADMIN");
  casRows = 0; // no other active admin remains → the CAS refuses the demotion
  const res = await userPatch(req(`http://localhost:3000/api/admin/users/${targetId}`, { method: "PATCH", headers: { ...admin.header, "content-type": "application/json" }, body: JSON.stringify({ role: "USER" }) }), ctxFor(targetId));
  assert.equal(res.status, 400);
  assert.deepEqual(await res.json(), { error: "Cannot demote the last admin" });
  await flush();
  assert.equal(auditAttempts.length, 0, "a refused demotion must not audit a role change that didn't happen");
});

test("user-delete: deleting the LAST admin → 400 (LastAdminError) with no audit", async () => {
  const admin = await mintSession("ADMIN");
  const targetId = seedUser("ADMIN");
  casRows = 0; // anonymizeUserInTx's last-admin CAS throws LastAdminError
  const res = await userDelete(req(`http://localhost:3000/api/admin/users/${targetId}`, { method: "DELETE", headers: admin.header }), ctxFor(targetId));
  assert.equal(res.status, 400);
  assert.deepEqual(await res.json(), { error: "Cannot delete the last admin" });
  await flush();
  assert.equal(auditAttempts.length, 0);
});

test("role-change: changing your OWN role → 400, no update, no audit", async () => {
  const admin = await mintSession("ADMIN");
  const res = await userPatch(req(`http://localhost:3000/api/admin/users/${admin.userId}`, { method: "PATCH", headers: { ...admin.header, "content-type": "application/json" }, body: JSON.stringify({ role: "USER" }) }), ctxFor(admin.userId));
  assert.equal(res.status, 400);
  assert.deepEqual(await res.json(), { error: "Cannot change your own role" });
  assert.equal(txOps.filter((o) => o.op === "$executeRaw" || o.op === "user.update(top)").length, 0);
  await flush();
  assert.equal(auditAttempts.length, 0);
});

// ════════════════════════════════════════════════════════════════════════════
// Concurrent-delete race → 404 not 500 (trash-application delete)
// ════════════════════════════════════════════════════════════════════════════

test("trash-application delete: a concurrent delete (deleteMany count 0) → 404, not a 500", async () => {
  const admin = await mintSession("ADMIN");
  trashAppsById.set("ta1", { id: "ta1", trashSpec: { trashId: "abc", kind: "quality" } });
  trashDeleteCount = 0; // the row vanished between findUnique and deleteMany
  const res = await trashDelete(req("http://localhost:3000/api/admin/trash-guides/applications/ta1", { method: "DELETE", headers: admin.header }), ctxFor("ta1"));
  assert.equal(res.status, 404, "a lost race must map to 404, never surface an unhandled P2025 as 500");
  await flush();
  assert.equal(auditAttempts.length, 0, "nothing was deleted, so nothing is audited");
});

test("trash-application delete: happy path → 200 and an audit row (this route awaits logAudit inside the request)", async () => {
  const admin = await mintSession("ADMIN");
  trashAppsById.set("ta2", { id: "ta2", trashSpec: { trashId: "xyz", kind: "cf" } });
  trashDeleteCount = 1;
  const res = await trashDelete(req("http://localhost:3000/api/admin/trash-guides/applications/ta2", { method: "DELETE", headers: admin.header }), ctxFor("ta2"));
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { ok: true });
  await flush();
  assert.equal(auditRows.length, 1);
  assert.equal(auditRows[0].target, "trash:application-delete");
});

// ════════════════════════════════════════════════════════════════════════════
// Body caps (guardrail 30)
// ════════════════════════════════════════════════════════════════════════════

test("GUARDRAIL 30 (Plex terminate): an over-cap Content-Length → 413 before any fetch", async () => {
  const admin = await mintSession("ADMIN");
  settings.set("plexServerUrl", PLEX_BASE);
  settings.set("plexAdminToken", "plex-token-1");
  const res = await plexTerminate(req("http://localhost:3000/api/admin/play-history/terminate-session", {
    method: "POST",
    headers: { ...admin.header, "content-type": "application/json", "content-length": String(16384 + 1) },
    body: JSON.stringify({ sessionKey: "77" }),
  }), undefined);
  assert.equal(res.status, 413, "readJsonCapped must reject an over-cap body");
  assert.equal(fetchCalls.length, 0, "the cap fires before the handler touches Plex");
});

test("GUARDRAIL 30 (role-change): malformed JSON → 400 before any mutation", async () => {
  const admin = await mintSession("ADMIN");
  const targetId = seedUser("USER");
  const res = await userPatch(req(`http://localhost:3000/api/admin/users/${targetId}`, { method: "PATCH", headers: { ...admin.header, "content-type": "application/json" }, body: "{not json" }), ctxFor(targetId));
  assert.equal(res.status, 400);
  assert.deepEqual(await res.json(), { error: "Invalid request body" });
  assert.equal(txOps.filter((o) => o.op === "$executeRaw" || o.op === "user.update(top)").length, 0);
});

// ════════════════════════════════════════════════════════════════════════════
// DB restore (/api/admin/backup/db-import) — pre-import GATING only.
// The guardrail-26 audit-throw path is SKIPPED: reaching it needs a real
// PBKDF2-decryptable blob + a live DB (processBackupImport), un-stubbable here.
// ════════════════════════════════════════════════════════════════════════════

test("db-import: no session → 401 (withAdmin fronts the destructive restore)", async () => {
  const res = await dbImport(req("http://localhost:3000/api/admin/backup/db-import", { method: "POST", body: "x" }), undefined);
  assert.equal(res.status, 401);
});

test("db-import: BACKUP_DB_PASSWORD unset OR too short → 503 before touching the body", async () => {
  const admin = await mintSession("ADMIN");
  // beforeEach deletes BACKUP_DB_PASSWORD → the "not configured" gate.
  const unset = await dbImport(req("http://localhost:3000/api/admin/backup/db-import", { method: "POST", headers: admin.header, body: "x" }), undefined);
  assert.equal(unset.status, 503);
  process.env.BACKUP_DB_PASSWORD = "short"; // < 12 chars → the "too short" gate
  const short = await dbImport(req("http://localhost:3000/api/admin/backup/db-import", { method: "POST", headers: admin.header, body: "x" }), undefined);
  assert.equal(short.status, 503);
});
