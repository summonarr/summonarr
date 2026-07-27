import { NextResponse } from "next/server";
import { withPermission } from "@/lib/api-auth";
import { checkRateLimit } from "@/lib/rate-limit";
import { invalidateUserSession } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { logAudit, auditContext } from "@/lib/audit";
import { Permission, hasPermission } from "@/lib/permissions";
import { reactivateUser } from "@/lib/account-lifecycle";

// POST /api/admin/users/[id]/reactivate — re-enable a disabled account.
//
// The reverse of DELETE /api/admin/users/[id] (and of a user's own
// DELETE /api/profile): account removal disables rather than scrubs, so
// everything the account needs to work again is still there — clearing
// `deactivatedAt` is the whole restore. Sessions are NOT restored:
// `sessionsRevokedAt` stays where deactivation left it, so the user signs in
// again to get a fresh one.
export const POST = withPermission(Permission.MANAGE_USERS)(async (
  req,
  { params }: { params: Promise<{ id: string }> },
  session,
) => {
  const { id } = await params;
  if (!checkRateLimit(`admin-user-reactivate:${session.user.id}`, 10, 60 * 1000)) {
    return NextResponse.json({ error: "Too many attempts — please wait a minute." }, { status: 429 });
  }

  const target = await prisma.user.findUnique({
    where: { id },
    select: { role: true, name: true, email: true, deactivatedAt: true, purgedAt: true },
  });
  if (!target) return NextResponse.json({ error: "Not found" }, { status: 404 });

  // Same authority gate as the disable path: a non-admin MANAGE_USERS holder must
  // not be able to switch an admin account back on (restoring an admin is at
  // least as privileged as disabling one).
  if (target.role === "ADMIN" && !hasPermission(session.user.permissions, Permission.ADMIN)) {
    return NextResponse.json({ error: "Only an admin can re-enable an admin account" }, { status: 403 });
  }

  if (target.purgedAt) {
    return NextResponse.json(
      { error: "This account's data was purged and it can no longer be re-enabled." },
      { status: 400 },
    );
  }
  if (!target.deactivatedAt) return NextResponse.json({ ok: true }); // idempotent

  const restored = await reactivateUser(id);
  if (!restored) {
    // Lost a race with a concurrent purge/reactivate — the row no longer matches
    // the (disabled AND not purged) precondition.
    return NextResponse.json({ error: "Account state changed — reload and try again." }, { status: 409 });
  }

  invalidateUserSession(id);

  // Already committed; a failed audit write must not 500 it (guardrail 26).
  void logAudit({
    userId: session.user.id,
    userName: session.user.name ?? session.user.email,
    action: "USER_REACTIVATE",
    target: `user:${id}`,
    details: { targetUser: target.name ?? target.email, targetEmail: target.email, role: target.role },
    ...auditContext(req, session),
  });

  return NextResponse.json({ ok: true });
});
