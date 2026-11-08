import { prisma } from "@/lib/prisma";
import { headers } from "next/headers";
import type { SessionClaims } from "@/lib/session-jwt";
import { markUserForceRevalidate, markSessionForceRevoked } from "@/lib/session-revocation";
import type { SummonarrSession } from "@/lib/api-auth";
import { machineIpAllowed } from "@/lib/api-auth";
import { readSummonarrSession, readActiveSummonarrSession } from "@/lib/session-server";
import { effectivePermissions, parsePermissions } from "@/lib/permissions";
import { normalizeEmail } from "@/lib/email-normalize";
import { isPrismaErrorCode } from "@/lib/prisma-errors";

// The auth entry point. This module holds the session READS (auth(),
// authActive()) and REVOCATION; sign-in lives in one module per step, and every
// name importers use is re-exported here so "@/lib/auth" stays the one import:
//
//   auth-provider.ts          the provider lookup's result and refusal types,
//                             the audit email hash, the pre-setup gate
//   auth-sign-in-context.ts   the device payload, the refusal audit
//   auth-credentials.ts       local email + password (guardrails 6d, 6e, 6i)
//   auth-plex.ts              Plex token + server membership
//   auth-jellyfin.ts          Jellyfin password and QuickConnect (34e)
//   auth-oidc.ts              the OIDC identity lookup (34e)
//   auth-session-durations.ts session lifetimes (6c)
//   auth-session-mint.ts      the AuthSession row + session JWT (6c, 6h, 33)

// Re-exported so existing imports of `normalizeEmail` from "@/lib/auth"
// continue to work.
export { normalizeEmail };
export {
  hashAuditEmail,
  isAuthorizedDbUser,
  PROVIDER_REBIND_REQUIRED,
  PROVIDER_SETUP_REQUIRED,
  ProviderRefusal,
  type AuthorizedDbUser,
  type ProviderRebindRequired,
  type ProviderSetupRequired,
  type ProviderRefusalReason,
} from "@/lib/auth-provider";
export {
  buildDeviceMeta,
  type AuthorizedSignIn,
  type CredentialsAuthorizedUser,
  type DeviceMeta,
} from "@/lib/auth-sign-in-context";
export { authorizeWithCredentials } from "@/lib/auth-credentials";
export { authorizeWithPlex, findOrCreatePlexUser, type PlexUserInput } from "@/lib/auth-plex";
export { authorizeWithJellyfin, authorizeWithJellyfinQuickConnect, findOrCreateJellyfinUser } from "@/lib/auth-jellyfin";
export { findOrCreateOidcUser, type OidcUserClaims } from "@/lib/auth-oidc";
export { getSessionDurations, invalidateSessionDurationsCache } from "@/lib/auth-session-durations";
export {
  AccountDeactivatedError,
  initializeTokenOnSignIn,
  signInAndMintSession,
  type SignInResult,
} from "@/lib/auth-session-mint";

export function isTokenExpired(session: SummonarrSession | null): boolean {
  // A null session is not a valid, unexpired session — report expired. Every
  // current caller guards with `!session || …` or a `session?.… &&` short-
  // circuit, so this only hardens against a future caller that writes
  // `if (!isTokenExpired(session)) allow()` and would otherwise treat a missing
  // session as valid.
  if (!session) return true;
  return !!session.tokenExpiresAt && Math.floor(Date.now() / 1000) > session.tokenExpiresAt;
}

function claimsToSession(claims: SessionClaims): SummonarrSession {
  return {
    user: {
      id: claims.id,
      role: claims.role,
      permissions: effectivePermissions(claims.role, parsePermissions(claims.permissions)),
      email: claims.email ?? null,
      name: claims.name ?? null,
      provider: claims.provider,
      mediaServer: claims.mediaServer ?? null,
    },
    sessionId: claims.sessionId,
    tokenExpiresAt: claims.expiresAt,
  };
}

// Server-component-friendly session reader: returns SummonarrSession | null.
// JWT-only: verifies signature + expiry, NOT DB revocation/role-rotation. Fine
// for personalization reads; for an AUTHORIZATION decision in a page/layout use
// authActive() instead. Routes that need 401/403 semantics should use
// requireAuth/withAuth from @/lib/api-auth.
export async function auth(): Promise<SummonarrSession | null> {
  const claims = await readSummonarrSession();
  return claims ? claimsToSession(claims) : null;
}

// DB-checked counterpart of auth() for AUTHORIZATION decisions in server
// components (page/layout role guards). Routes through readActiveSummonarrSession
// → verifyAndRefreshSession, so a revoked AuthSession, sessionsRevokedAt/
// passwordChangedAt cutoff, or role demotion is honored immediately — not just
// the JWT signature + expiry. Required because proxy.ts's matcher skips prefetch
// requests (next-router-prefetch / purpose=prefetch), so a page that makes a
// role-based redirect cannot assume the proxy's DB check has run. Same
// SummonarrSession shape as auth(), so it is a drop-in replacement at the guard.
export async function authActive(): Promise<SummonarrSession | null> {
  // Cookie transport (page renders are cookie/SSR only), so a bearer-bound
  // native token is refused inside the read (guardrail 6h). There is no
  // User-Agent fingerprint check: the client writes that header, so it never
  // stopped a replayed cookie (guardrail 6h retired it everywhere).
  const claims = await readActiveSummonarrSession();
  if (!claims) return null;
  const h = await headers();
  // A machine session carries a mint-time IP allowlist; the API guards + isCronAuthorized
  // enforce it, so bind the page-render path too — else a leaked machine JWT could render
  // admin pages from a disallowed IP. Absent/empty allowlist ⇒ true (no restriction).
  if (!machineIpAllowed(claims, h)) return null;
  return claimsToSession(claims);
}

