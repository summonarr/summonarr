import { cookies } from "next/headers";
import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import {
  getSessionCookieName,
  parseSessionCookie,
  serializeSessionCookie,
} from "@/lib/session-cookie";
import { parseBearerToken } from "@/lib/mobile-auth";
import {
  verifyAndRefreshSession,
  type RefreshedToken,
  type VerifyAndRefreshResult,
} from "@/lib/session-refresh";
import type { SessionClaims } from "@/lib/session-jwt";
import { matchesStoredFingerprint } from "@/lib/ua-fingerprint";
import {
  parsePermissions,
  effectivePermissions,
  hasPermission,
  Permission,
  type PermissionValue,
} from "@/lib/permissions";

// The session passed to authenticated handlers. Shaped to match what
// next-auth's Session was — `user.{id,role,provider,mediaServer}`,
// `sessionId`, `tokenExpiresAt` — so handler bodies didn't have to change
// when next-auth went away.
export interface SummonarrSession {
  user: {
    id: string;
    role: string;
    // Effective capability bitmask (ADMIN role → superbit; unseeded → role
    // preset). Use hasPermission()/canRequest() from @/lib/permissions to check.
    permissions: bigint;
    email?: string | null;
    name?: string | null;
    provider?: string;
    mediaServer?: string | null;
  };
  sessionId?: string;
  tokenExpiresAt?: number;
}

export type RequireAuthRole = "ADMIN" | "ISSUE_ADMIN";

type RequireAuthOptions = {
  /** Required role. Omit for "any authenticated user". */
  role?: RequireAuthRole;
};

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

// Verifies the Summonarr session cookie, runs the refresh logic, and applies
// the role check. Returns either the session, or a NextResponse the caller
// must return.
//
// IMPORTANT: when called outside the withAuth wrapper, any refreshed JWT
// produced by the refresh logic is silently DISCARDED — the caller has no
// response object to attach the Set-Cookie to. This is fine for the rare
// direct callers (dual-auth routes, the play-history export) because the
// next withAuth-wrapped request will re-run the slide.
export async function requireAuth(
  opts: RequireAuthOptions = {},
): Promise<SummonarrSession | NextResponse> {
  // Prefer a bearer token (native clients) over the cookie (browsers). See
  // authenticateRequest for the full rationale.
  const { headers: getHeaders } = await import("next/headers");
  const h = await getHeaders();
  const bearer = parseBearerToken(h.get("authorization"));
  const token = bearer ?? (await cookies()).get(getSessionCookieName())?.value;
  if (!token) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  const result = await verifyAndRefreshSession(token);
  if (!result) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  // Belt-and-suspenders UA-fingerprint check for direct callers (dual-auth
  // routes, the play-history export, SSE). The proxy's matcher excludes
  // prefetch-header requests entirely, so we re-check here so the binding
  // is enforced on every authenticated path. Matches the duplicate in
  // authenticateRequest below. Bearer sessions skip it (app-secure storage,
  // not an ambiently-replayed cookie).
  if (!bearer && !matchesStoredFingerprint(result.claims.uaFingerprint, h.get("user-agent"))) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  if (opts.role && !hasRole(result.claims.role, opts.role)) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }
  return claimsToSession(result.claims);
}

function hasRole(actual: string | undefined, required: RequireAuthRole): boolean {
  if (required === "ADMIN") return actual === "ADMIN";
  return actual === "ADMIN" || actual === "ISSUE_ADMIN";
}

type AuthedHandler<Ctx> = (
  req: NextRequest,
  ctx: Ctx,
  session: SummonarrSession,
) => Response | Promise<Response>;

// Internal: full verify+refresh starting from a NextRequest. Returns either
// the session + maybe-refreshed token, or a NextResponse to return verbatim.
async function authenticateRequest(
  req: NextRequest,
  opts: RequireAuthOptions,
): Promise<{ session: SummonarrSession; refreshed?: RefreshedToken; fromBearer: boolean } | NextResponse> {
  // Prefer a bearer token (native clients) over the cookie (browsers). The two
  // never coexist for one principal; resolving bearer-first means a forged
  // cookie can't ride a request that a bearer made CSRF-exempt upstream.
  const bearer = parseBearerToken(req.headers.get("authorization"));
  const token = bearer ?? parseSessionCookie(req.headers.get("cookie"));
  if (!token) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  const result: VerifyAndRefreshResult | null = await verifyAndRefreshSession(token);
  if (!result) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  // UA-fingerprint check. See matchesStoredFingerprint above for the rationale —
  // belt-and-suspenders with proxy.ts which the prefetch-header matcher exempts.
  // Bearer sessions skip it (app-secure storage, not an ambient browser cookie).
  if (!bearer && !matchesStoredFingerprint(result.claims.uaFingerprint, req.headers.get("user-agent"))) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  if (opts.role && !hasRole(result.claims.role, opts.role)) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }
  return {
    session: claimsToSession(result.claims),
    refreshed: result.refreshed,
    fromBearer: !!bearer,
  };
}

