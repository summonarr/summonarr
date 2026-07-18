// Route-level unit tests for the device/session-management API:
//   GET    /api/sessions             — list the caller's own AuthSession devices
//   DELETE /api/sessions             — revoke ONE session (with step-up auth)
//   POST   /api/sessions/revoke-all  — "sign out everywhere" (two modes)
//
// What THIS file pins (route wiring; the primitives live elsewhere):
//   - guardrail 6a: both routes are withAuth — a missing/garbage session is 401
//     before the handler body. (Wrapper mechanics are owned by tests/
//     api-auth.test.mts.)
//   - GET is scoped to the CALLER: the where filter is the current user's id, the
//     select is the fixed non-secret device field set (AuthSession stores no JWT/
//     token column, so nothing sensitive can leak), and the caller's own row is
//     flagged isCurrent.
//   - DELETE ownership: a session that belongs to a DIFFERENT user is 404 — a
//     user can never revoke another user's device. Self-revoke skips step-up;
//     a non-self revoke requires step-up (credential users re-enter the password,
//     SSO users must hold a session younger than 5 minutes).
//   - revoke-all modes: includeCurrent=false deletes every OTHER row and bumps
//     sessionsRevokedAt to a cutoff just before the caller's session; true bumps
//     it to now and deletes ALL rows. The response is { ok, count, includeCurrent }.
//   - GUARDRAIL 27: the in-memory revocation ledger is marked AFTER the DB write,
//     never before. Pinned by probing shouldForceDbCheck INSIDE the transaction's
//     delete (still false there) vs. after the route returns (true) — and, on a
//     failed DB write, the mark is never reached (the route 500s and the ledger
//     stays clean). The ledger's OWN semantics (FIFO bound, namespaces) are owned
//     by tests/session-revocation.test.mts; revokeSessionById/revokeAllUserSessions
//     internals (the sessionsRevokedAt cutoff math) live in src/lib/auth.ts.
//
// No DB or network: the AuthSession/User delegates and $transaction are shadowed
// in-memory, and the session JWTs are REAL jose tokens. The step-up password is a
// REAL scrypt hash (verifyPassword runs for real). These routes read the session
// from req.headers (bearer/cookie) — NOT next/headers cookies() — and use no
// after()/maintenanceGuard, so no async-storage scope is needed.
import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";

process.env.TOKEN_ENCRYPTION_KEY = "ab".repeat(32); // prisma.ts pulls in token-crypto
process.env.NEXTAUTH_SECRET = "sessions-routes-test-secret-0123456789abcdef"; // session JWT HMAC
process.env.AUTH_URL = "http://localhost:3000"; // insecure context → unprefixed cookie name
process.env.TRUST_PROXY = "true"; // silence rate-limit's module-load warning; trust XFF
(process.env as Record<string, string | undefined>).NODE_ENV = "test";

// No network, ever.
globalThis.fetch = (() => {
  throw new Error("unexpected network call from sessions-routes tests");
}) as unknown as typeof fetch;

const warns: string[] = [];
const errors: string[] = [];
console.warn = (...args: unknown[]) => { warns.push(args.map(String).join(" ")); };
console.error = (...args: unknown[]) => { errors.push(args.map(String).join(" ")); };

// Dynamic imports so the env/global stubs above precede the module-graph load.
const { NextRequest } = await import("next/server");
const { prisma } = await import("../src/lib/prisma.ts");
const { shadowPrismaModel, shadowPrismaClientMethod } = await import("./_helpers.mts");
const { signSessionJwt } = await import("../src/lib/session-jwt.ts");
const { getSessionCookieName } = await import("../src/lib/session-cookie.ts");
const { hashPassword } = await import("../src/lib/password-hash.ts");
const { shouldForceDbCheck } = await import("../src/lib/session-revocation.ts");

// ── recording op log ─────────────────────────────────────────────────────────
type Op = { op: string; args?: unknown };
const ops: Op[] = [];
const rec = (op: string, args?: unknown) => { ops.push({ op, args }); };
function opsOf(name: string): Op[] {
  return ops.filter((o) => o.op === name);
}

