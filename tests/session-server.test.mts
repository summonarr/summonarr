// Unit tests for readActiveSummonarrSessionFromRequest (src/lib/session-server.ts)
// — the request-aware, DB-checked session read that isCronAuthorized funnels
// through, i.e. the "admin session" half of the auth on every public sync/cron
// route the proxy does NOT gate. The contracts pinned here:
//   - bearer-FIRST resolution (guardrail 6b): a Bearer token is resolved before
//     the cookie, and an INVALID bearer must yield null WITHOUT falling back to
//     a valid cookie — the whole point of bearer-first is that a forged cookie
//     can never ride a request that a bearer made CSRF-exempt upstream;
//   - a non-Bearer Authorization header (e.g. Basic) is not a bearer: the
//     cookie is then the session source;
//   - the cookie is read under the exact session-cookie name via
//     parseSessionCookie (name-exact match, multi-cookie headers work);
//   - the result is DB-RECONCILED via verifyAndRefreshSession, not JWT-only:
//     a deleted AuthSession row (revocation), a deactivated user, and an
//     expired/tampered JWT all yield null, and a DB role change surfaces in
//     the returned claims (with the sessionId rotated);
//   - fail-closed plumbing: no token ⇒ null with zero DB reads, and a THROWING
//     DB read ⇒ null (the caller then falls through to its CRON_SECRET path)
//     — never an exception.
//
// NOT covered here — unreachable without a request scope: readSummonarrSession
// and readActiveSummonarrSession call next/headers cookies() unconditionally,
// and under the real next/headers implementation the loader wires up, that
// throws "`cookies` was called outside a request scope" before any module
// logic runs (verified empirically). Their verify logic is the same
// session-jwt/session-refresh machinery exercised through the request-aware
// reader below and in tests/session-refresh-rotation.test.mts.
//
// The DB surface (authSession/user lookups, the rotation $transaction) is
// stubbed in-memory on the shared client (the session-refresh-rotation.test
// pattern); the JWTs are REAL jose tokens. All tokens use provider
// "credentials" so the plex-membership allowlist path never runs — fetch is
// stubbed to throw to prove no network is touched.
import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";

process.env.TOKEN_ENCRYPTION_KEY = "ab".repeat(32); // prisma.ts pulls in token-crypto
process.env.NEXTAUTH_SECRET = "session-server-test-secret-0123456789abcdef";
process.env.AUTH_URL = "http://localhost:3000"; // insecure context → unprefixed cookie name

// No network, ever: the credentials provider path must not fetch anything.
globalThis.fetch = (() => {
  throw new Error("unexpected network call from session-server tests");
}) as unknown as typeof fetch;

const errors: string[] = [];
console.error = (...args: unknown[]) => { errors.push(args.map(String).join(" ")); };

// Dynamic imports so the env/global stubs above genuinely precede the
// module-graph load (static imports would hoist — the trakt.test pattern).
const { NextRequest } = await import("next/server");
const { prisma } = await import("../src/lib/prisma.ts");
const { signSessionJwt } = await import("../src/lib/session-jwt.ts");
const { getSessionCookieName } = await import("../src/lib/session-cookie.ts");
const { readActiveSummonarrSessionFromRequest } = await import("../src/lib/session-server.ts");

// ── in-memory DB state ──────────────────────────────────────────────────────
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
let throwOnSessionLookup = false;

function makeDbUser(overrides: Partial<DbUser> = {}): DbUser {
  return {
    role: "USER",
    permissions: 0n,
    mediaServer: null,
    sessionsRevokedAt: null,
    passwordChangedAt: null,
    deactivatedAt: null,
    email: "u@example.com",
    notificationEmail: null,
    ...overrides,
  };
}

const authSessionStub = {
  findUnique: async (args: { where: { sessionId: string } }) => {
    dbReads++;
    if (throwOnSessionLookup) throw new Error("unit-test DB outage");
    return sessionRows.has(args.where.sessionId)
      ? { id: `row-${args.where.sessionId}`, sessionId: args.where.sessionId }
      : null;
  },
  // lastSeenAt fire-and-forget touch — no-op.
  update: async () => ({}),
};

