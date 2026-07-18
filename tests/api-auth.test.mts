// Unit tests for the route-handler auth wrappers in src/lib/api-auth.ts —
// withAuth / withAdmin / withIssueAdmin / withPermission, the guardrail-6a
// contract: the auth check runs BEFORE the handler body and can never be
// forgotten or mis-returned. Division of labour with the sibling files:
//   - tests/api-auth-helpers.test.mts owns hasRole and machineIpAllowed as
//     PURE functions (role hierarchy/case-sensitivity; allowlist matching,
//     TRUST_PROXY fail-closed, XFF trust order);
//   - tests/session-server.test.mts owns readActiveSummonarrSessionFromRequest
//     (src/lib/session-server.ts — the cron-route session reader, a DIFFERENT
//     consumer of the same primitives);
//   - tests/session-jwt.test.mts owns signature/expiry/alg-pin crypto;
//   - tests/session-refresh-rotation.test.mts + tests/session-refresh.test.mts
//     own verifyAndRefreshSession's internals (fast path, slide, cutoffs,
//     rotation);
//   - tests/mobile-auth.test.mts owns parseBearerToken parsing; tests/
//     ua-fingerprint.test.mts, ip-allowlist.test.mts, rate-limit.test.mts own
//     their pure classifiers.
// What THIS file adds — the wrapper semantics none of those pin:
//   - the handler is NEVER invoked on a missing/expired/garbage/revoked
//     session (401) nor on a wrong role/permission (403), and the split is
//     exact: 401 = authentication failed, 403 = authenticated but forbidden
//     (authn is decided before the role gate, so no-session + wrong-role
//     surfaces as 401, never 403);
//   - the role matrix: ADMIN passes withAdmin+withIssueAdmin; ISSUE_ADMIN
//     passes withIssueAdmin but NOT withAdmin; USER passes neither — and
//     withIssueAdmin is bitmask-authoritative (a plain USER granted
//     MANAGE_ISSUES passes; an ISSUE_ADMIN whose explicit mask cleared it is
//     denied);
//   - the session arg handed to the handler mirrors the verified claims
//     (id/role/sessionId/tokenExpiresAt + the EFFECTIVE permission mask);
//   - bearer-first resolution through the wrapper (valid bearer + garbage
//     cookie succeeds; INVALID bearer + valid cookie fails — the coded
//     `bearer ?? cookie` contract never falls back);
//   - req/ctx passthrough (dynamic-route params promise) and handler-response
//     passthrough (same Response object out);
//   - the sliding-refresh Set-Cookie is threaded onto cookie-session responses
//     but withheld from bearer sessions (guardrail 6b: native clients ride
//     their fixed-lifetime token — no Set-Cookie they can't read);
//   - the UA-fingerprint and machine-IP checks are actually WIRED into
//     authenticateRequest (mismatch ⇒ 401 before the handler; bearer skips
//     the fingerprint check).
// NOT covered: requireAuth() called directly — it reads next/headers
// cookies()/headers(), which throw outside a request scope under the real
// next/headers the loader wires up (same unreachability tests/
// session-server.test.mts documents for readSummonarrSession).
//
// No DB or network: the prisma model delegates are shadowed in-memory
// (tests/_helpers.mts), fetch throws, and the JWTs are REAL jose tokens.
// Claim role/permissions always mirror the stubbed DB row so the privilege-
// rotation path never fires here (session-refresh.test.mts owns rotation).
import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";

process.env.TOKEN_ENCRYPTION_KEY = "ab".repeat(32); // prisma.ts pulls in token-crypto
process.env.NEXTAUTH_SECRET = "api-auth-wrapper-test-secret-0123456789abcdef";
process.env.AUTH_URL = "http://localhost:3000"; // insecure context → unprefixed cookie name
// Silence rate-limit's module-load warning AND make getClientIp believe the
// X-Forwarded-For header in the machine-IP wiring tests below.
process.env.TRUST_PROXY = "true";

// No network, ever (the credentials provider path must not fetch anything).
globalThis.fetch = (() => {
  throw new Error("unexpected network call from api-auth tests");
}) as unknown as typeof fetch;

