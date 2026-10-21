import { NextResponse } from "next/server";
import { withPermission } from "@/lib/api-auth";
import { checkRateLimit } from "@/lib/rate-limit";
import { revokeAllUserSessions } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { logAudit, auditContext } from "@/lib/audit";
import { Permission, hasPermission } from "@/lib/permissions";
import { clearMfaLockoutInTx, deleteAllMfaInTx, getMfaState } from "@/lib/mfa/mfa-store";
import { notifyMfaSecurityEvent } from "@/lib/mfa/notify";
import { translatorForRequest } from "@/lib/i18n/server-locale";

class TargetBecameAdminError extends Error {}

// An admin target is one with role ADMIN OR the ADMIN superbit. The two are kept
// in lockstep by the users PATCH, but this gate guards stripping an admin's
// second factor, so it must not depend on that invariant holding for legacy or
// hand-edited rows.
function isAdminTarget(row: { role: string; permissions?: bigint | null } | null | undefined): boolean {
  if (!row) return false;
  if (row.role === "ADMIN") return true;
  return typeof row.permissions === "bigint" && (row.permissions & Permission.ADMIN) !== 0n;
}

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
  const t = translatorForRequest(req);
  const { id } = await params;
  if (!checkRateLimit(`admin-user-mfa-reset:${session.user.id}`, 10, 60 * 1000)) {
    return NextResponse.json({ error: t("apiAdmin.common.tooManyAttempts") }, { status: 429 });
  }
  if (id === session.user.id) {
    return NextResponse.json(
      { error: t("apiAdmin.users.useProfileForOwnMfa") },
      { status: 400 },
    );
  }

  const target = await prisma.user.findUnique({
    where: { id },
    select: { role: true, permissions: true, name: true },
  });
  if (!target) return NextResponse.json({ error: t("apiAdmin.common.notFound") }, { status: 404 });
  if (isAdminTarget(target) && !hasPermission(session.user.permissions, Permission.ADMIN)) {
    return NextResponse.json({ error: t("apiAdmin.users.onlyAdminResetMfa") }, { status: 403 });
  }

  const before = await getMfaState(id);
  try {
    await prisma.$transaction(async (tx) => {
      // The role read above is stale by the time the tx opens: a promotion to
      // ADMIN landing in between would let a delegated MANAGE_USERS holder strip
      // an admin's second factor. Re-resolve it under advisory lock 42 — the lock
      // the role-change and deactivate paths take (admin/users/[id]/route.ts) —
      // and decide on that value.
      await tx.$executeRawUnsafe("SELECT pg_advisory_xact_lock(42)");
      const fresh = await tx.user.findUnique({ where: { id }, select: { role: true, permissions: true } });
      if (isAdminTarget(fresh ?? target) && !hasPermission(session.user.permissions, Permission.ADMIN)) {
        throw new TargetBecameAdminError();
      }
      await deleteAllMfaInTx(tx, id);
      // A lost phone is exactly when an owner locks themselves out guessing.
      await clearMfaLockoutInTx(tx, id);
    });
  } catch (err) {
    if (err instanceof TargetBecameAdminError) {
      return NextResponse.json({ error: t("apiAdmin.users.onlyAdminResetMfa") }, { status: 403 });
    }
    throw err;
  }
  // Every device of the target — a reset is a security event, and whoever lost
  // the factor may not be the only one holding a session.
  await revokeAllUserSessions(id);
  if (before.enabled) void notifyMfaSecurityEvent(id, "mfa-reset");

  // Committed — a failed audit write must not 500 it (guardrail 26). The target
  // is named by id (+ display name), never by email (audit-scrub.ts).
  void logAudit({
    userId: session.user.id,
    userName: session.user.name ?? session.user.email ?? "unknown",
    action: "MFA_RESET",
    target: `user:${id}`,
    details: {
      targetUserId: id,
      ...(target.name ? { targetUser: target.name } : {}),
      role: target.role,
      before: { totp: before.totpEnabled, passkeys: before.passkeys.length, recoveryCodes: before.recoveryRemaining },
    },
    ...auditContext(req, session),
  });
  return NextResponse.json({ ok: true });
});