// ── in-memory DB state ────────────────────────────────────────────────────────
type DbUser = {
  role: string;
  permissions: bigint;
  mediaServer: string | null;
  sessionsRevokedAt: Date | null;
  passwordChangedAt: Date | null;
  deactivatedAt: Date | null;
  email: string | null;
  notificationEmail: string | null;
  passwordHash: string | null;
};
type SessionRow = {
  sessionId: string;
  userId: string;
  deviceType: string;
  deviceLabel: string | null;
  ipAddress: string | null;
  createdAt: Date;
  lastSeenAt: Date;
  expiresAt: Date;
};
const usersById = new Map<string, DbUser>();
const authSessionRows = new Map<string, SessionRow>();

// Guardrail-27 probes: the ledger state captured INSIDE the tx delete (must be
// false — the mark hasn't happened yet). undefined = the delete never ran.
let singleRevokeLedgerAtDelete: boolean | undefined;
let revokeAllLedgerAtDelete: boolean | undefined;
let deleteThrows = false; // flip tx.authSession.delete to reject (revoke-failure path)

shadowPrismaModel(prisma, "authSession", {
  findUnique: async (args: { where: { sessionId: string } }) =>
    authSessionRows.get(args.where.sessionId) ?? null,
  findMany: async (args: { where: { userId: string } }) => {
    rec("authSession.findMany", args);
    return [...authSessionRows.values()]
      .filter((r) => r.userId === args.where.userId)
      .sort((a, b) => b.lastSeenAt.getTime() - a.lastSeenAt.getTime());
  },
  // lastSeenAt fire-and-forget touch on the auth path — no-op.
  update: async () => ({}),
});

shadowPrismaModel(prisma, "user", {
  findUnique: async (args: { where: { id: string } }) => {
    const u = usersById.get(args.where.id);
    return u ? { ...u } : null;
  },
  update: async () => ({}),
});

// logAudit (swallowing) writes here — a no-op success keeps the happy path clean.
shadowPrismaModel(prisma, "auditLog", {
  create: async (args: unknown) => { rec("auditLog.create", args); return {}; },
});

// The interactive $transaction used by revokeSessionById (single) and the
// revoke-all route. The tx object mutates the same maps and captures the ledger
// state at delete-time so guardrail 27 (mark-after-write) is observable.
const txObj = {
  authSession: {
    findUnique: async (args: { where: { sessionId: string } }) =>
      authSessionRows.get(args.where.sessionId) ?? null,
    delete: async (args: { where: { sessionId: string } }) => {
      const row = authSessionRows.get(args.where.sessionId);
      if (row) singleRevokeLedgerAtDelete = shouldForceDbCheck(row.userId, args.where.sessionId);
      if (deleteThrows) throw new Error("stubbed authSession.delete failure");
      authSessionRows.delete(args.where.sessionId);
      rec("tx.authSession.delete", args);
      return {};
    },
    deleteMany: async (args: { where: { userId: string; NOT?: { sessionId: string } } }) => {
      rec("tx.authSession.deleteMany", args);
      revokeAllLedgerAtDelete = shouldForceDbCheck(args.where.userId, "probe-session");
      const notSid = args.where.NOT?.sessionId;
      let count = 0;
      for (const [sid, row] of [...authSessionRows]) {
        if (row.userId !== args.where.userId) continue;
        if (notSid && sid === notSid) continue;
        authSessionRows.delete(sid);
        count++;
      }
      return { count };
    },
  },
  user: {
    findUnique: async (args: { where: { id: string } }) => {
      const u = usersById.get(args.where.id);
      return u ? { ...u } : null;
    },
    update: async (args: { where: { id: string }; data: { sessionsRevokedAt: Date } }) => {
      rec("tx.user.update", args);
      const u = usersById.get(args.where.id);
      if (u) u.sessionsRevokedAt = args.data.sessionsRevokedAt;
      return {};
    },
  },
};
shadowPrismaClientMethod(prisma, "$transaction", async (fn: unknown) => {
  if (Array.isArray(fn)) return Promise.all(fn);
  return (fn as (tx: typeof txObj) => Promise<unknown>)(txObj);
});

// ── fixtures ──────────────────────────────────────────────────────────────────
let seq = 0;
const CORRECT_PASSWORD = "correct-horse-battery-staple";
const PASSWORD_HASH = await hashPassword(CORRECT_PASSWORD); // one real scrypt at load

