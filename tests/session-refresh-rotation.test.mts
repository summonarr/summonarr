// Regression tests for the privilege-change session rotation in
// verifyAndRefreshSession (src/lib/session-refresh.ts).
//
// Rotation renames the AuthSession row, and that rename is the whole revocation
// of the pre-change token. It used to ALSO stamp the per-user sessionsRevokedAt
// cutoff at the presented token's iat — which (`iat <= cutoff`) signed out every
// OTHER device of the user minted earlier: every native app (a bearer token
// keeps its sign-in iat forever) and every browser not re-signed since. Those
// devices' AuthSession rows stayed listed as live. The stamp is gone; the pins
// below hold both halves: the old token dies, no other device does.
//
// The DB surface (authSession/user lookups, the rotation $transaction) is
// stubbed in-memory; the JWTs are REAL jose tokens (NEXTAUTH_SECRET set below).
// markUserForceRevalidate mirrors what invalidateUserSession does on a role
// change and (marks are never consumed) forces every verify onto the slow
// DB-checked path, exactly like production right after a privilege change.
import { test } from "node:test";
import assert from "node:assert/strict";

process.env.NEXTAUTH_SECRET = "session-refresh-rotation-test-secret-0123456789";

const { prisma } = await import("../src/lib/prisma.ts");
const { signSessionJwt } = await import("../src/lib/session-jwt.ts");
const { verifyAndRefreshSession } = await import("../src/lib/session-refresh.ts");
const { markUserForceRevalidate } = await import("../src/lib/session-revocation.ts");

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

let dbUser: DbUser;
let dbSessionId: string;

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
  findUnique: async (args: { where: { sessionId: string } }) =>
    args.where.sessionId === dbSessionId ? { id: "row1", sessionId: dbSessionId } : null,
  // lastSeenAt fire-and-forget touch — no-op.
  update: async () => ({}),
};

const userStub = {
  findUnique: async () => ({ ...dbUser }),
  update: async (args: { data: { sessionsRevokedAt?: Date } }) => {
    if (args.data.sessionsRevokedAt) dbUser.sessionsRevokedAt = args.data.sessionsRevokedAt;
    return {};
  },
};

