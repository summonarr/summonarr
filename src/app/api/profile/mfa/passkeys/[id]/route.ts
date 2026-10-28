import { NextResponse } from "next/server";
import { withAuth } from "@/lib/api-auth";
import { maintenanceGuard } from "@/lib/maintenance";
import { readJsonCapped, readJsonCappedOr } from "@/lib/body-size";
import { prisma } from "@/lib/prisma";
import { logAudit, auditContext } from "@/lib/audit";
import { revokeOtherUserSessions } from "@/lib/auth";
import { dropRecoveryCodesIfNoFactorInTx, lockUserMfaInTx, sanitizePasskeyName } from "@/lib/mfa/mfa-store";
import { mfaReauthStepUp, mfaSecondFactorStepUp } from "@/lib/mfa/step-up";
import { notifyMfaSecurityEvent } from "@/lib/mfa/notify";
import { translatorForRequest } from "@/lib/i18n/server-locale";

// Scoped to the caller: another user's credential id is simply "not found".
// Checked BEFORE the second-factor step-up: a recovery code used as proof is
// consumed, so a stale or mistyped id must not cost one. The write below stays
// scoped and count-checked (a passkey removed in between is still a 404).
async function ownsPasskey(userId: string, id: string): Promise<boolean> {
  return (await prisma.webAuthnCredential.count({ where: { id, userId } })) > 0;
}

// PATCH /api/profile/mfa/passkeys/[id] — rename one of the caller's passkeys.
// Body: { password, secondFactor, name } — a passkey exists, so 2FA is on and
// the fresh second factor is always required (step-up.ts).
export const PATCH = withAuth(async (
  req,
  { params }: { params: Promise<{ id: string }> },
  session,
) => {
  const t = translatorForRequest(req);
  const maint = await maintenanceGuard(session);
  if (maint) return maint;
  const { id } = await params;
  const parsed = await readJsonCapped<{ password?: unknown; secondFactor?: unknown; name?: unknown }>(req, 64 * 1024);
  if (parsed instanceof NextResponse) return parsed;
  if (typeof parsed.name !== "string" || parsed.name.trim().length === 0) {
    return NextResponse.json({ error: t("apiAuth.mfa.nameRequired") }, { status: 400 });
  }
  const user = await mfaReauthStepUp(session, parsed.password, t, req);
  if (user instanceof NextResponse) return user;
  // Before the second factor, so a 404 never spends a recovery code.
  if (!(await ownsPasskey(user.id, id))) return NextResponse.json({ error: t("apiAuth.common.notFound") }, { status: 404 });
  const proof = await mfaSecondFactorStepUp(req, session, user, parsed.secondFactor);
  if (proof instanceof NextResponse) return proof;

  const name = sanitizePasskeyName(parsed.name);
  // Scoped to the caller: another user's credential id is simply "not found".
  const res = await prisma.webAuthnCredential.updateMany({ where: { id, userId: user.id }, data: { name } });
  if (res.count === 0) return NextResponse.json({ error: t("apiAuth.common.notFound") }, { status: 404 });

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
  const t = translatorForRequest(req);
  const maint = await maintenanceGuard(session);
  if (maint) return maint;
  const { id } = await params;
  const parsed = await readJsonCappedOr<{ password?: unknown; secondFactor?: unknown }>(req, 64 * 1024, {});
  if (parsed instanceof NextResponse) return parsed;
  const user = await mfaReauthStepUp(session, parsed.password, t, req);
  if (user instanceof NextResponse) return user;
  // Before the second factor, so a 404 never spends a recovery code.
  if (!(await ownsPasskey(user.id, id))) return NextResponse.json({ error: t("apiAuth.common.notFound") }, { status: 404 });
  const proof = await mfaSecondFactorStepUp(req, session, user, parsed.secondFactor);
  if (proof instanceof NextResponse) return proof;

  const outcome = await prisma.$transaction(async (tx) => {
    // Same lock as every other enrollment write (guardrail 6d: recovery-code
    // writes serialize per user). Without it, this delete's "no factor left,
    // drop the codes" could interleave with a concurrent totp/enable that read
    // the still-committed passkey as "not the first factor" and so showed no
    // codes — leaving TOTP active with zero recovery codes.
    await lockUserMfaInTx(tx, user.id);
    const res = await tx.webAuthnCredential.deleteMany({ where: { id, userId: user.id } });
    const noneLeft = res.count > 0 ? await dropRecoveryCodesIfNoFactorInTx(tx, user.id) : false;
    return { removed: res.count, noneLeft };
  });
  if (outcome.removed === 0) return NextResponse.json({ error: t("apiAuth.common.notFound") }, { status: 404 });

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