async function mintSession(opts: {
  passwordHash?: string | null;
  createdAt?: Date;
  deviceLabel?: string;
} = {}): Promise<{ userId: string; sessionId: string; token: string }> {
  seq++;
  const userId = `user-${seq}`;
  const sessionId = `sess-${seq}`;
  usersById.set(userId, {
    role: "USER",
    permissions: 0n,
    mediaServer: null,
    sessionsRevokedAt: null,
    passwordChangedAt: null,
    deactivatedAt: null,
    email: `user-${seq}@example.com`,
    notificationEmail: null,
    passwordHash: opts.passwordHash ?? null,
  });
  authSessionRows.set(sessionId, {
    sessionId,
    userId,
    deviceType: "desktop",
    deviceLabel: opts.deviceLabel ?? "Chrome on macOS",
    ipAddress: "203.0.113.10",
    createdAt: opts.createdAt ?? new Date(),
    lastSeenAt: new Date(),
    expiresAt: new Date(Date.now() + 86_400_000),
  });
  const iat = Math.floor(Date.now() / 1000);
  const token = await signSessionJwt(
    { id: userId, role: "USER", permissions: "0", provider: "credentials", sessionId, expiresAt: iat + 86_400 },
    { expiresInSeconds: 7_200, iat },
  );
  return { userId, sessionId, token };
}

// A second (non-caller) device for a user — no JWT, just an AuthSession row.
function addDevice(userId: string, sessionId: string, over: Partial<SessionRow> = {}): void {
  authSessionRows.set(sessionId, {
    sessionId,
    userId,
    deviceType: "mobile",
    deviceLabel: "iPhone",
    ipAddress: "203.0.113.20",
    createdAt: new Date(Date.now() - 60_000),
    lastSeenAt: new Date(Date.now() - 30_000),
    expiresAt: new Date(Date.now() + 86_400_000),
    ...over,
  });
}

const COOKIE = getSessionCookieName();
type Req = InstanceType<typeof NextRequest>;

function sessionsReq(path: string, token: string | null, init: { method: string; body?: string } = { method: "GET" }): Req {
  return new NextRequest(`http://localhost:3000/api/sessions${path}`, {
    method: init.method,
    headers: {
      ...(token ? { cookie: `${COOKIE}=${token}` } : {}),
      "content-type": "application/json",
      "x-forwarded-for": "203.0.113.99",
    },
    ...(init.body !== undefined ? { body: init.body } : {}),
  });
}

// Route handlers (imported AFTER every stub is in place).
const { GET: listSessions, DELETE: deleteSession } = await import("../src/app/api/sessions/route.ts");
const { POST: revokeAll } = await import("../src/app/api/sessions/revoke-all/route.ts");

async function getSessions(token: string | null): Promise<Response> {
  return listSessions(sessionsReq("", token), undefined);
}
async function del(token: string | null, body: unknown): Promise<Response> {
  return deleteSession(sessionsReq("", token, { method: "DELETE", body: JSON.stringify(body) }), undefined);
}
async function postRevokeAll(token: string | null, body?: unknown): Promise<Response> {
  return revokeAll(
    sessionsReq("/revoke-all", token, { method: "POST", body: body === undefined ? undefined : JSON.stringify(body) }),
    undefined,
  );
}

beforeEach(() => {
  ops.length = 0;
  warns.length = 0;
  errors.length = 0;
  singleRevokeLedgerAtDelete = undefined;
  revokeAllLedgerAtDelete = undefined;
  deleteThrows = false;
  // Fresh user/session ids per test (seq keeps climbing), so no cross-test ledger
  // bleed — a userId marked in an earlier test is never reused here.
});

// ═══════════════════════════ GET /api/sessions ═══════════════════════════════

test("GET without a session → 401 Unauthorized", async () => {
  const res = await getSessions(null);
  assert.equal(res.status, 401);
  assert.deepEqual(await res.json(), { error: "Unauthorized" });
  assert.equal(opsOf("authSession.findMany").length, 0);
});

