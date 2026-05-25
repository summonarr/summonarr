import { randomUUID } from "node:crypto";
import { prisma } from "@/lib/prisma";
import { signSessionJwt, verifySessionJwt, type SessionClaims } from "@/lib/session-jwt";

// Verify-and-refresh for the Summonarr session JWT.
//
// Mirrors the load-bearing behaviour of the old next-auth refreshToken()
// callback in src/lib/auth.ts. On each call:
//
//   1. Cryptographically verify the JWT (sig + exp).
//   2. Cross-replica revocation: AuthSession row deleted = logged out everywhere.
//   3. Defense-in-depth cutoff: reject any token minted before sessionsRevokedAt
//      or passwordChangedAt.
//   4. Refresh role from DB. If role changed, rotate sessionId so the old token
//      cannot be replayed after a privilege change.
//   5. Refresh mediaServer for credentials/oidc tokens (plex/jellyfin/jellyfin-qc
//      sessions have their mediaServer pinned at sign-in).
//   6. Sliding window for non-ADMIN: shorten the JWT exp to now+3600, capped at
//      the original session deadline (`expiresAt` claim). This keeps active
//      mobile/rememberMe sessions alive while enforcing a 1-hour inactivity
//      timeout — matches the existing semantics.
//   7. Hard ceiling for ADMIN: reject after iat + 7d regardless of exp.
//
// dbCheckedAt skip optimization keeps the hot path off the DB: if the token was
// validated against the DB within the last 60s (10s for ADMIN/ISSUE_ADMIN, so
// role demotions propagate quickly), skip the DB hit entirely.

export interface RefreshedToken {
  token: string;
  expiresInSeconds: number;
}

export interface VerifyAndRefreshResult {
  claims: SessionClaims;
  refreshed?: RefreshedToken;
}

const ADMIN_MAX_LIFETIME_SECONDS = 7 * 24 * 60 * 60;
const NON_ADMIN_SLIDE_WINDOW_SECONDS = 3600;
const FAST_CHECK_INTERVAL_SECONDS = 10;
const SLOW_CHECK_INTERVAL_SECONDS = 60;