// The rotation runs inside an interactive $transaction — hand the callback a tx
// facade over the same in-memory state (renaming the sessionId row, bumping the
// revocation cutoff).
const txStub = {
  authSession: {
    findUnique: async (args: { where: { sessionId: string } }) =>
      args.where.sessionId === dbSessionId ? { id: "row1" } : null,
    update: async (args: { data: { sessionId: string } }) => {
      dbSessionId = args.data.sessionId;
      return {};
    },
  },
  user: {
    findUnique: async () => ({ sessionsRevokedAt: dbUser.sessionsRevokedAt }),
    update: async (args: { data: { sessionsRevokedAt: Date } }) => {
      dbUser.sessionsRevokedAt = args.data.sessionsRevokedAt;
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

test("rotated token survives its own revocation cutoff (same-second rotation)", async () => {
  const userId = "user-rotation-1";
  dbSessionId = "sess-old-1";
  // Role changed USER -> ISSUE_ADMIN in the DB; the presented token still says USER.
  dbUser = makeDbUser({ role: "ISSUE_ADMIN" });

  const iat = Math.floor(Date.now() / 1000);
  const token = await signSessionJwt(
    {
      id: userId,
      role: "USER",
      permissions: "0",
      provider: "credentials",
      sessionId: dbSessionId,
      expiresAt: iat + 86_400,
    },
    { expiresInSeconds: 7_200, iat },
  );

  // Production calls invalidateUserSession on a role change, which marks the
  // user for forced DB checks — this is what makes the very next request take
  // the slow path and hit the cutoff check.
  markUserForceRevalidate(userId);

  // First verify: rotation fires (role mismatch) — sessionId rotates and a
  // re-signed token comes back. No per-user cutoff is stamped.
  const first = await verifyAndRefreshSession(token);
  assert.ok(first, "rotation verify must succeed");
  assert.ok(first.refreshed, "rotation must re-sign a token");
  assert.equal(first.claims.role, "ISSUE_ADMIN");
  assert.notEqual(first.claims.sessionId, "sess-old-1");
  assert.equal(dbUser.sessionsRevokedAt, null, "rotation must not stamp the per-user cutoff");

  // Second verify with the freshly-minted token, again on the forced slow path.
  const second = await verifyAndRefreshSession(first.refreshed.token);
  assert.ok(second, "the rotated token must verify straight away");
  assert.equal(second.claims.role, "ISSUE_ADMIN");

  // The OLD token is genuinely dead: its AuthSession row was renamed.
  const replayed = await verifyAndRefreshSession(token);
  assert.equal(replayed, null, "the pre-rotation token must be rejected");
});

test("revoke-all in the same second as sign-in still rejects (the deliberate <= semantics)", async () => {
  const userId = "user-revoked-1";
  dbSessionId = "sess-revoked-1";
  const iat = Math.floor(Date.now() / 1000);
  // No role/permission change (no rotation); the user was revoked in the same
  // second the token was signed — the inclusive cutoff must still kill it.
  dbUser = makeDbUser({ role: "USER", sessionsRevokedAt: new Date(iat * 1000) });

  const token = await signSessionJwt(
    {
      id: userId,
      role: "USER",
      permissions: "0",
      provider: "credentials",
      sessionId: dbSessionId,
      expiresAt: iat + 86_400,
    },
    { expiresInSeconds: 7_200, iat },
  );
  markUserForceRevalidate(userId);

  assert.equal(await verifyAndRefreshSession(token), null);
});

// ── the non-persisting caller opt-out ──────────────────────────────────────

test("allowRotation:false surfaces the fresh role WITHOUT killing the presented token", async () => {
  // Rotation is destructive — it renames the AuthSession row, so the token the
  // client still holds dies the moment it commits. Callers that can hand back the replacement do so
  // (proxy.ts rewrites the forwarded cookie AND sets Set-Cookie). A SERVER COMPONENT
  // cannot set a cookie, so running it on the page-render path destroyed the session
  // and bounced the user to /login on their next request — on the prefetch path
  // proxy.ts's matcher skips, which is exactly why guardrail 29 puts a DB-checked read
  // there in the first place.
  const userId = "user-norotate-1";
  dbSessionId = "sess-keep-1";
  dbUser = makeDbUser({ role: "ISSUE_ADMIN" }); // DB promoted; token still says USER

  const iat = Math.floor(Date.now() / 1000);
  const token = await signSessionJwt(
    {
      id: userId, role: "USER", permissions: "0", provider: "credentials",
      sessionId: dbSessionId, expiresAt: iat + 86_400,
    },
    { expiresInSeconds: 7_200, iat },
  );
  markUserForceRevalidate(userId);

  const result = await verifyAndRefreshSession(token, { allowRotation: false });

  // The authz decision — the only thing this caller needs — is still correct and fresh.
  assert.ok(result, "the session must resolve");
  assert.equal(result.claims.role, "ISSUE_ADMIN", "the render must gate on the DB role, not the stale claim");

  // ...and none of the destructive half ran.
  assert.equal(result.claims.sessionId, "sess-keep-1", "the sessionId must not rotate");
  assert.equal(dbSessionId, "sess-keep-1", "the AuthSession row must not be renamed");
  assert.equal(dbUser.sessionsRevokedAt, null, "sessionsRevokedAt must not be stamped");

  // The decisive property: the token the browser holds still works afterwards.
  markUserForceRevalidate(userId);
  const stillValid = await verifyAndRefreshSession(token, { allowRotation: false });
  assert.ok(stillValid, "the presented token must survive — otherwise the next request is a logout");
});

test("rotation is still the DEFAULT — every request-scoped caller keeps it", async () => {
  // The opt-out must not become the general behaviour: proxy/api-auth CAN deliver the
  // replacement, and rotation is what stops a leaked pre-change token being replayed.
  const userId = "user-norotate-2";
  dbSessionId = "sess-rotate-2";
  dbUser = makeDbUser({ role: "ISSUE_ADMIN" });

  const iat = Math.floor(Date.now() / 1000);
  const token = await signSessionJwt(
    {
      id: userId, role: "USER", permissions: "0", provider: "credentials",
      sessionId: dbSessionId, expiresAt: iat + 86_400,
    },
    { expiresInSeconds: 7_200, iat },
  );
  markUserForceRevalidate(userId);

  const result = await verifyAndRefreshSession(token);
  assert.ok(result);
  assert.notEqual(result.claims.sessionId, "sess-rotate-2", "the default must still rotate");
  assert.equal(dbUser.sessionsRevokedAt, null, "…by renaming the row, never by a per-user cutoff");
});

test("a rotation signs out NO other device — an OLDER sibling token (every native app) survives; only the old token dies", async () => {
  // Device A (a browser, re-signed recently) is first to hit the server after an
  // admin edits the user's permissions, so A's session rotates. Device B's token
  // was minted EARLIER — the shape of every iOS session, whose bearer token keeps
  // its sign-in iat forever. The old cutoff stamp (at A's iat) killed B too.
  const userId = "user-rotation-sibling";
  dbSessionId = "sess-old-sib";
  dbUser = makeDbUser({ role: "ISSUE_ADMIN" });
  const now = Math.floor(Date.now() / 1000);
  const mk = (sessionId: string, role: string, at: number) =>
    signSessionJwt(
      { id: userId, role, permissions: "0", provider: "credentials", sessionId, expiresAt: at + 86_400 },
      { expiresInSeconds: 7_200, iat: at },
    );
  // Minted an hour before the rotating token (still well inside its life).
  const olderSibling = await mk("sess-sibling", "ISSUE_ADMIN", now - 3_600);
  const token = await mk(dbSessionId, "USER", now - 5);
  markUserForceRevalidate(userId);
  const first = await verifyAndRefreshSession(token);
  assert.ok(first?.refreshed);
  assert.equal(dbUser.sessionsRevokedAt, null, "no per-user cutoff");
  const savedId = dbSessionId;
  dbSessionId = "sess-sibling";
  const sib = await verifyAndRefreshSession(olderSibling);
  dbSessionId = savedId;
  assert.ok(sib, "another device's older token must not be signed out by this device's rotation");
  assert.equal(await verifyAndRefreshSession(token), null, "the pre-rotation token still dies");
});