test("GET lists ONLY the caller's devices, with a non-secret select and the caller's row flagged isCurrent", async () => {
  const caller = await mintSession({ deviceLabel: "Chrome on macOS" });
  addDevice(caller.userId, "sess-other-device", { deviceLabel: "iPad", lastSeenAt: new Date(Date.now() - 120_000) });
  // A completely different user's device that must NOT appear.
  addDevice("intruder", "sess-intruder");

  const res = await getSessions(caller.token);
  assert.equal(res.status, 200);
  const rows = (await res.json()) as Array<{ sessionId: string; isCurrent: boolean }>;

  // Scope: exactly the caller's two devices, none of the intruder's.
  const args = opsOf("authSession.findMany")[0].args as { where: { userId: string }; select: Record<string, boolean> };
  assert.equal(args.where.userId, caller.userId, "the list is scoped to the current user");
  assert.deepEqual(
    args.select,
    { id: true, sessionId: true, deviceType: true, deviceLabel: true, ipAddress: true, createdAt: true, lastSeenAt: true, expiresAt: true },
    "the select is the fixed non-secret device field set",
  );
  assert.equal("token" in args.select, false, "no token/JWT material is ever selected");

  assert.equal(rows.length, 2);
  assert.ok(rows.every((r) => r.sessionId !== "sess-intruder"), "another user's session must never be listed");
  const current = rows.find((r) => r.sessionId === caller.sessionId);
  const other = rows.find((r) => r.sessionId === "sess-other-device");
  assert.equal(current?.isCurrent, true, "the caller's own session is flagged current");
  assert.equal(other?.isCurrent, false, "a sibling device is not current");
});

// ═══════════════════════ DELETE /api/sessions (single) ═══════════════════════

test("DELETE without a session → 401; a missing sessionId → 400", async () => {
  const unauth = await del(null, { sessionId: "whatever" });
  assert.equal(unauth.status, 401);

  const caller = await mintSession();
  const noId = await del(caller.token, {});
  assert.equal(noId.status, 400);
  assert.deepEqual(await noId.json(), { error: "sessionId required" });
});

test("DELETE another user's session → 404 (a user can never revoke a device they don't own)", async () => {
  const caller = await mintSession();
  addDevice("victim", "sess-victim"); // belongs to someone else

  const res = await del(caller.token, { sessionId: "sess-victim" });
  assert.equal(res.status, 404);
  assert.deepEqual(await res.json(), { error: "Not found" });
  assert.equal(opsOf("tx.authSession.delete").length, 0, "no revoke for a non-owned session");
  assert.ok(authSessionRows.has("sess-victim"), "the victim's session is untouched");
});

test("DELETE of the caller's OWN session skips step-up, revokes via the tx, and marks the ledger AFTER the delete (guardrail 27)", async () => {
  const caller = await mintSession();
  assert.equal(shouldForceDbCheck(caller.userId, caller.sessionId), false, "unmarked before the revoke");

  const res = await del(caller.token, { sessionId: caller.sessionId });
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { ok: true });

  assert.equal(opsOf("tx.authSession.delete").length, 1, "the session row is deleted in the tx");
  assert.equal(authSessionRows.has(caller.sessionId), false);
  // Guardrail 27: the in-memory mark must not exist at delete-time, only after.
  assert.equal(singleRevokeLedgerAtDelete, false, "the ledger is NOT marked before the DB write commits");
  assert.equal(shouldForceDbCheck(caller.userId, caller.sessionId), true, "the session is force-revoked after the write");
  assert.equal(opsOf("auditLog.create").length, 1, "a successful revoke is audited");
});

test("DELETE non-self by a credential user requires the password: missing → 401 password-required, wrong → 401 invalid-password, correct → 200", async () => {
  const caller = await mintSession({ passwordHash: PASSWORD_HASH });
  addDevice(caller.userId, "sess-laptop");

  const noPw = await del(caller.token, { sessionId: "sess-laptop" });
  assert.equal(noPw.status, 401);
  assert.deepEqual(await noPw.json(), { error: "password-required", message: "Confirm your password to revoke this device." });
  assert.ok(authSessionRows.has("sess-laptop"), "no revoke without the step-up password");

  const wrongPw = await del(caller.token, { sessionId: "sess-laptop", confirmPassword: "not-it" });
  assert.equal(wrongPw.status, 401);
  assert.deepEqual(await wrongPw.json(), { error: "invalid-password" });
  assert.ok(authSessionRows.has("sess-laptop"));

  const ok = await del(caller.token, { sessionId: "sess-laptop", confirmPassword: CORRECT_PASSWORD });
  assert.equal(ok.status, 200);
  assert.deepEqual(await ok.json(), { ok: true });
  assert.equal(authSessionRows.has("sess-laptop"), false, "the correct password lets the revoke through");
});

