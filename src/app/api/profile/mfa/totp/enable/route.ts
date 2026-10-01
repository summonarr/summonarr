import { NextResponse } from "next/server";
import { withAuth } from "@/lib/api-auth";
import { maintenanceGuard } from "@/lib/maintenance";
import { readJsonCapped } from "@/lib/body-size";
import { prisma } from "@/lib/prisma";
import { checkRateLimit } from "@/lib/rate-limit";
import { logAudit, auditContext } from "@/lib/audit";
import { revokeOtherUserSessions } from "@/lib/auth";
import { confirmTotpEnrollmentInTx, ensureRecoveryCodesInTx, getMfaState, type ConfirmTotpResult } from "@/lib/mfa/mfa-store";
import { mfaEligibleUser } from "@/lib/mfa/step-up";
import { notifyMfaSecurityEvent } from "@/lib/mfa/notify";

// POST /api/profile/mfa/totp/enable — confirms the pending secret from
// /totp/setup with a current code and turns the authenticator app on.
// Body: { code }. No password here: the secret only exists because the setup
// call passed the enrollment step-up (password, plus a second factor when one
// was already active), and only that response ever carried it. A secret issued
// on the password alone, before the account had any factor, is deleted when a
// passkey becomes the first factor instead (passkeys/route.ts) — so it can
// never be confirmed onto an account that has 2FA by then.
//
// When this is the account's FIRST second factor the response carries ten
// one-time recovery codes (shown once) and every OTHER session is signed out.
export const POST = withAuth(async (req, _ctx, session) => {
  const maint = await maintenanceGuard(session);
  if (maint) return maint;
  if (!checkRateLimit(`mfa-totp-enable:${session.user.id}`, 10, 15 * 60 * 1000)) {
    return NextResponse.json({ error: "Too many attempts — please wait 15 minutes." }, { status: 429 });
  }
  const parsed = await readJsonCapped<{ code?: unknown }>(req, 4096);
  if (parsed instanceof NextResponse) return parsed;
  if (typeof parsed.code !== "string" || parsed.code.length === 0 || parsed.code.length > 32) {
    return NextResponse.json({ error: "Enter the 6-digit code from your authenticator app" }, { status: 400 });
  }
  const user = await mfaEligibleUser(session);
  if (user instanceof NextResponse) return user;

  const before = await getMfaState(user.id);
  const code = parsed.code;
  const outcome = await prisma.$transaction(async (tx) => {
    const result: ConfirmTotpResult = await confirmTotpEnrollmentInTx(tx, user.id, code);
    if (result !== "ok") return { result, recoveryCodes: null as string[] | null };
    return { result, recoveryCodes: await ensureRecoveryCodesInTx(tx, user.id) };
  });
  if (outcome.result === "no-pending") {
    return NextResponse.json({ error: "Start the authenticator setup first" }, { status: 400 });
  }
  if (outcome.result === "already-enabled") {
    return NextResponse.json({ error: "An authenticator app is already set up" }, { status: 409 });
  }
  if (outcome.result === "invalid") {
    return NextResponse.json({ error: "That code didn't match. Check the time on your device and try again." }, { status: 400 });
  }

  const revoked = before.enabled ? 0 : await revokeOtherUserSessions(user.id, session.sessionId);
  void notifyMfaSecurityEvent(user.id, "totp-enabled");
  void logAudit({
    userId: user.id,
    userName: user.name ?? user.email,
    action: "MFA_CHANGE",
    target: `user:${user.id}`,
    details: { kind: "totp-enabled", firstFactor: !before.enabled, otherSessionsRevoked: revoked },
    ...auditContext(req, session),
  });
  return NextResponse.json(
    { ok: true, ...(outcome.recoveryCodes ? { recoveryCodes: outcome.recoveryCodes } : {}) },
    { headers: { "Cache-Control": "no-store" } },
  );
});