const warns: string[] = [];
const errors: string[] = [];
console.warn = (...args: unknown[]) => { warns.push(args.map(String).join(" ")); };
console.error = (...args: unknown[]) => { errors.push(args.map(String).join(" ")); };

import type { SummonarrSession } from "../src/lib/api-auth.ts";

// Dynamic imports so the env/global stubs above genuinely precede the
// module-graph load (static imports would hoist — the trakt.test pattern).
const { NextRequest, NextResponse } = await import("next/server");
const { prisma } = await import("../src/lib/prisma.ts");
const { shadowPrismaModel, shadowPrismaClientMethod } = await import("./_helpers.mts");
const { signSessionJwt, verifySessionJwt } = await import("../src/lib/session-jwt.ts");
const { getSessionCookieName } = await import("../src/lib/session-cookie.ts");
const { Permission } = await import("../src/lib/permissions.ts");
const { withAuth, withAdmin, withIssueAdmin, withPermission } = await import(
  "../src/lib/api-auth.ts"
);

type Req = InstanceType<typeof NextRequest>;

// ── in-memory DB state (the session-server.test fixture shape) ──────────────
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
const sessionRows = new Set<string>(); // sessionIds with a live AuthSession row
let dbReads = 0;

shadowPrismaModel(prisma, "authSession", {
  findUnique: async (args: { where: { sessionId: string } }) => {
    dbReads++;
    return sessionRows.has(args.where.sessionId)
      ? { id: `row-${args.where.sessionId}`, sessionId: args.where.sessionId }
      : null;
  },
  // lastSeenAt fire-and-forget touch — no-op.
  update: async () => ({}),
});

shadowPrismaModel(prisma, "user", {
  findUnique: async (args: { where: { id: string } }) => {
    dbReads++;
    const u = usersById.get(args.where.id);
    return u ? { ...u } : null;
  },
  update: async () => ({}),
});

// Rotation never fires in this file (claim always mirrors the DB row), but a
// functional $transaction stub keeps an accidental trigger from reaching a
// real client. Mirrors session-server.test.mts.
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
    update: async (args: { where: { id: string }; data: { sessionsRevokedAt: Date } }) => {
      const u = usersById.get(args.where.id);
      if (u) u.sessionsRevokedAt = args.data.sessionsRevokedAt;
      return {};
    },
  },
};
shadowPrismaClientMethod(prisma, "$transaction", async (fn: (tx: typeof txStub) => Promise<unknown>) =>
  fn(txStub),
);

// ── fixtures ────────────────────────────────────────────────────────────────
let seq = 0;

// Mint a REAL signed session JWT with a backing user + AuthSession row. Claim
// role/permissions and the DB row always agree, so every verify takes the
// plain slow path (DB-checked, no rotation).
async function mintSession(opts: {
  role?: string;
  permissions?: string; // decimal mask, mirrored into the DB row
  uaFingerprint?: string;
  machineAllowedIps?: string[];
  iatOffset?: number;
  expiresInSeconds?: number;
} = {}): Promise<{ userId: string; sessionId: string; token: string; expiresAt: number }> {
  seq++;
  const userId = `user-${seq}`;
  const sessionId = `sess-${seq}`;
  const permissions = opts.permissions ?? "0";
  usersById.set(userId, {
    role: opts.role ?? "USER",
    permissions: BigInt(permissions),
    mediaServer: null,
    sessionsRevokedAt: null,
    passwordChangedAt: null,
    deactivatedAt: null,
    email: "u@example.com",
    notificationEmail: null,
  });
  sessionRows.add(sessionId);
  const iat = Math.floor(Date.now() / 1000) + (opts.iatOffset ?? 0);
  const expiresAt = iat + 86_400;
  const token = await signSessionJwt(
    {
      id: userId,
      role: opts.role ?? "USER",
      permissions,
      provider: "credentials",
      sessionId,
      expiresAt,
      ...(opts.uaFingerprint ? { uaFingerprint: opts.uaFingerprint } : {}),
      ...(opts.machineAllowedIps ? { machineAllowedIps: opts.machineAllowedIps } : {}),
    },
    { expiresInSeconds: opts.expiresInSeconds ?? 7_200, iat },
  );
  return { userId, sessionId, token, expiresAt };
}

const COOKIE = getSessionCookieName(); // "summonarr-session" under the http AUTH_URL above