test("DELETE non-self by an SSO user (no password) turns on session recency: a recent caller session → 200, an old one → 401 session-too-old", async () => {
  const recent = await mintSession({ passwordHash: null, createdAt: new Date() });
  addDevice(recent.userId, "sess-sso-a");
  const okRes = await del(recent.token, { sessionId: "sess-sso-a" });
  assert.equal(okRes.status, 200, "a full IdP sign-in within 5 minutes authorizes the revoke");
  assert.equal(authSessionRows.has("sess-sso-a"), false);

  const stale = await mintSession({ passwordHash: null, createdAt: new Date(Date.now() - 10 * 60_000) });
  addDevice(stale.userId, "sess-sso-b");
  const oldRes = await del(stale.token, { sessionId: "sess-sso-b" });
  assert.equal(oldRes.status, 401);
  assert.deepEqual(await oldRes.json(), { error: "session-too-old", message: "Recent sign-in required to revoke other devices." });
  assert.ok(authSessionRows.has("sess-sso-b"), "a stale SSO session cannot revoke other devices");
});

test("DELETE surfaces a revoke DB failure as 500 and NEVER marks the ledger (guardrail 27: no phantom mark on a failed write)", async () => {
  const caller = await mintSession();
  deleteThrows = true; // the tx delete inside revokeSessionById rejects

  const res = await del(caller.token, { sessionId: caller.sessionId });
  assert.equal(res.status, 500);
  assert.deepEqual(await res.json(), { error: "Failed to revoke session" });
  assert.equal(shouldForceDbCheck(caller.userId, caller.sessionId), false, "a failed write leaves the ledger clean");
  assert.equal(opsOf("auditLog.create").length, 0, "no audit row for a revoke that never committed");
  assert.ok(errors.some((e) => e.includes("[sessions] revoke failed")));
});

test("DELETE is per-user rate-limited (10/min): the 11th attempt → 429 before the body is read", async () => {
  const caller = await mintSession();
  for (let i = 0; i < 10; i++) {
    const r = await del(caller.token, { sessionId: "ghost" }); // 404s, but consumes the bucket
    assert.equal(r.status, 404, `call ${i} should reach the ownership check`);
  }
  const limited = await del(caller.token, { sessionId: "ghost" });
  assert.equal(limited.status, 429);
  assert.deepEqual(await limited.json(), { error: "rate_limit", message: "Too many revoke attempts. Try again in a minute." });
});

// ═══════════════════ POST /api/sessions/revoke-all ═══════════════════════════

test("revoke-all without a session → 401", async () => {
  const res = await postRevokeAll(null, { confirmPassword: "x" });
  assert.equal(res.status, 401);
  assert.deepEqual(await res.json(), { error: "Unauthorized" });
});

test("revoke-all by a credential user demands the password: missing → 401, wrong → 401", async () => {
  const caller = await mintSession({ passwordHash: PASSWORD_HASH });
  const noPw = await postRevokeAll(caller.token, {});
  assert.equal(noPw.status, 401);
  assert.deepEqual(await noPw.json(), { error: "password-required", message: "Confirm your password to sign out other devices." });

  const wrongPw = await postRevokeAll(caller.token, { confirmPassword: "nope" });
  assert.equal(wrongPw.status, 401);
  assert.deepEqual(await wrongPw.json(), { error: "invalid-password" });
  assert.equal(opsOf("tx.authSession.deleteMany").length, 0, "no deletion until step-up passes");
});

