import { NextResponse } from "next/server";
import { withAuth } from "@/lib/api-auth";
import { maintenanceGuard } from "@/lib/maintenance";
import { readJsonCappedOr } from "@/lib/body-size";
import { prisma } from "@/lib/prisma";
import { logAudit, auditContext } from "@/lib/audit";
import { revokeOtherUserSessions } from "@/lib/auth";
import { dropRecoveryCodesIfNoFactorInTx } from "@/lib/mfa/mfa-store";
import { mfaPasswordStepUp, mfaSecondFactorStepUp } from "@/lib/mfa/step-up";
import { notifyMfaSecurityEvent } from "@/lib/mfa/notify";

// DELETE /api/profile/mfa/totp — removes the authenticator app (enabled or a
// pending setup). Body: { password, secondFactor? } — the second factor is
// required whenever a factor is active (step-up.ts); removing only a PENDING
// setup from an account with no factor is password-only. If no passkey
// remains, the recovery codes go too, the account is back to password-only, and
// every OTHER session is signed out — the same as turning 2FA off outright.
export const DELETE = withAuth(async (req, _ctx, session) => {
  const maint = await maintenanceGuard(session);
  if (maint) return maint;
  const parsed = await readJsonCappedOr<{ password?: unknown; secondFactor?: unknown }>(req, 64 * 1024, {});
  if (parsed instanceof NextResponse) return parsed;
  const user = await mfaPasswordStepUp(session, parsed.password);
  if (user instanceof NextResponse) return user;
  const proof = await mfaSecondFactorStepUp(req, session, user, parsed.secondFactor);
  if (proof instanceof NextResponse) return proof;
  const before = proof.state;

  const outcome = await prisma.$transaction(async (tx) => {
    const res = await tx.userTotp.deleteMany({ where: { userId: user.id } });
    const noneLeft = await dropRecoveryCodesIfNoFactorInTx(tx, user.id);
    return { removed: res.count, noneLeft };
  });
  if (outcome.removed === 0) return NextResponse.json({ error: "No authenticator app is set up" }, { status: 404 });

  // The last factor went: the account is password-only from now on, so any
  // session that existed alongside the 2FA one is signed out (guardrail 6d).
  const revoked = before.enabled && outcome.noneLeft ? await revokeOtherUserSessions(user.id, session.sessionId) : 0;
  if (before.totpEnabled) void notifyMfaSecurityEvent(user.id, "totp-removed");
  void logAudit({
    userId: user.id,
    userName: user.name ?? user.email,
    action: "MFA_CHANGE",
    target: `user:${user.id}`,
    details: { kind: "totp-removed", lastFactor: before.enabled && outcome.noneLeft, otherSessionsRevoked: revoked },
    ...auditContext(req, session),
  });
  return NextResponse.json({ ok: true });
});
