import { NextResponse } from "next/server";
import { withAuth } from "@/lib/api-auth";
import { maintenanceGuard } from "@/lib/maintenance";
import { readJsonCappedOr } from "@/lib/body-size";
import { prisma } from "@/lib/prisma";
import { logAudit, auditContext } from "@/lib/audit";
import { revokeOtherUserSessionsInTx } from "@/lib/auth";
import { markSessionForceRevoked } from "@/lib/session-revocation";
import { clearMfaLockoutInTx, deleteAllMfaInTx, getMfaState, lockUserMfaInTx } from "@/lib/mfa/mfa-store";
import { mfaReauthStepUp, mfaSecondFactorStepUp, secondFactorRequiredResponse } from "@/lib/mfa/step-up";
import { notifyMfaSecurityEvent } from "@/lib/mfa/notify";
import { webAuthnConfigFromEnv } from "@/lib/mfa/webauthn";
import { translatorForRequest } from "@/lib/i18n/server-locale";

// GET /api/profile/mfa — the caller's two-factor status (never any secret).
export const GET = withAuth(async (_req, _ctx, session) => {
  const user = await prisma.user.findUnique({
    where: { id: session.user.id },
    select: { passwordHash: true },
  });
  const available = session.user.provider === "credentials" && !!user?.passwordHash;
  const state = await getMfaState(session.user.id);
  return NextResponse.json({
    available,
    enabled: state.enabled,
    totpEnabled: state.totpEnabled,
    passkeys: state.passkeys.map((p) => ({
      id: p.id,
      name: p.name,
      transports: p.transports,
      backedUp: p.backedUp,
      createdAt: p.createdAt.toISOString(),
      lastUsedAt: p.lastUsedAt?.toISOString() ?? null,
    })),
    recoveryCodesRemaining: state.recoveryRemaining,
    webauthnAvailable: webAuthnConfigFromEnv() !== null,
  });
});

// DELETE /api/profile/mfa — turn two-factor OFF: removes the authenticator
// app, every passkey and every recovery code. Body: { password, secondFactor }
// — the second factor is required whenever a factor is active (step-up.ts).
// Signs out every OTHER session (the device doing this stays signed in).
export const DELETE = withAuth(async (req, _ctx, session) => {
  const t = translatorForRequest(req);
  const maint = await maintenanceGuard(session);
  if (maint) return maint;
  const parsed = await readJsonCappedOr<{ password?: unknown; secondFactor?: unknown }>(req, 64 * 1024, {});
  if (parsed instanceof NextResponse) return parsed;
  const user = await mfaReauthStepUp(session, parsed.password, t, req);
  if (user instanceof NextResponse) return user;
  const proof = await mfaSecondFactorStepUp(req, session, user, parsed.secondFactor);
  if (proof instanceof NextResponse) return proof;

  const before = proof.state;
  const outcome = await prisma.$transaction(async (tx) => {
    await lockUserMfaInTx(tx, user.id);
    // Password-only (nothing was active when the step-up ran) must not remove
    // a factor that became active after that read.
    if (!proof.proved) {
      // One at a time: a transaction is one connection (guardrail 23c).
      const totp = await tx.userTotp.findUnique({ where: { userId: user.id }, select: { enabledAt: true } });
      const passkeys = await tx.webAuthnCredential.count({ where: { userId: user.id } });
      if (totp?.enabledAt || passkeys > 0) return { blocked: true as const, revokedSessionIds: [] as string[] };
    }
    await deleteAllMfaInTx(tx, user.id);
    await clearMfaLockoutInTx(tx, user.id);
    // Signing out the OTHER sessions commits with the factor delete: a
    // separate transaction that failed would 500 a change that already turned
    // 2FA off and leave those sessions live on a password-only account.
    const revokedSessionIds = before.enabled ? await revokeOtherUserSessionsInTx(tx, user.id, session.sessionId) : [];
    return { blocked: false as const, revokedSessionIds };
  });
  if (outcome.blocked) return secondFactorRequiredResponse(t, await getMfaState(user.id));
  // Committed: only now mark the revoked sessions in memory (guardrail 27).
  for (const sessionId of outcome.revokedSessionIds) markSessionForceRevoked(sessionId);
  const revoked = outcome.revokedSessionIds.length;
  if (before.enabled) void notifyMfaSecurityEvent(user.id, "mfa-disabled");

  // Committed — a failed audit write must not 500 it (guardrail 26).
  void logAudit({
    userId: user.id,
    userName: user.name ?? user.email,
    action: "MFA_CHANGE",
    target: `user:${user.id}`,
    details: {
      kind: "mfa-disabled",
      before: { totp: before.totpEnabled, passkeys: before.passkeys.length, recoveryCodes: before.recoveryRemaining },
      otherSessionsRevoked: revoked,
    },
    ...auditContext(req, session),
  });
  return NextResponse.json({ ok: true });
});
