import { NextResponse } from "next/server";
import { withAuth } from "@/lib/api-auth";
import { maintenanceGuard } from "@/lib/maintenance";
import { readJsonCapped } from "@/lib/body-size";
import { prisma } from "@/lib/prisma";
import { logAudit, auditContext } from "@/lib/audit";
import { getMfaState, replaceRecoveryCodesInTx } from "@/lib/mfa/mfa-store";
import { mfaReauthStepUp, mfaSecondFactorStepUp } from "@/lib/mfa/step-up";
import { notifyMfaSecurityEvent } from "@/lib/mfa/notify";
import { translatorForRequest } from "@/lib/i18n/server-locale";

// POST /api/profile/mfa/recovery-codes — replaces every recovery code with ten
// new ones (old ones stop working immediately). Body: { password, secondFactor }
// — 2FA is necessarily on here, so a fresh second factor is always required
// (step-up.ts); a recovery code used as that proof is consumed first. The new
// codes are in this response and nowhere else — only their hashes are stored.
export const POST = withAuth(async (req, _ctx, session) => {
  const t = translatorForRequest(req);
  const maint = await maintenanceGuard(session);
  if (maint) return maint;
  const parsed = await readJsonCapped<{ password?: unknown; secondFactor?: unknown }>(req, 64 * 1024);
  if (parsed instanceof NextResponse) return parsed;
  const user = await mfaReauthStepUp(session, parsed.password, t);
  if (user instanceof NextResponse) return user;

  const state = await getMfaState(user.id);
  if (!state.enabled) {
    return NextResponse.json({ error: t("apiAuth.mfa.enableFirst") }, { status: 400 });
  }
  const proof = await mfaSecondFactorStepUp(req, session, user, parsed.secondFactor, state);
  if (proof instanceof NextResponse) return proof;
  const codes = await prisma.$transaction(async (tx) => replaceRecoveryCodesInTx(tx, user.id));
  void notifyMfaSecurityEvent(user.id, "recovery-regenerated");

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
