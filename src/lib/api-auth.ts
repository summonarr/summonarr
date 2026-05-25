import { cookies } from "next/headers";
import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import {
  getSessionCookieName,
  parseSessionCookie,
  serializeSessionCookie,
} from "@/lib/session-cookie";
import {
  verifyAndRefreshSession,
  type RefreshedToken,
  type VerifyAndRefreshResult,
} from "@/lib/session-refresh";
import type { SessionClaims } from "@/lib/session-jwt";

// The session passed to authenticated handlers. Shaped to match what
// next-auth's Session was — `user.{id,role,provider,mediaServer}`,
// `sessionId`, `tokenExpiresAt` — so handler bodies didn't have to change
// when next-auth went away.
export interface SummonarrSession {
  user: {
    id: string;
    role: string;
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
  const cookieStore = await cookies();
  const token = cookieStore.get(getSessionCookieName())?.value;
  if (!token) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  const result = await verifyAndRefreshSession(token);
  if (!result) {
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
): Promise<{ session: SummonarrSession; refreshed?: RefreshedToken } | NextResponse> {
  const token = parseSessionCookie(req.headers.get("cookie"));
  if (!token) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  const result: VerifyAndRefreshResult | null = await verifyAndRefreshSession(token);
  if (!result) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  if (opts.role && !hasRole(result.claims.role, opts.role)) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }
  return {
    session: claimsToSession(result.claims),
    refreshed: result.refreshed,
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
    if (result.refreshed) {
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

/** `withAuth` pinned to ISSUE_ADMIN (accepts ADMIN or ISSUE_ADMIN). */
export const withIssueAdmin = <Ctx = unknown>(handler: AuthedHandler<Ctx>) =>
  withAuth(handler, { role: "ISSUE_ADMIN" });
