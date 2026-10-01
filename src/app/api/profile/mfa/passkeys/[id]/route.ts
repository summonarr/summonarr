import { NextResponse } from "next/server";
import { withAuth } from "@/lib/api-auth";
import { maintenanceGuard } from "@/lib/maintenance";
import { readJsonCapped, readJsonCappedOr } from "@/lib/body-size";
import { prisma } from "@/lib/prisma";
import { logAudit, auditContext } from "@/lib/audit";
import { revokeOtherUserSessions } from "@/lib/auth";
import { dropRecoveryCodesIfNoFactorInTx, sanitizePasskeyName } from "@/lib/mfa/mfa-store";
import { mfaPasswordStepUp, mfaSecondFactorStepUp } from "@/lib/mfa/step-up";
import { notifyMfaSecurityEvent } from "@/lib/mfa/notify";

// PATCH /api/profile/mfa/passkeys/[id] — rename one of the caller's passkeys.
// Body: { password, secondFactor, name } — a passkey exists, so 2FA is on and
// the fresh second factor is always required (step-up.ts).
export const PATCH = withAuth(async (
  req,
  { params }: { params: Promise<{ id: string }> },
  session,
) => {
  const maint = await maintenanceGuard(session);
  if (maint) return maint;
  const { id } = await params;
  const parsed = await readJsonCapped<{ password?: unknown; secondFactor?: unknown; name?: unknown }>(req, 64 * 1024);
  if (parsed instanceof NextResponse) return parsed;
  if (typeof parsed.name !== "string" || parsed.name.trim().length === 0) {
    return NextResponse.json({ error: "A name is required" }, { status: 400 });
  }
  const user = await mfaPasswordStepUp(session, parsed.password);
  if (user instanceof NextResponse) return user;
  const proof = await mfaSecondFactorStepUp(req, session, user, parsed.secondFactor);
  if (proof instanceof NextResponse) return proof;

  const name = sanitizePasskeyName(parsed.name);
  // Scoped to the caller: another user's credential id is simply "not found".
  const res = await prisma.webAuthnCredential.updateMany({ where: { id, userId: user.id }, data: { name } });
  if (res.count === 0) return NextResponse.json({ error: "Not found" }, { status: 404 });

  void notifyMfaSecurityEvent(user.id, "passkey-renamed");
  void logAudit({
    userId: user.id,
    userName: user.name ?? user.email,
    action: "MFA_CHANGE",
    target: `user:${user.id}`,
    details: { kind: "passkey-renamed", passkeyId: id, name },
    ...auditContext(req, session),
  });
  return NextResponse.json({ ok: true });
});

// DELETE /api/profile/mfa/passkeys/[id] — remove one of the caller's passkeys.
// Body: { password, secondFactor } (step-up.ts — 2FA is on while a passkey
// exists). If it was the last factor, the recovery codes go too and every OTHER
// session is signed out, the same as turning 2FA off outright.
export const DELETE = withAuth(async (
  req,
  { params }: { params: Promise<{ id: string }> },
  session,
) => {
  const maint = await maintenanceGuard(session);
  if (maint) return maint;
  const { id } = await params;
  const parsed = await readJsonCappedOr<{ password?: unknown; secondFactor?: unknown }>(req, 64 * 1024, {});
  if (parsed instanceof NextResponse) return parsed;
  const user = await mfaPasswordStepUp(session, parsed.password);
  if (user instanceof NextResponse) return user;
  const proof = await mfaSecondFactorStepUp(req, session, user, parsed.secondFactor);
  if (proof instanceof NextResponse) return proof;

  const outcome = await prisma.$transaction(async (tx) => {
    const res = await tx.webAuthnCredential.deleteMany({ where: { id, userId: user.id } });
    const noneLeft = res.count > 0 ? await dropRecoveryCodesIfNoFactorInTx(tx, user.id) : false;
    return { removed: res.count, noneLeft };
  });
  if (outcome.removed === 0) return NextResponse.json({ error: "Not found" }, { status: 404 });

  const revoked = outcome.noneLeft ? await revokeOtherUserSessions(user.id, session.sessionId) : 0;
  void notifyMfaSecurityEvent(user.id, "passkey-removed");
  void logAudit({
    userId: user.id,
    userName: user.name ?? user.email,
    action: "MFA_CHANGE",
    target: `user:${user.id}`,
    details: { kind: "passkey-removed", passkeyId: id, lastFactor: outcome.noneLeft, otherSessionsRevoked: revoked },
    ...auditContext(req, session),
  });
  return NextResponse.json({ ok: true });
});
