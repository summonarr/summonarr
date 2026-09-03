import { randomUUID } from "node:crypto";
import { prisma } from "@/lib/prisma";
import { signSessionJwt, verifySessionJwt, type SessionClaims } from "@/lib/session-jwt";
import { shouldForceDbCheck } from "@/lib/session-revocation";
import { getCachedPlexAllowlist } from "@/lib/plex-membership";
import { serializePermissions } from "@/lib/permissions";
import { coalesce } from "@/lib/concurrency";

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
//   6. Enforce the session deadline (`expiresAt` claim, captured at sign-in and
//      mirrored into AuthSession.expiresAt): reject a token past it, otherwise
//      re-sign with exp = the deadline, so the cookie's Max-Age / the JWT's exp
//      always cover the session's full remaining life. There is NO inactivity
//      window and NO role-based ceiling on top of the deadline (guardrail 6c):
//      "remember me" lasts the configured sessionMaxDuration, and a native
//      session (deadline = the never-reached sentinel, see session-lifetime.ts)
//      lives until it is revoked.
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

const FAST_CHECK_INTERVAL_SECONDS = 10;
const SLOW_CHECK_INTERVAL_SECONDS = 60;

export interface VerifyAndRefreshOptions {
  // Set false by callers that CANNOT deliver a replacement token to the client — a
  // server component can't set a cookie. Default true: every request-scoped caller
  // (proxy, api-auth, /api/auth/me) hands the new token back and must keep rotating.
  allowRotation?: boolean;
}