export function invalidateUserSession(userId: string): void {
  markUserForceRevalidate(userId);
}

export async function revokeSessionById(
  sessionId: string,
  guard?: (tx: Parameters<Parameters<typeof prisma.$transaction>[0]>[0], userId: string) => Promise<void>,
): Promise<void> {
  // Deliberately does NOT touch sessionsRevokedAt.
  //
  // It used to bump the cutoff to the revoked row's createdAt, on the theory that
  // another replica might serve the deleted session from its dbCheckedAt cache.
  // That reasoning does not survive contact with the code: the cutoff is only ever
  // consulted on the SLOW path, where the AuthSession row-presence check already
  // rejects the deleted session several lines earlier; on the FAST path the
  // function returns before it even loads the user, so the cutoff is unreachable
  // there. And this deployment is a single Node process (guardrail 17), so
  // markSessionForceRevoked below forces the very next request onto the slow path
  // anyway. The bump bought nothing.
  //
  // What it cost was real. The cutoff is `iat <= sessionsRevokedAt`, and it is
  // per-USER, so anchoring it to one session's createdAt also kills every session
  // minted earlier. Cookie sessions hide this — they are re-signed constantly, so
  // their iat is always newer — but a bearer/native token keeps its sign-in iat for
  // its whole (now indefinite) life. Revoking a laptop therefore signed out every iOS device
  // that had been signed in longer. Revoke-all still stamps a cutoff ("now"), which
  // is correct for its everywhere semantics.
  try {
    await prisma.$transaction(async (tx) => {
      if (guard) {
        const row = await tx.authSession.findUnique({ where: { sessionId }, select: { userId: true } });
        if (row) await guard(tx, row.userId);
      }
      await tx.authSession.delete({ where: { sessionId } });
    });
  } catch (err) {
    // Idempotent: a concurrent revoke of the SAME session (a retried native
    // sign-out, or the admin route racing the user's own DELETE /api/sessions)
    // already removed the row. The revocation the caller asked for is a fact, so
    // a not-found (P2025) is success, not a 500 that skips the audit row. There
    // is deliberately no find-then-delete: a plain SELECT takes no lock, so both
    // racers observed the row and the loser's DELETE affected 0 rows anyway.
    if (!isPrismaNotFound(err)) throw err;
  }
  // Mark in-memory only AFTER the DB revocation commits (matches
  // revokeAllUserSessions). Every other error is intentionally not swallowed: a
  // failed revoke propagates so the caller returns 500 instead of auditing a
  // phantom revocation that left the AuthSession row live (it would resurrect on
  // restart).
  markSessionForceRevoked(sessionId);
}

function isPrismaNotFound(err: unknown): boolean {
  return isPrismaErrorCode(err, "P2025");
}

export async function revokeAllUserSessions(
  userId: string,
  guard?: (tx: Parameters<Parameters<typeof prisma.$transaction>[0]>[0]) => Promise<void>,
): Promise<void> {
  // The read, the delete and the sessionsRevokedAt stamp share one $transaction,
  // so either all of them land or none do. Without it, a failed stamp could leave
  // the rows deleted but no cutoff set, and a JWT still inside its short
  // dbCheckedAt fast-path window (see session-refresh.ts) could keep working.
  const sessionIds = await prisma.$transaction(async (tx) => {
    if (guard) await guard(tx); // e.g. role re-read under lock 42 (admin routes)
    const sessions = await tx.authSession.findMany({
      where: { userId },
      select: { sessionId: true },
    });
    await tx.authSession.deleteMany({ where: { userId } });
    await tx.user.update({
      where: { id: userId },
      data: { sessionsRevokedAt: new Date() },
    });
    return sessions.map((s) => s.sessionId);
  });

  for (const sessionId of sessionIds) markSessionForceRevoked(sessionId);
  markUserForceRevalidate(userId);
}

// Revokes every session of `userId` EXCEPT `keepSessionId` — used when a user
// changes their own two-factor enrollment, so a session an attacker may already
// hold is cut off while the device making the change stays signed in. Unlike
// revokeAllUserSessions this deliberately does NOT stamp sessionsRevokedAt: that
// cutoff is per-USER (`iat <= cutoff`) and would kill the kept session too.
// It doesn't need it — a deleted AuthSession row fails the slow-path presence
// check, and markSessionForceRevoked forces the very next request of each
// revoked session onto that slow path (single process, guardrail 17).
//
// It runs inside the CALLER's transaction, so the 2FA change and the sign-out
// it requires commit together: a separate second transaction that failed would
// 500 a change that already landed and leave the other sessions live. There is
// deliberately no standalone wrapper. Returns the revoked session ids; the
// caller marks each with markSessionForceRevoked only AFTER its transaction
// commits (guardrail 27). One query at a time on the tx connection (23c).
export async function revokeOtherUserSessionsInTx(
  tx: Pick<typeof prisma, "authSession">,
  userId: string,
  keepSessionId: string | undefined,
): Promise<string[]> {
  const where = keepSessionId
    ? { userId, sessionId: { not: keepSessionId } }
    : { userId };
  const sessions = await tx.authSession.findMany({ where, select: { sessionId: true } });
  await tx.authSession.deleteMany({ where });
  return sessions.map((s) => s.sessionId);
}