export async function verifyAndRefreshSession(
  token: string,
): Promise<VerifyAndRefreshResult | null> {
  const claims = await verifySessionJwt(token);
  if (!claims) return null;
  if (!claims.sessionId) return null;

  const now = Math.floor(Date.now() / 1000);

  // Fast path: if the token was DB-validated recently, skip the DB round trip.
  const dbCheckedAt = (claims as SessionClaims & { dbCheckedAt?: number })
    .dbCheckedAt;
  const checkInterval =
    claims.role === "ADMIN" || claims.role === "ISSUE_ADMIN"
      ? FAST_CHECK_INTERVAL_SECONDS
      : SLOW_CHECK_INTERVAL_SECONDS;
  const skipDbCheck =
    typeof dbCheckedAt === "number" && now - dbCheckedAt <= checkInterval;

  if (skipDbCheck) {
    // Still enforce the ADMIN 7d ceiling without hitting the DB.
    if (claims.role === "ADMIN") {
      const iat = claims.iat;
      if (typeof iat === "number" && now >= iat + ADMIN_MAX_LIFETIME_SECONDS) {
        return null;
      }
    }
    return { claims };
  }

  const [authSessionRow, dbUser] = await Promise.all([
    prisma.authSession.findUnique({ where: { sessionId: claims.sessionId } }),
    prisma.user.findUnique({
      where: { id: claims.id },
      select: {
        role: true,
        mediaServer: true,
        sessionsRevokedAt: true,
        passwordChangedAt: true,
      },
    }),
  ]);

  if (!authSessionRow) return null;
  if (!dbUser) return null;

  const revokedSec = dbUser.sessionsRevokedAt
    ? Math.floor(dbUser.sessionsRevokedAt.getTime() / 1000)
    : 0;
  const passwordSec = dbUser.passwordChangedAt
    ? Math.floor(dbUser.passwordChangedAt.getTime() / 1000)
    : 0;
  const cutoff = Math.max(revokedSec, passwordSec);
  if (cutoff > 0 && typeof claims.iat === "number" && claims.iat < cutoff) {
    return null;
  }

  void prisma.authSession
    .update({ where: { sessionId: claims.sessionId }, data: { lastSeenAt: new Date() } })
    .catch(() => {});

  // ADMIN 7d hard ceiling
  if (dbUser.role === "ADMIN") {
    const iat = claims.iat;
    if (typeof iat === "number" && now >= iat + ADMIN_MAX_LIFETIME_SECONDS) {
      return null;
    }
  }

  let workingClaims: SessionClaims & { dbCheckedAt?: number } = {
    ...claims,
    dbCheckedAt: now,
  };
  let mustResign = false;

  // Role change → rotate sessionId so a leaked pre-change token cannot be replayed
  if (dbUser.role !== claims.role) {
    const newSessionId = randomUUID();
    const rotated = await prisma.authSession
      .update({
        where: { sessionId: claims.sessionId },
        data: { sessionId: newSessionId },
      })
      .catch(() => null);
    if (!rotated) return null;
    workingClaims = { ...workingClaims, sessionId: newSessionId, role: dbUser.role };
    mustResign = true;
  }

  // mediaServer refresh for credentials/oidc — plex/jellyfin/jellyfin-qc are pinned at sign-in
  const provider = workingClaims.provider;
  if (
    provider !== "plex" &&
    provider !== "jellyfin" &&
    provider !== "jellyfin-quickconnect"
  ) {
    const dbMediaServer = dbUser.mediaServer ?? null;
    if ((workingClaims.mediaServer ?? null) !== dbMediaServer) {
      workingClaims = { ...workingClaims, mediaServer: dbMediaServer };
      mustResign = true;
    }
  }

  // Sliding window for non-ADMIN: shorten exp to now+3600, capped at the original
  // session deadline. The cap (`expiresAt` claim) is the value set at sign-in by
  // initializeTokenOnSignIn — it never moves, so sliding can NEVER push the
  // effective expiry past the original TTL.
  let resignExpiresIn: number | null = null;
  if (workingClaims.role !== "ADMIN") {
    const sessionDeadline = workingClaims.expiresAt;
    if (typeof sessionDeadline === "number") {
      if (now >= sessionDeadline) return null;
      const currentExp = workingClaims.exp;
      if (typeof currentExp === "number" && currentExp > now + NON_ADMIN_SLIDE_WINDOW_SECONDS) {
        const newExp = Math.min(now + NON_ADMIN_SLIDE_WINDOW_SECONDS, sessionDeadline);
        resignExpiresIn = newExp - now;
        mustResign = true;
      }
    }
  }

  // Always re-sign on a DB check so dbCheckedAt advances even when nothing else changed.
  mustResign = true;

  if (resignExpiresIn === null) {
    const currentExp = workingClaims.exp;
    resignExpiresIn =
      typeof currentExp === "number" ? Math.max(60, currentExp - now) : 3600;
  }

  const newToken = await signSessionJwt(
    {
      id: workingClaims.id,
      role: workingClaims.role,
      email: workingClaims.email ?? null,
      name: workingClaims.name ?? null,
      provider: workingClaims.provider,
      mediaServer: workingClaims.mediaServer ?? null,
      sessionId: workingClaims.sessionId,
      uaFingerprint: workingClaims.uaFingerprint,
      isMobile: workingClaims.isMobile,
      deviceLabel: workingClaims.deviceLabel,
      expiresAt: workingClaims.expiresAt,
      // Threading dbCheckedAt through the SessionClaims-as-JWTPayload escape hatch:
      dbCheckedAt: now,
    } as SessionClaims,
    { expiresInSeconds: resignExpiresIn },
  );

  return {
    claims: workingClaims,
    refreshed: mustResign ? { token: newToken, expiresInSeconds: resignExpiresIn } : undefined,
  };
}