function makeReq(headers: Record<string, string> = {}): Req {
  return new NextRequest("http://localhost:3000/api/test", { method: "GET", headers });
}

function asCookie(token: string): Record<string, string> {
  return { cookie: `${COOKIE}=${token}` };
}

function asBearer(token: string): Record<string, string> {
  return { authorization: `Bearer ${token}` };
}

// A handler probe: records every invocation (req/ctx/session) and returns a
// scriptable response. Rejection tests assert calls.length === 0 — the
// guardrail-6a property that the body can never run unauthorized.
function probe(makeRes?: () => Response) {
  const calls: { req: Req; ctx: unknown; session: SummonarrSession }[] = [];
  const handler = async (req: Req, ctx: unknown, session: SummonarrSession): Promise<Response> => {
    calls.push({ req, ctx, session });
    return makeRes ? makeRes() : NextResponse.json({ ok: true });
  };
  return { calls, handler };
}

async function bodyOf(res: Response): Promise<unknown> {
  return res.json();
}

beforeEach(() => {
  dbReads = 0;
});

// ── 401: authentication failures never reach the handler ────────────────────

test("no auth material at all → 401 Unauthorized, handler not invoked, zero DB reads", async () => {
  const { calls, handler } = probe();
  const res = await withAuth(handler)(makeReq(), undefined);
  assert.equal(res.status, 401);
  assert.deepEqual(await bodyOf(res), { error: "Unauthorized" });
  assert.equal(calls.length, 0);
  assert.equal(dbReads, 0);
});

test("an expired session cookie → 401 before any DB read; handler not invoked", async () => {
  // iat two hours ago with a one-hour lifetime: exp is an hour in the past.
  const { token } = await mintSession({ iatOffset: -7_200, expiresInSeconds: 3_600 });
  dbReads = 0;
  const { calls, handler } = probe();
  const res = await withAuth(handler)(makeReq(asCookie(token)), undefined);
  assert.equal(res.status, 401);
  assert.deepEqual(await bodyOf(res), { error: "Unauthorized" });
  assert.equal(calls.length, 0);
  assert.equal(dbReads, 0, "signature/exp rejection must fail closed without touching the DB");
});

test("a garbage bearer token → 401, handler not invoked", async () => {
  const { calls, handler } = probe();
  const res = await withAuth(handler)(makeReq(asBearer("definitely-not-a-jwt")), undefined);
  assert.equal(res.status, 401);
  assert.equal(calls.length, 0);
});

test("a revoked session (AuthSession row deleted) → 401 even though the JWT still verifies", async () => {
  // Proves the wrapper is DB-checked, not JWT-only: withAuth must see the
  // cross-replica revocation, per guardrail 29's 'never JWT-only' principle.
  const { sessionId, token } = await mintSession();
  sessionRows.delete(sessionId); // "log out this device"
  dbReads = 0;
  const { calls, handler } = probe();
  const res = await withAuth(handler)(makeReq(asCookie(token)), undefined);
  assert.equal(res.status, 401);
  assert.equal(calls.length, 0);
  assert.ok(dbReads > 0, "the revocation must have been read from the DB");
});

test("401 wins over 403: withAdmin with NO session is an authn failure, not Forbidden", async () => {
  // The status split is load-bearing for clients: 401 ⇒ re-authenticate,
  // 403 ⇒ authenticated but not allowed. An unauthenticated request to an
  // admin route must never leak the role gate.
  const { calls, handler } = probe();
  const noSession = await withAdmin(handler)(makeReq(), undefined);
  assert.equal(noSession.status, 401);
  assert.deepEqual(await bodyOf(noSession), { error: "Unauthorized" });

  const { token } = await mintSession({ role: "ADMIN", iatOffset: -7_200, expiresInSeconds: 3_600 });
  const expired = await withAdmin(handler)(makeReq(asCookie(token)), undefined);
  assert.equal(expired.status, 401, "an expired admin token is 401 (authn), never 403");
  assert.equal(calls.length, 0);
});

// ── 403: role and permission gates ──────────────────────────────────────────

