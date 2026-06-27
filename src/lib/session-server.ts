import { cookies } from "next/headers";
import type { NextRequest } from "next/server";
import { getSessionCookieName, parseSessionCookie } from "./session-cookie";
import { parseBearerToken } from "./mobile-auth";
import { verifySessionJwt, type SessionClaims } from "./session-jwt";
import { verifyAndRefreshSession } from "./session-refresh";

// Server-component-friendly read of the Summonarr session JWT. Returns null
// for any of: no cookie, malformed JWT, bad signature, expired token. Never
// throws.
//
// Used by the root layout to seed the initial value of the client-side
// SummonarrSessionProvider, and (in a later PR) by proxy.ts so the middleware
// doesn't have to round-trip through next-auth.
export async function readSummonarrSession(): Promise<SessionClaims | null> {
  const cookieStore = await cookies();
  const token = cookieStore.get(getSessionCookieName())?.value;
  if (!token) return null;
  return verifySessionJwt(token);
}

// DB-checked session read for AUTHORIZATION decisions on routes that proxy.ts
// does NOT gate — i.e. the public sync/cron paths in isPublicPath(). Unlike
// readSummonarrSession()/auth() (which only verify the JWT signature + exp),
// this routes through verifyAndRefreshSession so a revoked AuthSession row, a
// sessionsRevokedAt/passwordChangedAt cutoff, or a role demotion is honored
// immediately (within the same dbCheckedAt fast-path window proxy.ts uses:
// 10s for admins). Returns the DB-reconciled claims (role refreshed) or null.
// Does not persist the refreshed cookie — these callers only need the authz
// decision, and the next request re-checks. Returns null (deny the session
// path) if the DB check throws, so a DB hiccup falls through to the caller's
// CRON_SECRET path rather than failing open.
export async function readActiveSummonarrSession(): Promise<SessionClaims | null> {
  const cookieStore = await cookies();
  const token = cookieStore.get(getSessionCookieName())?.value;
  if (!token) return null;
  try {
    const result = await verifyAndRefreshSession(token);
    return result?.claims ?? null;
  } catch {
    return null;
  }
}

// Request-aware counterpart of readActiveSummonarrSession() that resolves a
// bearer token (native clients) FIRST, then falls back to the session cookie —
// mirroring authenticateRequest in api-auth.ts. readActiveSummonarrSession()
// reads the cookie only (it runs in a server-component context with no request
// object), so a native admin holding ONLY a bearer JWT cannot use the
// session-authorized path on routes that funnel through isCronAuthorized.
//
// Bearer-FIRST (not cookie-first) is required per guardrail 6b: it prevents a
// forged cookie from riding a request a bearer made CSRF-exempt upstream.
//
// Returns the same shape as readActiveSummonarrSession() — the DB-reconciled
// claims (role refreshed via verifyAndRefreshSession) or null. Does not persist
// any refreshed token (callers only need the authz/attribution decision).
// Returns null if no token is present or the DB check throws, so a DB hiccup
// falls through to the caller's CRON_SECRET path rather than failing open.
export async function readActiveSummonarrSessionFromRequest(
  req: NextRequest,
): Promise<SessionClaims | null> {
  const bearer = parseBearerToken(req.headers.get("authorization"));
  const token = bearer ?? parseSessionCookie(req.headers.get("cookie"));
  if (!token) return null;
  try {
    const result = await verifyAndRefreshSession(token);
    return result?.claims ?? null;
  } catch {
    return null;
  }
}
