import type { Session } from "next-auth";
import { NextResponse } from "next/server";
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