test("withAdmin admits ADMIN and runs the handler exactly once", async () => {
  const { token } = await mintSession({ role: "ADMIN" });
  const { calls, handler } = probe();
  const res = await withAdmin(handler)(makeReq(asCookie(token)), undefined);
  assert.equal(res.status, 200);
  assert.equal(calls.length, 1);
});

test("withAdmin rejects ISSUE_ADMIN and USER with 403 Forbidden; handler not invoked", async () => {
  const { calls, handler } = probe();
  for (const role of ["ISSUE_ADMIN", "USER"]) {
    const { token } = await mintSession({ role });
    const res = await withAdmin(handler)(makeReq(asCookie(token)), undefined);
    assert.equal(res.status, 403, `${role} must not pass withAdmin`);
    assert.deepEqual(await bodyOf(res), { error: "Forbidden" });
  }
  assert.equal(calls.length, 0);
});

test("withIssueAdmin admits ADMIN (superbit) and ISSUE_ADMIN (preset carries MANAGE_ISSUES)", async () => {
  const { calls, handler } = probe();
  for (const role of ["ADMIN", "ISSUE_ADMIN"]) {
    const { token } = await mintSession({ role });
    const res = await withIssueAdmin(handler)(makeReq(asCookie(token)), undefined);
    assert.equal(res.status, 200, `${role} must pass withIssueAdmin`);
  }
  assert.equal(calls.length, 2);
});

test("withIssueAdmin rejects a plain USER with 403; handler not invoked", async () => {
  const { token } = await mintSession({ role: "USER" });
  const { calls, handler } = probe();
  const res = await withIssueAdmin(handler)(makeReq(asCookie(token)), undefined);
  assert.equal(res.status, 403);
  assert.deepEqual(await bodyOf(res), { error: "Forbidden" });
  assert.equal(calls.length, 0);
});

test("withIssueAdmin is bitmask-authoritative, not role-label-driven", async () => {
  const { calls, handler } = probe();
  // A plain USER explicitly granted the MANAGE_ISSUES bit passes.
  const granted = await mintSession({
    role: "USER",
    permissions: String(Permission.MANAGE_ISSUES),
  });
  const ok = await withIssueAdmin(handler)(makeReq(asCookie(granted.token)), undefined);
  assert.equal(ok.status, 200, "granting MANAGE_ISSUES to a USER must grant issue access");

  // An ISSUE_ADMIN whose explicit (non-zero, authoritative) mask CLEARED
  // MANAGE_ISSUES is denied — clearing the bit actually revokes access.
  const cleared = await mintSession({
    role: "ISSUE_ADMIN",
    permissions: String(Permission.REQUEST),
  });
  const denied = await withIssueAdmin(handler)(makeReq(asCookie(cleared.token)), undefined);
  assert.equal(denied.status, 403, "an explicit mask without MANAGE_ISSUES must deny issue access");
  assert.equal(calls.length, 1);
});

test("withPermission 'and' mode requires every listed bit (curried composition wiring)", async () => {
  const both = Permission.MANAGE_REQUESTS | Permission.MANAGE_USERS;
  const gate = withPermission([Permission.MANAGE_REQUESTS, Permission.MANAGE_USERS], "and");
  const { calls, handler } = probe();

  const partial = await mintSession({ role: "USER", permissions: String(Permission.MANAGE_REQUESTS) });
  const denied = await gate(handler)(makeReq(asCookie(partial.token)), undefined);
  assert.equal(denied.status, 403, "holding only one of two required bits must 403");
  assert.deepEqual(await bodyOf(denied), { error: "Forbidden" });
  assert.equal(calls.length, 0);

  const full = await mintSession({ role: "USER", permissions: String(both) });
  const ok = await gate(handler)(makeReq(asCookie(full.token)), undefined);
  assert.equal(ok.status, 200);
  assert.equal(calls.length, 1);
});

// ── the session argument handed to the handler ──────────────────────────────

