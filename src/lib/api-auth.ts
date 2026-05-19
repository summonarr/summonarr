import type { Session } from "next-auth";
import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import { auth, isTokenExpired } from "@/lib/auth";

export type RequireAuthRole = "ADMIN" | "ISSUE_ADMIN";

type RequireAuthOptions = {
  /** Required role. Omit for "any authenticated user". */
  role?: RequireAuthRole;
};

/**
 * Returns the authenticated Session, or a NextResponse that the caller must return.
 * 401 for missing/expired session, 403 only for wrong role.
 *
 * Usage:
 *   const session = await requireAuth({ role: "ADMIN" });
 *   if (session instanceof NextResponse) return session;
 */
export async function requireAuth(
  opts: RequireAuthOptions = {}
): Promise<Session | NextResponse> {
  const session = await auth();

  if (!session || isTokenExpired(session)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  if (opts.role && !hasRole(session.user.role, opts.role)) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  return session;
}

function hasRole(actual: string | undefined, required: RequireAuthRole): boolean {
  if (required === "ADMIN") return actual === "ADMIN";
  return actual === "ADMIN" || actual === "ISSUE_ADMIN";
}

type AuthedHandler<Ctx> = (
  req: NextRequest,
  ctx: Ctx,
  session: Session
) => Response | Promise<Response>;

/**
 * Wraps a route handler so the auth check runs before the body and can never
 * be forgotten or mis-returned. The handler only runs for an authorized
 * session; 401 (missing/expired) and 403 (wrong role) responses are returned
 * automatically. This is the canonical pattern for user-session API routes —
 * see CLAUDE.md guardrail 6a. Does NOT apply to cron/sync routes (use
 * `isCronAuthorized`) or plain-text/binary responses (SSE, thumbnails) which
 * stay inline.
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
  opts: RequireAuthOptions = {}
): (req: NextRequest, ctx: Ctx) => Promise<Response> {
  return async (req, ctx) => {
    const session = await requireAuth(opts);
    if (session instanceof NextResponse) return session;
    return handler(req, ctx, session);
  };
}

/** `withAuth` pinned to ADMIN. */
export const withAdmin = <Ctx = unknown>(handler: AuthedHandler<Ctx>) =>
  withAuth(handler, { role: "ADMIN" });

/** `withAuth` pinned to ISSUE_ADMIN (accepts ADMIN or ISSUE_ADMIN). */
export const withIssueAdmin = <Ctx = unknown>(handler: AuthedHandler<Ctx>) =>
  withAuth(handler, { role: "ISSUE_ADMIN" });