export async function verifyAndRefreshSession(
  token: string,
  opts: VerifyAndRefreshOptions = {},
): Promise<VerifyAndRefreshResult | null> {
  const allowRotation = opts.allowRotation !== false;
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
    // The JWT's own exp (= the session deadline, re-signed that way on every
    // slow-path check) is all the time-based enforcement the fast path needs —
    // jose already rejected an expired token above.
    return { claims };
  }

  // Slow path — ONE execution per in-flight token. A page's burst of sibling
  // fetches all carry the same cookie; once it is past the dbCheckedAt window
  // every one of them lands here, and after a privilege change every one of
  // them computes privilegeChanged. The rotation below is destructive (it
  // renames the AuthSession row and bumps sessionsRevokedAt past this token's
  // iat), so without coalescing the first sibling to commit wins and each
  // other sibling fails closed — a 401 on /api/*, or on a document navigation
  // a cookie-clearing /login redirect that also discards the Set-Cookie the
  // winner just installed. Sharing the one execution hands every sibling the
  // same rotated claims + the same refreshed token. The key carries
  // allowRotation: session-server.ts verifies with allowRotation:false because
  // a server component cannot deliver a replacement token, and sharing a result
  // across the two modes would hand the proxy an unrotated token or a server
  // component a rotated one it cannot deliver. `coalesce` drops the entry on
  // settle, so a token is held only while its verify is in flight; a request
  // that arrives after the rotation committed still dies as designed (the
  // stale cookie is dead the moment the rotation lands).
  return coalesce(`session-verify:${allowRotation ? "r" : "n"}:${token}`, async () => {
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
          deactivatedAt: true,
          email: true,
          notificationEmail: true,
          plexUserId: true,
        },
      }),
    ]);

    if (!authSessionRow) return null;
    if (!dbUser) return null;

    // A DISABLED account can never re-authenticate, even within a still-valid JWT
    // exp window — absolute, not an iat cutoff. Set by account removal, either the
    // user's own (src/app/api/profile/route.ts) or an admin's
    // (src/app/api/admin/users/[id]/route.ts); cleared by the reactivate route.
    // The sign-in paths refuse it separately (signInAndMintSession throws
    // AccountDeactivatedError) — this is the gate for tokens already minted.
    if (dbUser.deactivatedAt) return null;

    const revokedSec = dbUser.sessionsRevokedAt
      ? Math.floor(dbUser.sessionsRevokedAt.getTime() / 1000)
      : 0;
    const passwordSec = dbUser.passwordChangedAt
      ? Math.floor(dbUser.passwordChangedAt.getTime() / 1000)
      : 0;
    const cutoff = Math.max(revokedSec, passwordSec);
    // `<=` (not `<`): the cutoffs are floored to whole seconds, and a revoked
    // session's JWT is typically signed in the same second its AuthSession row was
    // created — strict `<` would let that token's iat == cutoff slip past the
    // cross-replica backstop. `<=` closes the same-second gap; the only false catch
    // is a brand-new sign-in in the same second as an unrelated revoke, which is
    // vanishingly rare and simply re-authenticates.
    if (cutoff > 0 && typeof claims.iat === "number" && claims.iat <= cutoff) {
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
        // Immutable plex.tv account id first — every email candidate goes stale
        // the moment the user changes their plex.tv address, and an email-only
        // match used to revoke every device of a still-shared member. Legacy rows
        // with a null plexUserId keep the email-only behavior via the fallback.
        const stillMember =
          (dbUser.plexUserId != null && allowlist.ids.has(dbUser.plexUserId)) ||
          candidateEmails.some((e) => allowlist.emails.has(e));
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

    const dbPermsStr = serializePermissions(dbUser.permissions ?? 0n);
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
    if (privilegeChanged && !allowRotation) {
      // Rotation is DESTRUCTIVE: it renames the AuthSession row and bumps
      // sessionsRevokedAt past this token's iat, so the token the browser still holds is
      // dead the moment it commits. Callers that can deliver the replacement do so
      // (proxy.ts rewrites the forwarded cookie AND sets Set-Cookie); a server component
      // cannot, so running it there destroyed the session and bounced the user to /login
      // on their next request — reachable on the prefetch path proxy.ts's matcher skips,
      // which is the whole reason guardrail 29 puts a DB-checked read here.
      //
      // The authz decision is unaffected: the fresh role below is what this render
      // gates on, so a demoted user gets nothing elevated. The rotation still happens —
      // on the next request through proxy/api-auth, which can complete it.
      workingClaims = { ...workingClaims, role: dbUser.role };
    } else if (privilegeChanged) {
      const newSessionId = randomUUID();
      const oldIatSec = typeof claims.iat === "number" ? claims.iat : Math.floor(now);
      const cutoffSec = oldIatSec + 1;
      const cutoffMs = cutoffSec * 1000;
      const rotated = await prisma.$transaction(async (tx) => {
        const existingRow = await tx.authSession.findUnique({
          where: { sessionId: claims.sessionId },
          select: { id: true },
        });
        if (!existingRow) return false;
        await tx.authSession.update({
          where: { sessionId: claims.sessionId },
          data: { sessionId: newSessionId },
        });
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

    // Session deadline (`expiresAt` claim) — the value set at sign-in by
    // initializeTokenOnSignIn, mirrored into AuthSession.expiresAt. It never
    // moves, so a session can never outlive its configured duration; and nothing
    // shortens it either: the re-sign below puts exp (and so the cookie's
    // Max-Age) at EXACTLY the deadline for every role. Guardrail 6c — there is
    // deliberately no inactivity window and no role-based ceiling here. Both
    // used to exist: a 1-hour non-admin slide meant "remember me" ended after
    // any hour-long gap no matter what sessionMaxDuration promised, and a 7-day
    // ADMIN ceiling ended every admin session weekly. A native session's deadline
    // is the never-reached sentinel (session-lifetime.ts), so it passes here
    // forever and ends only through the revocation checks above. (The sole
    // exception to "exactly the deadline" is the same-second privilege-change
    // rotation below, where signedIat = cutoff+1 makes exp land ≤2s past it once;
    // the DB AuthSession row / sessionsRevokedAt remain the real boundary, so
    // this is immaterial.)
    let resignExpiresIn: number;
    const sessionDeadline = workingClaims.expiresAt;
    if (typeof sessionDeadline === "number") {
      if (now >= sessionDeadline) return null;
      resignExpiresIn = sessionDeadline - now;
    } else {
      // A token without a deadline claim (pre-claim legacy mints only — every
      // current mint path sets it) keeps its own remaining exp.
      const currentExp = workingClaims.exp;
      resignExpiresIn =
        typeof currentExp === "number" ? Math.max(60, currentExp - now) : 3600;
    }

    // Always re-sign on a DB check so dbCheckedAt advances even when nothing else
    // changed; the fast path at the top of the function still skips this entirely.
    // On a same-second rotation, force iat STRICTLY past the cutoff: the cutoff
    // check above rejects `iat <= cutoff` (deliberately inclusive for the
    // revoke-all path), so `max(now, cutoff)` would mint a token that fails its
    // own check on the next slow-path verify — bouncing the user to /login right
    // after their role/permission change. `cutoff + 1` is the smallest iat the
    // check accepts.
    const signedIat = rotationCutoffSec !== null ? Math.max(now, rotationCutoffSec + 1) : undefined;
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
        // Machine sessions carry their mint-time IP allowlist as a claim so
        // machineIpAllowed (api-auth.ts) re-checks the caller IP on EVERY request.
        // Dropping it here would strip the binding on the first re-sign — machine
        // tokens are minted without dbCheckedAt, so their first request always
        // re-signs — leaving the refreshed token usable from any IP.
        ...(workingClaims.machineAllowedIps ? { machineAllowedIps: workingClaims.machineAllowedIps } : {}),
        // Threading dbCheckedAt through the SessionClaims-as-JWTPayload escape hatch:
        dbCheckedAt: now,
      } as SessionClaims,
      { expiresInSeconds: resignExpiresIn, iat: signedIat },
    );

    return {
      claims: workingClaims,
      refreshed: { token: newToken, expiresInSeconds: resignExpiresIn },
    };
  });
}
