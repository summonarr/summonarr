import { NextResponse } from "next/server";
import { authActive } from "./auth";
import type { SummonarrSession } from "./api-auth";
import { prisma } from "./prisma";
import { hasPermission, Permission } from "./permissions";

export async function getMaintenanceStatus(): Promise<{ enabled: boolean; message: string }> {
  try {
    const rows = await prisma.setting.findMany({
      where: { key: { in: ["maintenanceEnabled", "maintenanceMessage"] } },
    });
    const cfg = Object.fromEntries(rows.map((r) => [r.key, r.value]));
    return {
      enabled: cfg.maintenanceEnabled === "true",
      message: cfg.maintenanceMessage ?? "",
    };
  } catch {
    // A Settings read failure means we cannot prove maintenance is off; fail closed
    // so writes don't slip through during a database incident.
    return { enabled: true, message: "" };
  }
}

// `session` is the DB-checked, bearer-first session the route's withAuth /
// withAdmin / withIssueAdmin wrapper (or requireAuth) already resolved — pass
// it. Every wrapper runs verifyAndRefreshSession (revocation, cutoffs, role
// rotation, UA fingerprint), so a demoted admin holding an unexpired JWT still
// cannot bypass maintenance: the admin bypass is an authz decision and sees the
// current role either way.
//
// The no-argument fallback re-resolves through authActive(), which is
// COOKIE-ONLY (readActiveSummonarrSession reads cookies() and never the
// Authorization header — see session-server.ts). It must NOT be the primary
// path on an API route: a native admin holds only a bearer JWT (guardrail 6b),
// so the fallback sees no cookie, treats the caller as anonymous, and answers
// 503 to the one person who is supposed to be able to act during maintenance.
// It also pays a second session verify per request on the cookie transport.
// `null` (an explicitly anonymous caller) is honoured as-is, not re-resolved.
export async function maintenanceGuard(
  session?: SummonarrSession | null,
): Promise<NextResponse | null> {
  const s = session === undefined ? await authActive() : session;
  if (s && hasPermission(s.user.permissions, Permission.ADMIN)) return null;
  const { enabled, message } = await getMaintenanceStatus();
  if (!enabled) return null;
  return NextResponse.json(
    { error: "Service unavailable", message: message || "Under maintenance" },
    { status: 503 }
  );
}
