// Regression tests for the privilege-change session rotation in
// verifyAndRefreshSession (src/lib/session-refresh.ts).
//
// The bug being pinned: rotation stamps sessionsRevokedAt = oldIat+1 and used to
// re-sign the new token with iat = max(now, cutoff). The cutoff check rejects
// `iat <= cutoff` (deliberately inclusive for the revoke-all path), so when the
// rotation ran within ~1s of the presented token's iat, the freshly-minted
// token carried iat == cutoff and failed its own check on the next slow-path
// verify — bouncing the user to /login immediately after their role/permission
// change. The fix signs iat = max(now, cutoff + 1).
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

  // First verify: rotation fires (role mismatch) — sessionId rotates, cutoff is
  // stamped, and a re-signed token comes back.
  const first = await verifyAndRefreshSession(token);
  assert.ok(first, "rotation verify must succeed");
  assert.ok(first.refreshed, "rotation must re-sign a token");
  assert.equal(first.claims.role, "ISSUE_ADMIN");
  assert.notEqual(first.claims.sessionId, "sess-old-1");
  assert.ok(dbUser.sessionsRevokedAt, "rotation must stamp sessionsRevokedAt");

  // Second verify with the freshly-minted token, again on the forced slow path.
  // Pre-fix this returned null (iat == cutoff fails the inclusive check) and the
  // user was bounced to /login right after the promotion.
  const second = await verifyAndRefreshSession(first.refreshed.token);
  assert.ok(second, "the rotated token must pass the cutoff it just stamped");
  assert.equal(second.claims.role, "ISSUE_ADMIN");

  // The OLD token is now genuinely dead: same-second iat falls at/below the cutoff.
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
