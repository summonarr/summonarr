import type { Session } from "next-auth";
import { NextResponse } from "next/server";
import { auth, isTokenExpired } from "@/lib/auth";

export type RequireAuthRole = "ADMIN" | "ISSUE_ADMIN";

type RequireAuthOptions = {
  /** Required role. Omit for "any authenticated user". */
  role?: RequireAuthRole;
  /**
   * When `role` is set, split the response status: 401 for missing/expired session,
   * 403 only for wrong role. Default (no `split`) returns 403 for any failure,
   * matching the majority of existing admin routes.
   */
  split?: boolean;
};

/**
 * Returns the authenticated Session, or a NextResponse that the caller must return.
 * Usage:
 *   const session = await requireAuth({ role: "ADMIN" });
 *   if (session instanceof NextResponse) return session;
 */
export async function requireAuth(
  opts: RequireAuthOptions = {}
): Promise<Session | NextResponse> {
  const session = await auth();

  // Split mode preserves legacy behavior of the split-pattern admin routes:
  // 401 only for missing session; 403 for expired session OR wrong role.
  if (opts.split) {
    if (!session) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }
    if (isTokenExpired(session)) {
      return NextResponse.json({ error: "Forbidden" }, { status: 403 });
    }
    if (opts.role && !hasRole(session.user.role, opts.role)) {
      return NextResponse.json({ error: "Forbidden" }, { status: 403 });
    }
    return session;
  }

  const authed = !!session && !isTokenExpired(session);
  if (!authed) {
    return opts.role
      ? NextResponse.json({ error: "Forbidden" }, { status: 403 })
      : NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  if (opts.role && !hasRole(session!.user.role, opts.role)) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  return session!;
}

function hasRole(actual: string | undefined, required: RequireAuthRole): boolean {
  if (required === "ADMIN") return actual === "ADMIN";
  return actual === "ADMIN" || actual === "ISSUE_ADMIN";
}
