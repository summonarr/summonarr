import { NextResponse } from "next/server";
import { withPermission } from "@/lib/api-auth";
import { checkRateLimit } from "@/lib/rate-limit";
import { revokeAllUserSessions } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { logAudit, auditContext } from "@/lib/audit";
import { Permission, hasPermission } from "@/lib/permissions";
import { deleteAllMfaInTx, getMfaState } from "@/lib/mfa/mfa-store";

// DELETE /api/admin/users/[id]/mfa — reset a user's two-factor authentication
// (lost phone / lost security key). Removes their authenticator app, every
// passkey and every recovery code, and signs the account out everywhere; their
// next sign-in is password-only and they can enroll again from their profile.
//
// MANAGE_USERS, like the other account-lifecycle actions; resetting an ADMIN
// account additionally needs the ADMIN bit (a delegated user manager must not be
// able to strip an admin's second factor). Never the caller's own account: that
// path would skip the password step-up the profile routes demand — use
// DELETE /api/profile/mfa instead.
export const DELETE = withPermission(Permission.MANAGE_USERS)(async (
  req,
  { params }: { params: Promise<{ id: string }> },
  session,
) => {
  const { id } = await params;
  if (!checkRateLimit(`admin-user-mfa-reset:${session.user.id}`, 10, 60 * 1000)) {
    return NextResponse.json({ error: "Too many attempts — please wait a minute." }, { status: 429 });
  }
  if (id === session.user.id) {
    return NextResponse.json(
      { error: "Use your profile page to change your own two-factor settings." },
      { status: 400 },
    );
  }

  const target = await prisma.user.findUnique({
    where: { id },
    select: { role: true, name: true, email: true },
  });
  if (!target) return NextResponse.json({ error: "Not found" }, { status: 404 });
  if (target.role === "ADMIN" && !hasPermission(session.user.permissions, Permission.ADMIN)) {
    return NextResponse.json({ error: "Only an admin can reset an admin's two-factor" }, { status: 403 });
  }

  const before = await getMfaState(id);
  await prisma.$transaction(async (tx) => {
    await deleteAllMfaInTx(tx, id);
  });
  // Every device of the target — a reset is a security event, and whoever lost
  // the factor may not be the only one holding a session.
  await revokeAllUserSessions(id);

  // Committed — a failed audit write must not 500 it (guardrail 26).
  void logAudit({
    userId: session.user.id,
    userName: session.user.name ?? session.user.email ?? "unknown",
    action: "MFA_RESET",
    target: `user:${id}`,
    details: {
      targetUser: target.name ?? target.email,
      role: target.role,
      before: { totp: before.totpEnabled, passkeys: before.passkeys.length, recoveryCodes: before.recoveryRemaining },
    },
    ...auditContext(req, session),
  });
  return NextResponse.json({ ok: true });
});