const userStub = {
  findUnique: async (args: { where: { id: string } }) => {
    dbReads++;
    const u = usersById.get(args.where.id);
    return u ? { ...u } : null;
  },
  update: async (args: { where: { id: string }; data: { sessionsRevokedAt?: Date } }) => {
    const u = usersById.get(args.where.id);
    if (u && args.data.sessionsRevokedAt) u.sessionsRevokedAt = args.data.sessionsRevokedAt;
    return {};
  },
};

// The privilege-change rotation runs inside an interactive $transaction — hand
// the callback a tx facade over the same in-memory state (renaming the
// sessionId row, bumping the revocation cutoff).
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
const transactionStub = async (fn: (tx: typeof txStub) => Promise<unknown>) => fn(txStub);

(prisma as unknown as { authSession: unknown }).authSession = authSessionStub;
(prisma as unknown as { user: unknown }).user = userStub;
(prisma as unknown as { $transaction: unknown }).$transaction = transactionStub;
if (
  (prisma as unknown as { authSession: unknown }).authSession !== authSessionStub ||
  (prisma as unknown as { user: unknown }).user !== userStub ||
  (prisma as unknown as { $transaction: unknown }).$transaction !== transactionStub
) {
  throw new Error("could not shadow prisma with the in-memory stubs — aborting before a real DB query can hang");
}

// ── fixtures ────────────────────────────────────────────────────────────────
let seq = 0;

// Mint a REAL signed session JWT with a backing user + AuthSession row. Tokens
// carry no dbCheckedAt claim, so every verify takes the slow DB-checked path.
async function mintSession(opts: {
  role?: string;
  dbRole?: string;
  iatOffset?: number;
  expiresInSeconds?: number;
  deactivated?: boolean;
} = {}): Promise<{ userId: string; sessionId: string; token: string }> {
  seq++;
  const userId = `user-${seq}`;
  const sessionId = `sess-${seq}`;
  usersById.set(
    userId,
    makeDbUser({
      role: opts.dbRole ?? opts.role ?? "USER",
      deactivatedAt: opts.deactivated ? new Date() : null,
    }),
  );
  sessionRows.add(sessionId);
  const iat = Math.floor(Date.now() / 1000) + (opts.iatOffset ?? 0);
  const token = await signSessionJwt(
    {
      id: userId,
      role: opts.role ?? "USER",
      permissions: "0",
      provider: "credentials",
      sessionId,
      expiresAt: iat + 86_400,
    },
    { expiresInSeconds: opts.expiresInSeconds ?? 7_200, iat },
  );
  return { userId, sessionId, token };
}

function makeReq(headers: Record<string, string> = {}): InstanceType<typeof NextRequest> {
  return new NextRequest("http://localhost:3000/api/sync", { method: "POST", headers });
}

const COOKIE = getSessionCookieName(); // "summonarr-session" under the http AUTH_URL above

beforeEach(() => {
  dbReads = 0;
  throwOnSessionLookup = false;
});

// ── happy paths: the two transports ─────────────────────────────────────────

test("a valid Bearer token resolves to DB-reconciled claims (native-client transport)", async () => {
  const { userId, sessionId, token } = await mintSession();
  const claims = await readActiveSummonarrSessionFromRequest(
    makeReq({ authorization: `Bearer ${token}` }),
  );
  assert.ok(claims, "a live bearer session must resolve");
  assert.equal(claims.id, userId);
  assert.equal(claims.sessionId, sessionId);
  assert.equal(claims.role, "USER");
  assert.ok(dbReads >= 2, "the read must be DB-checked (AuthSession + User), not JWT-only");
});

test("a valid session cookie resolves when no Authorization header is present (web transport)", async () => {
  const { userId, token } = await mintSession();
  const claims = await readActiveSummonarrSessionFromRequest(
    makeReq({ cookie: `${COOKIE}=${token}` }),
  );
  assert.ok(claims);
  assert.equal(claims.id, userId);
});

test("the session cookie is found among other cookies, by exact name only", async () => {
  const { userId, token } = await mintSession();
  const found = await readActiveSummonarrSessionFromRequest(
    makeReq({ cookie: `theme=dark; ${COOKIE}=${token}; other=1` }),
  );
  assert.equal(found?.id, userId);

  // A prefixed near-miss cookie name must NOT be read as the session — and
  // with no token found, the DB is never consulted.
  dbReads = 0;
  const nearMiss = await readActiveSummonarrSessionFromRequest(
    makeReq({ cookie: `x${COOKIE}=${token}` }),
  );
  assert.equal(nearMiss, null);
  assert.equal(dbReads, 0);
});