test("revoke-all (includeCurrent=false) deletes every OTHER device, keeps the caller, and marks the user ledger AFTER the delete (guardrail 27)", async () => {
  const caller = await mintSession({ passwordHash: PASSWORD_HASH });
  addDevice(caller.userId, "sess-phone");
  addDevice(caller.userId, "sess-tv");
  assert.equal(shouldForceDbCheck(caller.userId, "anything"), false, "unmarked before revoke-all");

  const res = await postRevokeAll(caller.token, { confirmPassword: CORRECT_PASSWORD });
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { ok: true, count: 2, includeCurrent: false });

  // The two sibling devices are gone; the caller's own session survives.
  assert.equal(authSessionRows.has("sess-phone"), false);
  assert.equal(authSessionRows.has("sess-tv"), false);
  assert.ok(authSessionRows.has(caller.sessionId), "the caller stays signed in when includeCurrent=false");
  // The deleteMany excluded the caller's session id.
  const dm = opsOf("tx.authSession.deleteMany")[0].args as { where: { userId: string; NOT?: { sessionId: string } } };
  assert.equal(dm.where.NOT?.sessionId, caller.sessionId);
  // Guardrail 27: user ledger mark comes after the delete.
  assert.equal(revokeAllLedgerAtDelete, false, "the user is NOT force-revalidated before the DB delete");
  assert.equal(shouldForceDbCheck(caller.userId, "anything"), true, "the user is force-revalidated after the delete");
  // A sessionsRevokedAt cutoff just before the caller's createdAt was written.
  assert.equal(opsOf("tx.user.update").length, 1, "the cross-replica cutoff is bumped");
});

test("revoke-all (includeCurrent=true) bumps sessionsRevokedAt to now and deletes ALL rows including the caller's", async () => {
  const caller = await mintSession({ passwordHash: PASSWORD_HASH });
  addDevice(caller.userId, "sess-phone2");

  const res = await postRevokeAll(caller.token, { confirmPassword: CORRECT_PASSWORD, includeCurrent: true });
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { ok: true, count: 2, includeCurrent: true });
  assert.equal(authSessionRows.has(caller.sessionId), false, "includeCurrent=true signs the caller out too");
  assert.equal(authSessionRows.has("sess-phone2"), false);
  // sessionsRevokedAt was bumped to a fresh 'now' (the compromise mode).
  const upd = opsOf("tx.user.update")[0].args as { data: { sessionsRevokedAt: Date } };
  assert.ok(Date.now() - upd.data.sessionsRevokedAt.getTime() < 5_000, "the full-revoke cutoff is ~now");
  assert.equal(shouldForceDbCheck(caller.userId, "anything"), true);
});

test("revoke-all SSO path: a recent caller session with an empty body succeeds; an old one → 401 session-too-old", async () => {
  // Tolerant body (readJsonCappedOr): an SSO caller may send no body at all.
  const recent = await mintSession({ passwordHash: null, createdAt: new Date() });
  addDevice(recent.userId, "sess-sso-c");
  const okRes = await postRevokeAll(recent.token); // no body
  assert.equal(okRes.status, 200);
  assert.deepEqual(await okRes.json(), { ok: true, count: 1, includeCurrent: false });

  ops.length = 0; // isolate the stale call's op log from the successful one above
  const stale = await mintSession({ passwordHash: null, createdAt: new Date(Date.now() - 10 * 60_000) });
  const oldRes = await postRevokeAll(stale.token, {});
  assert.equal(oldRes.status, 401);
  assert.deepEqual(await oldRes.json(), { error: "session-too-old", message: "Recent sign-in required to sign out other devices." });
  assert.equal(opsOf("tx.authSession.deleteMany").length, 0, "a stale SSO session revokes nothing");
});

test("revoke-all is per-user rate-limited (5/hour): the 6th attempt → 429", async () => {
  const caller = await mintSession({ passwordHash: PASSWORD_HASH });
  for (let i = 0; i < 5; i++) {
    const r = await postRevokeAll(caller.token, {}); // 401 password-required, but consumes the bucket
    assert.equal(r.status, 401, `call ${i} should pass the rate gate`);
  }
  const limited = await postRevokeAll(caller.token, {});
  assert.equal(limited.status, 429);
  assert.deepEqual(await limited.json(), { error: "rate_limit", message: "Too many revoke-all attempts. Try again later." });
});