test("the session arg mirrors the verified claims, with the EFFECTIVE permission mask", async () => {
  // Unseeded (0) USER mask → the role preset (REQUEST | REQUEST_MOVIE |
  // REQUEST_TV), applied by claimsToSession via effectivePermissions.
  const user = await mintSession({ role: "USER" });
  const { calls, handler } = probe();
  const res = await withAuth(handler)(makeReq(asCookie(user.token)), undefined);
  assert.equal(res.status, 200);
  const session = calls[0].session;
  assert.equal(session.user.id, user.userId);
  assert.equal(session.user.role, "USER");
  assert.equal(session.user.provider, "credentials");
  assert.equal(session.sessionId, user.sessionId, "no privilege change ⇒ sessionId unrotated");
  assert.equal(session.tokenExpiresAt, user.expiresAt);
  assert.equal(
    session.user.permissions,
    Permission.REQUEST | Permission.REQUEST_MOVIE | Permission.REQUEST_TV,
  );

  // ADMIN with an unseeded mask resolves to the superbit.
  const admin = await mintSession({ role: "ADMIN" });
  await withAuth(handler)(makeReq(asCookie(admin.token)), undefined);
  const adminSession = calls[1].session;
  assert.equal(adminSession.user.role, "ADMIN");
  assert.ok(
    (adminSession.user.permissions & Permission.ADMIN) !== 0n,
    "ADMIN sessions must carry the superbit in the effective mask",
  );

  // A non-zero mask is authoritative — no preset fallback on top of it.
  const explicit = await mintSession({ role: "USER", permissions: String(Permission.MANAGE_ISSUES) });
  await withAuth(handler)(makeReq(asCookie(explicit.token)), undefined);
  assert.equal(calls[2].session.user.permissions, Permission.MANAGE_ISSUES);
});

// ── bearer-first resolution (guardrail 6b) through the wrapper ──────────────

test("a valid bearer with a garbage cookie alongside authenticates as the bearer", async () => {
  const { userId, token } = await mintSession();
  const { calls, handler } = probe();
  const res = await withAuth(handler)(
    makeReq({ ...asBearer(token), cookie: `${COOKIE}=complete-garbage` }),
    undefined,
  );
  assert.equal(res.status, 200);
  assert.equal(calls[0].session.user.id, userId);
});

test("an INVALID bearer + a VALID cookie → 401: bearer-first never falls back to the cookie", async () => {
  // The coded contract is `bearer ?? cookie` — once the Authorization header
  // parses as Bearer, the cookie is never consulted. A forged cookie must not
  // ride a request whose bearer made it CSRF-exempt upstream.
  const { token } = await mintSession(); // a perfectly valid cookie session
  const { calls, handler } = probe();
  const res = await withAuth(handler)(
    makeReq({ authorization: "Bearer not-a-real-jwt", ...asCookie(token) }),
    undefined,
  );
  assert.equal(res.status, 401);
  assert.equal(calls.length, 0);
});

test("when bearer and cookie are BOTH valid, the bearer identity wins", async () => {
  const cookieUser = await mintSession();
  const bearerUser = await mintSession();
  const { calls, handler } = probe();
  const res = await withAuth(handler)(
    makeReq({ ...asBearer(bearerUser.token), ...asCookie(cookieUser.token) }),
    undefined,
  );
  assert.equal(res.status, 200);
  assert.equal(calls[0].session.user.id, bearerUser.userId);
});

// ── req/ctx and response passthrough ────────────────────────────────────────

test("req and ctx reach the handler as the same objects (dynamic-route params promise intact)", async () => {
  const { token } = await mintSession();
  const { calls, handler } = probe();
  const req = makeReq(asCookie(token));
  const ctx = { params: Promise.resolve({ id: "42" }) };
  const res = await withAuth<{ params: Promise<{ id: string }> }>(handler)(req, ctx);
  assert.equal(res.status, 200);
  assert.equal(calls[0].req, req, "the request object must pass through by reference");
  assert.equal(calls[0].ctx, ctx, "the ctx object must pass through by reference");
  const params = await (calls[0].ctx as { params: Promise<{ id: string }> }).params;
  assert.equal(params.id, "42");
});

test("a bearer session's handler Response passes through untouched — same object, no Set-Cookie", async () => {
  const { token } = await mintSession();
  const custom = NextResponse.json(
    { teapot: true },
    { status: 418, headers: { "x-custom": "kept" } },
  );
  const { calls, handler } = probe(() => custom);
  const res = await withAuth(handler)(makeReq(asBearer(token)), undefined);
  assert.equal(calls.length, 1);
  assert.equal(res, custom, "the wrapper must return the handler's Response object itself");
  assert.equal(res.status, 418);
  assert.equal(res.headers.get("x-custom"), "kept");
  assert.deepEqual(await bodyOf(res), { teapot: true });
  assert.equal(
    res.headers.get("set-cookie"),
    null,
    "a bearer client can't read Set-Cookie — the slid token must be withheld (guardrail 6b)",
  );
});

