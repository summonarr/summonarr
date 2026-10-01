import { NextResponse } from "next/server";
import { withAuth } from "@/lib/api-auth";
import { maintenanceGuard } from "@/lib/maintenance";
import { readJsonCapped } from "@/lib/body-size";
import { prisma } from "@/lib/prisma";
import { logAudit, auditContext } from "@/lib/audit";
import { getMfaState, replaceRecoveryCodesInTx } from "@/lib/mfa/mfa-store";
import { mfaPasswordStepUp } from "@/lib/mfa/step-up";

// POST /api/profile/mfa/recovery-codes — replaces every recovery code with ten
// new ones (old ones stop working immediately). Body: { password }. The new
// codes are in this response and nowhere else — only their hashes are stored.
export const POST = withAuth(async (req, _ctx, session) => {
  const maint = await maintenanceGuard(session);
  if (maint) return maint;
  const parsed = await readJsonCapped<{ password?: unknown }>(req, 16384);
  if (parsed instanceof NextResponse) return parsed;
  const user = await mfaPasswordStepUp(session, parsed.password);
  if (user instanceof NextResponse) return user;

  const state = await getMfaState(user.id);
  if (!state.enabled) {
    return NextResponse.json({ error: "Turn on two-factor authentication first" }, { status: 400 });
  }
  const codes = await prisma.$transaction(async (tx) => replaceRecoveryCodesInTx(tx, user.id));

  void logAudit({
    userId: user.id,
    userName: user.name ?? user.email,
    action: "MFA_CHANGE",
    target: `user:${user.id}`,
    details: { kind: "recovery-regenerated", previousRemaining: state.recoveryRemaining },
    ...auditContext(req, session),
  });
  return NextResponse.json({ recoveryCodes: codes }, { headers: { "Cache-Control": "no-store" } });
});