/**
 * Wraps a route handler so the auth check runs before the body and can never
 * be forgotten or mis-returned. The handler only runs for an authorized
 * session; 401 (missing/expired) and 403 (wrong role) responses are returned
 * automatically. This is the canonical pattern for user-session API routes —
 * see CLAUDE.md guardrail 6a. Does NOT apply to cron/sync routes (use
 * `isCronAuthorized`) or plain-text/binary responses (SSE, thumbnails) which
 * stay inline.
 *
 * If verifyAndRefreshSession produces a refreshed JWT (sliding window or
 * sessionId rotation), the wrapper appends Set-Cookie to the handler's
 * response so the client gets the fresh token transparently.
 *
 * Usage:
 *   export const GET = withAdmin(async (req, ctx, session) => { ... });
 *   export const POST = withAuth(async (req, ctx, session) => { ... });
 *   export const PATCH = withIssueAdmin(
 *     async (req, { params }: { params: Promise<{ id: string }> }, session) => { ... }
 *   );
 */
export function withAuth<Ctx = unknown>(
  handler: AuthedHandler<Ctx>,
  opts: RequireAuthOptions = {},
): (req: NextRequest, ctx: Ctx) => Promise<Response> {
  return async (req, ctx) => {
    const result = await authenticateRequest(req, opts);
    if (result instanceof NextResponse) return result;
    const response = await handler(req, ctx, result.session);
    // Thread the slid token back as Set-Cookie for browser sessions only; a
    // bearer client can't read it and rides its fixed-lifetime token to expiry.
    if (result.refreshed && !result.fromBearer) {
      response.headers.append(
        "Set-Cookie",
        serializeSessionCookie(result.refreshed.token, {
          maxAgeSeconds: result.refreshed.expiresInSeconds,
        }),
      );
    }
    return response;
  };
}

/** `withAuth` pinned to ADMIN. */
export const withAdmin = <Ctx = unknown>(handler: AuthedHandler<Ctx>) =>
  withAuth(handler, { role: "ADMIN" });

/**
 * Issue-management gate. Authoritative on the MANAGE_ISSUES permission BIT, not
 * the role label — the ADMIN superbit and the ISSUE_ADMIN preset both carry it,
 * so normal ADMIN/ISSUE_ADMIN access is unchanged, but clearing MANAGE_ISSUES from
 * a user now actually revokes issue/fix-match API access (and granting it to a
 * plain USER grants it), keeping the bitmask the single source of truth. The proxy
 * /api/admin/* role backstop still only fails-closed roles with NO admin access, so
 * it can't wrongly deny a permission-bearing caller — this wrapper is the precise check.
 */
export const withIssueAdmin = <Ctx = unknown>(handler: AuthedHandler<Ctx>) =>
  withPermission(Permission.MANAGE_ISSUES)<Ctx>(handler);

/**
 * `withAuth` plus a capability check against the user's permission bitmask
 * (Overseerr-style). `session.user.permissions` is already the *effective* mask
 * — ADMIN role resolves to the superbit and unseeded rows fall back to the role
 * preset — so admins always pass and nobody is locked out mid-migration.
 * Returns 403 when the required bit(s) aren't held. Curried so it composes like
 * the role wrappers:
 *
 *   export const PATCH = withPermission(Permission.MANAGE_REQUESTS)(
 *     async (req, ctx, session) => { ... },
 *   );
 *
 * `mode` "or" (default): any required bit satisfies; "and": all required.
 */
export function withPermission(
  required: PermissionValue | PermissionValue[],
  mode: "and" | "or" = "or",
) {
  // Ctx is generic on the RETURNED function so it's inferred from the handler
  // (dynamic routes pass `{ params: Promise<{...}> }`).
  return <Ctx = unknown>(handler: AuthedHandler<Ctx>) =>
    withAuth<Ctx>(async (req, ctx, session) => {
      if (!hasPermission(session.user.permissions, required, mode)) {
        return NextResponse.json({ error: "Forbidden" }, { status: 403 });
      }
      return handler(req, ctx, session);
    });
}
