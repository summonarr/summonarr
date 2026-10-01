import { NextResponse } from "next/server";
import { withAuth } from "@/lib/api-auth";
import { maintenanceGuard } from "@/lib/maintenance";
import { readJsonCappedOr } from "@/lib/body-size";
import { prisma } from "@/lib/prisma";
import { logAudit, auditContext } from "@/lib/audit";
import { revokeOtherUserSessions } from "@/lib/auth";
import { deleteAllMfaInTx, getMfaState } from "@/lib/mfa/mfa-store";
import { mfaPasswordStepUp } from "@/lib/mfa/step-up";
import { webAuthnConfigFromEnv } from "@/lib/mfa/webauthn";

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
// app, every passkey and every recovery code. Password step-up; signs out every
// OTHER session (the device doing this stays signed in).
export const DELETE = withAuth(async (req, _ctx, session) => {
  const maint = await maintenanceGuard(session);
  if (maint) return maint;
  const parsed = await readJsonCappedOr<{ password?: unknown }>(req, 16384, {});
  if (parsed instanceof NextResponse) return parsed;
  const user = await mfaPasswordStepUp(session, parsed.password);
  if (user instanceof NextResponse) return user;

  const before = await getMfaState(user.id);
  await prisma.$transaction(async (tx) => {
    await deleteAllMfaInTx(tx, user.id);
  });
  const revoked = before.enabled ? await revokeOtherUserSessions(user.id, session.sessionId) : 0;

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
