import { NextResponse } from "next/server";
import { withPermission } from "@/lib/api-auth";
import { checkRateLimit } from "@/lib/rate-limit";
import { tooManyRequests } from "@/lib/http";
import { revokeAllUserSessions } from "@/lib/auth";
import { clearSessionFootholdsInTx } from "@/lib/session-footholds";
import { prisma } from "@/lib/prisma";
import { logAudit, auditContext } from "@/lib/audit";
import { Permission } from "@/lib/permissions";
import { clearMfaLockoutInTx, deleteAllMfaInTx, getMfaState } from "@/lib/mfa/mfa-store";
import { notifyMfaSecurityEvent } from "@/lib/mfa/notify";
import { translatorForRequest } from "@/lib/i18n/server-locale";
import { lockTargetInTx, TargetBecameAdminError, TargetGoneError, TargetOutranksCallerError, targetRefusal } from "@/lib/account-lifecycle";

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
    return tooManyRequests(60, t("apiAdmin.common.tooManyAttempts"));
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
  // Nor may a delegate strip the second factor of a peer holding management
  // permissions it lacks (targetRefusal).
  const refusal = targetRefusal(target, session.user.permissions);
  if (refusal === "admin") {
    return NextResponse.json({ error: t("apiAdmin.users.onlyAdminResetMfa") }, { status: 403 });
  }
  if (refusal === "outranks") {
    return NextResponse.json({ error: t("apiAdmin.users.cannotManageBeyondOwn") }, { status: 403 });
  }

  const before = await getMfaState(id);
  // Factor delete, session revoke, foothold clear and calendar-token null must
  // commit together: a reset that dropped 2FA and then failed to revoke would
  // leave sessions and planted footholds on an account that now signs in with
  // the password alone. Folded into revokeAllUserSessions' own transaction
  // (the same shape as admin revoke-all) rather than a prior tx. Not folded
  // into the helper itself — Jellyfin offboarding uses it without wanting to
  // drop factors or footholds. Guardrail 23: this catch is OUTSIDE the tx and
  // only maps the in-tx admin-target and row-gone refusals; a failed write
  // propagates.
  try {
    await revokeAllUserSessions(id, async (tx) => {
      // The role read above is stale by the time the tx opens: a promotion to
      // ADMIN landing in between would let a delegated MANAGE_USERS holder strip
      // an admin's second factor. Re-resolve it under advisory lock 42 — the lock
      // the role-change and deactivate paths take (admin/users/[id]/route.ts) —
      // and decide on that value. A row gone since the read above is a 404, not
      // a write against nothing (which would 500 on the update below).
      const fresh = await lockTargetInTx(tx, id, session.user.permissions);
      if (!fresh) throw new TargetGoneError();
      await deleteAllMfaInTx(tx, id);
      // A lost phone is exactly when an owner locks themselves out guessing.
      await clearMfaLockoutInTx(tx, id);
      await clearSessionFootholdsInTx(tx, id);
      await tx.user.update({
        where: { id },
        data: { calendarTokenHash: null, calendarTokenCreatedAt: null },
      });
    });
  } catch (err) {
    if (err instanceof TargetBecameAdminError) {
      return NextResponse.json({ error: t("apiAdmin.users.onlyAdminResetMfa") }, { status: 403 });
    }
    if (err instanceof TargetOutranksCallerError) {
      return NextResponse.json({ error: t("apiAdmin.users.cannotManageBeyondOwn") }, { status: 403 });
    }
    if (err instanceof TargetGoneError) {
      return NextResponse.json({ error: t("apiAdmin.common.notFound") }, { status: 404 });
    }
    throw err;
  }
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
