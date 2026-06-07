import { randomUUID } from "node:crypto";
import { prisma } from "@/lib/prisma";
import { signSessionJwt, verifySessionJwt, type SessionClaims } from "@/lib/session-jwt";
import { shouldForceDbCheck } from "@/lib/session-revocation";
import { getCachedPlexAllowlist } from "@/lib/plex-membership";

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
  // Honor the cache window only if this replica hasn't locally revoked the
  // session/user since — otherwise force a DB hit so a "revoke this device" /
  // "log out everywhere" issued here takes effect on the next request rather
  // than up to checkInterval later.
  const skipDbCheck =
    typeof dbCheckedAt === "number" &&
    now - dbCheckedAt <= checkInterval &&
    !shouldForceDbCheck(claims.id, claims.sessionId);

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
        permissions: true,
        mediaServer: true,
        sessionsRevokedAt: true,
        passwordChangedAt: true,
        email: true,
        notificationEmail: true,
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

  // Plex server-membership re-check. A user un-shared from the Plex server keeps
  // a valid session JWT until it expires, so re-verify membership here on the
  // slow DB-check path (~once/60s per session). The allowlist is cached per
  // replica for 30 min, so plex.tv is hit at most once per replica per window
  // regardless of how many Plex users are active. ADMINs are exempt (always on
  // the allowlist anyway; never lock out the operator on an email mismatch).
  // getCachedPlexAllowlist() returns null when membership can't be determined
  // (unconfigured / plex.tv error) — fail open and don't revoke.
  if (claims.provider === "plex" && dbUser.role !== "ADMIN") {
    const allowlist = await getCachedPlexAllowlist();
    if (allowlist) {
      const candidateEmails = [dbUser.notificationEmail, dbUser.email, claims.email]
        .filter((e): e is string => typeof e === "string" && e.length > 0)
        .map((e) => e.toLowerCase().trim());
      const stillMember = candidateEmails.some((e) => allowlist.has(e));
      if (candidateEmails.length > 0 && !stillMember) {
        // No longer shared on the Plex server — revoke ALL of this user's
        // sessions (every device) by advancing sessionsRevokedAt past their
        // tokens' iat, then reject this request.
        await prisma.user
          .update({ where: { id: claims.id }, data: { sessionsRevokedAt: new Date() } })
          .catch(() => {});
        return null;
      }
    }
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

  const dbPermsStr = (dbUser.permissions ?? 0n).toString();
  const claimPermsStr =
    typeof claims.permissions === "string" ? claims.permissions : "0";

  let workingClaims: SessionClaims & { dbCheckedAt?: number } = {
    ...claims,
    // Always carry the current DB permissions (raw decimal) into the re-signed
    // token. effectivePermissions() is applied later when building the session
    // for handlers (claimsToSession / auth()), never to the stored value.
    permissions: dbPermsStr,
    dbCheckedAt: now,
  };

  // Privilege change (role OR permissions) → rotate sessionId so a leaked
  // pre-change token cannot be replayed.
  // ALSO bump sessionsRevokedAt so the old JWT's iat now falls below the cutoff and
  // refreshToken() on OTHER replicas rejects it within their own dbCheckedAt window.
  // Without this bump, the rotation only protects requests that go through THIS
  // replica's verifyAndRefreshSession after the rotation — a cached old token can
  // keep refreshing on a different replica for up to 60s (10s for admin) and would
  // pass the new sessionId check (which the row carries) because we don't verify
  // the JWT's sessionId against anything beyond cryptographic integrity.
  // Tracks whether this verify rotated sessionId. The signing path below uses
  // it to force the new JWT's iat past the cutoff we just stamped, so the
  // freshly-minted token doesn't fail its own cutoff check when rotation
  // happens in the same wall-clock second as the original sign-in.
  let rotationCutoffSec: number | null = null;
  const privilegeChanged =
    dbUser.role !== claims.role || dbPermsStr !== claimPermsStr;
  if (privilegeChanged) {
    const newSessionId = randomUUID();
    const oldIatSec = typeof claims.iat === "number" ? claims.iat : Math.floor(now);
    const cutoffSec = oldIatSec + 1;
    const cutoffMs = cutoffSec * 1000;
    const rotated = await prisma.$transaction(async (tx) => {
      const row = await tx.authSession
        .update({
          where: { sessionId: claims.sessionId },
          data: { sessionId: newSessionId },
        })
        .catch(() => null);
      if (!row) return false;
      const userRow = await tx.user.findUnique({
        where: { id: claims.id },
        select: { sessionsRevokedAt: true },
      });
      const existing = userRow?.sessionsRevokedAt;
      // Never decrease — a prior full-user revoke may have set it higher.
      if (!existing || existing.getTime() < cutoffMs) {
        await tx.user.update({
          where: { id: claims.id },
          data: { sessionsRevokedAt: new Date(cutoffMs) },
        });
      }
      return true;
    }).catch(() => false);
    if (!rotated) return null;
    workingClaims = { ...workingClaims, sessionId: newSessionId, role: dbUser.role };
    rotationCutoffSec = cutoffSec;
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
      }
    }
  }

  if (resignExpiresIn === null) {
    const currentExp = workingClaims.exp;
    resignExpiresIn =
      typeof currentExp === "number" ? Math.max(60, currentExp - now) : 3600;
  }

  // Always re-sign on a DB check so dbCheckedAt advances even when nothing else
  // changed; the fast path at the top of the function still skips this entirely.
  // On a same-second rotation, force iat past the cutoff so the new JWT doesn't
  // fail its own sessionsRevokedAt check.
  const signedIat = rotationCutoffSec !== null ? Math.max(now, rotationCutoffSec) : undefined;
  const newToken = await signSessionJwt(
    {
      id: workingClaims.id,
      role: workingClaims.role,
      permissions: workingClaims.permissions,
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
    { expiresInSeconds: resignExpiresIn, iat: signedIat },
  );

  return {
    claims: workingClaims,
    refreshed: { token: newToken, expiresInSeconds: resignExpiresIn },
  };
}