test("a cookie session's response gets the slid token appended as Set-Cookie; bearer does not", async () => {
  // The slow-path verify always re-signs (dbCheckedAt advances), so the
  // wrapper must thread the fresh JWT back — but only on the cookie transport.
  const { userId, token } = await mintSession();
  const { handler } = probe();

  const viaCookie = await withAuth(handler)(makeReq(asCookie(token)), undefined);
  const setCookie = viaCookie.headers.get("set-cookie");
  assert.ok(setCookie, "cookie transport must receive the refreshed session cookie");
  assert.ok(setCookie.startsWith(`${COOKIE}=`), "the refresh must target the session cookie name");
  assert.ok(setCookie.includes("HttpOnly"), "the refreshed cookie must stay HttpOnly");
  const refreshedToken = setCookie.slice(COOKIE.length + 1).split(";")[0];
  assert.notEqual(refreshedToken, token, "the threaded token must be the re-signed one");
  const refreshedClaims = await verifySessionJwt(refreshedToken);
  assert.ok(refreshedClaims, "the threaded token must be a genuine signed session JWT");
  assert.equal(refreshedClaims.id, userId);

  // The SAME token presented as a bearer re-signs too, but the wrapper
  // withholds it (native clients ride the original to expiry).
  const viaBearer = await withAuth(handler)(makeReq(asBearer(token)), undefined);
  assert.equal(viaBearer.headers.get("set-cookie"), null);
});

// ── UA-fingerprint and machine-IP wiring in authenticateRequest ─────────────
// (The pure matchers are exhaustively covered in tests/ua-fingerprint.test.mts
// and tests/api-auth-helpers.test.mts; these pin that the wrapper actually
// calls them and 401s before the handler.)

const CHROME_WIN_UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36";
const FIREFOX_MAC_UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10.15; rv:120.0) Gecko/20100101 Firefox/120.0";

test("a cookie session bound to a UA fingerprint 401s from a different browser family; bearer skips the check", async () => {
  const { calls, handler } = probe();
  const bound = await mintSession({ uaFingerprint: "chrome:windows:desktop" });

  const mismatch = await withAuth(handler)(
    makeReq({ ...asCookie(bound.token), "user-agent": FIREFOX_MAC_UA }),
    undefined,
  );
  assert.equal(mismatch.status, 401, "a fingerprint mismatch on the cookie transport must 401");
  assert.equal(calls.length, 0);

  const match = await withAuth(handler)(
    makeReq({ ...asCookie(bound.token), "user-agent": CHROME_WIN_UA }),
    undefined,
  );
  assert.equal(match.status, 200, "the matching browser family must still authenticate");

  // Bearer sessions deliberately drop UA-binding (guardrail 6b) — the same
  // fingerprinted token from a 'wrong' UA authenticates over bearer.
  const bearer = await withAuth(handler)(
    makeReq({ ...asBearer(bound.token), "user-agent": FIREFOX_MAC_UA }),
    undefined,
  );
  assert.equal(bearer.status, 200);
  assert.equal(calls.length, 2);
});

test("a machine session's mint-time IP allowlist is enforced per request: wrong caller IP → 401", async () => {
  const { calls, handler } = probe();
  const machine = await mintSession({ machineAllowedIps: ["203.0.113.7"] });

  const wrongIp = await withAuth(handler)(
    makeReq({ ...asBearer(machine.token), "x-forwarded-for": "198.51.100.9" }),
    undefined,
  );
  assert.equal(wrongIp.status, 401, "a replayed machine token from an unlisted IP must 401");
  assert.equal(calls.length, 0);

  const allowedIp = await withAuth(handler)(
    makeReq({ ...asBearer(machine.token), "x-forwarded-for": "203.0.113.7" }),
    undefined,
  );
  assert.equal(allowedIp.status, 200);
  assert.equal(calls.length, 1);
});
