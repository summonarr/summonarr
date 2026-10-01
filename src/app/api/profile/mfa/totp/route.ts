import { NextResponse } from "next/server";
import { withAuth } from "@/lib/api-auth";
import { maintenanceGuard } from "@/lib/maintenance";
import { readJsonCappedOr } from "@/lib/body-size";
import { prisma } from "@/lib/prisma";
import { logAudit, auditContext } from "@/lib/audit";
import { dropRecoveryCodesIfNoFactorInTx } from "@/lib/mfa/mfa-store";
import { mfaPasswordStepUp } from "@/lib/mfa/step-up";

// DELETE /api/profile/mfa/totp — removes the authenticator app (enabled or a
// pending setup). Body: { password }. If no passkey remains, the recovery codes
// go too and the account is back to password-only.
export const DELETE = withAuth(async (req, _ctx, session) => {
  const maint = await maintenanceGuard(session);
  if (maint) return maint;
  const parsed = await readJsonCappedOr<{ password?: unknown }>(req, 16384, {});
  if (parsed instanceof NextResponse) return parsed;
  const user = await mfaPasswordStepUp(session, parsed.password);
  if (user instanceof NextResponse) return user;

  const removed = await prisma.$transaction(async (tx) => {
    const res = await tx.userTotp.deleteMany({ where: { userId: user.id } });
    await dropRecoveryCodesIfNoFactorInTx(tx, user.id);
    return res.count;
  });
  if (removed === 0) return NextResponse.json({ error: "No authenticator app is set up" }, { status: 404 });

  void logAudit({
    userId: user.id,
    userName: user.name ?? user.email,
    action: "MFA_CHANGE",
    target: `user:${user.id}`,
    details: { kind: "totp-removed" },
    ...auditContext(req, session),
  });
  return NextResponse.json({ ok: true });
});