// ── bearer-first precedence (guardrail 6b) ──────────────────────────────────

test("bearer WINS over a simultaneously-present cookie", async () => {
  const cookieUser = await mintSession();
  const bearerUser = await mintSession();
  const claims = await readActiveSummonarrSessionFromRequest(
    makeReq({
      authorization: `Bearer ${bearerUser.token}`,
      cookie: `${COOKIE}=${cookieUser.token}`,
    }),
  );
  assert.equal(claims?.id, bearerUser.userId, "the bearer identity must be the one resolved");
});

test("an INVALID bearer yields null and never falls back to a valid cookie (forged-cookie defense)", async () => {
  const { token } = await mintSession(); // a perfectly valid cookie session
  const claims = await readActiveSummonarrSessionFromRequest(
    makeReq({
      authorization: "Bearer not-a-real-jwt",
      cookie: `${COOKIE}=${token}`,
    }),
  );
  assert.equal(claims, null);
});

test("a non-Bearer Authorization scheme is not a bearer — the cookie still authenticates", async () => {
  const { userId, token } = await mintSession();
  const claims = await readActiveSummonarrSessionFromRequest(
    makeReq({
      authorization: "Basic dXNlcjpwYXNz",
      cookie: `${COOKIE}=${token}`,
    }),
  );
  assert.equal(claims?.id, userId);
});

// ── null paths: absent, expired, tampered, revoked, deactivated ─────────────

test("no auth material at all → null with zero DB reads", async () => {
  assert.equal(await readActiveSummonarrSessionFromRequest(makeReq()), null);
  assert.equal(dbReads, 0);
});

test("an expired JWT → null before any DB read", async () => {
  // iat two hours ago with a one-hour lifetime: exp is an hour in the past.
  const { token } = await mintSession({ iatOffset: -7_200, expiresInSeconds: 3_600 });
  dbReads = 0;
  assert.equal(
    await readActiveSummonarrSessionFromRequest(makeReq({ authorization: `Bearer ${token}` })),
    null,
  );
  assert.equal(dbReads, 0, "signature/exp verification must fail closed without touching the DB");
});

test("a tampered token (signature broken) → null", async () => {
  const { token } = await mintSession();
  const [h, p, sig] = token.split(".");
  const tampered = `${h}.${p}.${sig.slice(0, -2)}${sig.endsWith("AA") ? "BB" : "AA"}`;
  assert.equal(
    await readActiveSummonarrSessionFromRequest(makeReq({ authorization: `Bearer ${tampered}` })),
    null,
  );
});

test("a revoked session (AuthSession row deleted) → null even though the JWT still verifies", async () => {
  const { sessionId, token } = await mintSession();
  sessionRows.delete(sessionId); // "log out this device" on any replica
  assert.equal(
    await readActiveSummonarrSessionFromRequest(makeReq({ authorization: `Bearer ${token}` })),
    null,
  );
});

test("a deactivated (self-deleted) user → null despite a valid token and live session row", async () => {
  const { token } = await mintSession({ deactivated: true });
  assert.equal(
    await readActiveSummonarrSessionFromRequest(makeReq({ cookie: `${COOKIE}=${token}` })),
    null,
  );
});

test("a throwing DB read → null, never an exception (callers fall through to CRON_SECRET)", async () => {
  const { token } = await mintSession();
  throwOnSessionLookup = true;
  const claims = await readActiveSummonarrSessionFromRequest(
    makeReq({ authorization: `Bearer ${token}` }),
  );
  assert.equal(claims, null);
});

// ── DB reconciliation ───────────────────────────────────────────────────────

test("a DB role change surfaces in the returned claims, with the sessionId rotated", async () => {
  // Token says USER; the DB says ISSUE_ADMIN (promoted after sign-in).
  const { sessionId, token } = await mintSession({ role: "USER", dbRole: "ISSUE_ADMIN" });
  const claims = await readActiveSummonarrSessionFromRequest(
    makeReq({ authorization: `Bearer ${token}` }),
  );
  assert.ok(claims, "the promoted session must still resolve");
  assert.equal(claims.role, "ISSUE_ADMIN", "authz decisions must see the DB role, not the stale claim");
  assert.notEqual(claims.sessionId, sessionId, "a privilege change must rotate the sessionId");
});
