import { NextResponse } from "next/server";
import { withAuth } from "@/lib/api-auth";
import { maintenanceGuard } from "@/lib/maintenance";
import { readJsonCappedOr } from "@/lib/body-size";
import { prisma } from "@/lib/prisma";
import { logAudit, auditContext } from "@/lib/audit";
import { revokeOtherUserSessions } from "@/lib/auth";
import { dropRecoveryCodesIfNoFactorInTx, getMfaState, lockUserMfaInTx } from "@/lib/mfa/mfa-store";
import { mfaReauthStepUp, mfaSecondFactorStepUp, secondFactorRequiredResponse } from "@/lib/mfa/step-up";
import { notifyMfaSecurityEvent } from "@/lib/mfa/notify";
import { translatorForRequest } from "@/lib/i18n/server-locale";

// DELETE /api/profile/mfa/totp — removes the authenticator app (enabled or a
// pending setup). Body: { password, secondFactor? } — the second factor is
// required whenever a factor is active (step-up.ts); removing only a PENDING
// setup from an account with no factor is password-only. If no passkey
// remains, the recovery codes go too, the account is back to password-only, and
// every OTHER session is signed out — the same as turning 2FA off outright.
export const DELETE = withAuth(async (req, _ctx, session) => {
  const t = translatorForRequest(req);
  const maint = await maintenanceGuard(session);
  if (maint) return maint;
  const parsed = await readJsonCappedOr<{ password?: unknown; secondFactor?: unknown }>(req, 64 * 1024, {});
  if (parsed instanceof NextResponse) return parsed;
  const user = await mfaReauthStepUp(session, parsed.password, t, req);
  if (user instanceof NextResponse) return user;
  // Nothing to remove ⇒ 404 BEFORE the second factor: a recovery code used as
  // proof is consumed, and must not be spent on a no-op.
  const state = await getMfaState(user.id);
  if (!state.totpEnabled && !state.totpPending) return NextResponse.json({ error: t("apiAuth.mfa.noTotp") }, { status: 404 });
  const proof = await mfaSecondFactorStepUp(req, session, user, parsed.secondFactor, state);
  if (proof instanceof NextResponse) return proof;
  const before = proof.state;

  const outcome = await prisma.$transaction(async (tx) => {
    // Same lock as enable. A password-only cancel of a PENDING secret must not
    // delete a row that was confirmed after this request read "pending".
    await lockUserMfaInTx(tx, user.id);
    const fresh = await tx.userTotp.findUnique({ where: { userId: user.id }, select: { enabledAt: true } });
    if (!proof.proved && fresh?.enabledAt) return { removed: 0, needsFactor: true as const, noneLeft: false };
    const res = await tx.userTotp.deleteMany({
      where: proof.proved ? { userId: user.id } : { userId: user.id, enabledAt: null },
    });
    const noneLeft = await dropRecoveryCodesIfNoFactorInTx(tx, user.id);
    return { removed: res.count, needsFactor: false as const, noneLeft };
  });
  if (outcome.needsFactor) return secondFactorRequiredResponse(t, await getMfaState(user.id));
  if (outcome.removed === 0) return NextResponse.json({ error: t("apiAuth.mfa.noTotp") }, { status: 404 });

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
