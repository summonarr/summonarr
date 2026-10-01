import { NextResponse } from "next/server";
import { withAuth } from "@/lib/api-auth";
import { maintenanceGuard } from "@/lib/maintenance";
import { readJsonCapped, readJsonCappedOr } from "@/lib/body-size";
import { prisma } from "@/lib/prisma";
import { logAudit, auditContext } from "@/lib/audit";
import { dropRecoveryCodesIfNoFactorInTx, sanitizePasskeyName } from "@/lib/mfa/mfa-store";
import { mfaPasswordStepUp } from "@/lib/mfa/step-up";

// PATCH /api/profile/mfa/passkeys/[id] — rename one of the caller's passkeys.
// Body: { password, name }.
export const PATCH = withAuth(async (
  req,
  { params }: { params: Promise<{ id: string }> },
  session,
) => {
  const maint = await maintenanceGuard(session);
  if (maint) return maint;
  const { id } = await params;
  const parsed = await readJsonCapped<{ password?: unknown; name?: unknown }>(req, 16384);
  if (parsed instanceof NextResponse) return parsed;
  if (typeof parsed.name !== "string" || parsed.name.trim().length === 0) {
    return NextResponse.json({ error: "A name is required" }, { status: 400 });
  }
  const user = await mfaPasswordStepUp(session, parsed.password);
  if (user instanceof NextResponse) return user;

  const name = sanitizePasskeyName(parsed.name);
  // Scoped to the caller: another user's credential id is simply "not found".
  const res = await prisma.webAuthnCredential.updateMany({ where: { id, userId: user.id }, data: { name } });
  if (res.count === 0) return NextResponse.json({ error: "Not found" }, { status: 404 });

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
// Body: { password }. If it was the last factor, the recovery codes go too.
export const DELETE = withAuth(async (
  req,
  { params }: { params: Promise<{ id: string }> },
  session,
) => {
  const maint = await maintenanceGuard(session);
  if (maint) return maint;
  const { id } = await params;
  const parsed = await readJsonCappedOr<{ password?: unknown }>(req, 16384, {});
  if (parsed instanceof NextResponse) return parsed;
  const user = await mfaPasswordStepUp(session, parsed.password);
  if (user instanceof NextResponse) return user;

  const removed = await prisma.$transaction(async (tx) => {
    const res = await tx.webAuthnCredential.deleteMany({ where: { id, userId: user.id } });
    if (res.count > 0) await dropRecoveryCodesIfNoFactorInTx(tx, user.id);
    return res.count;
  });
  if (removed === 0) return NextResponse.json({ error: "Not found" }, { status: 404 });

  void logAudit({
    userId: user.id,
    userName: user.name ?? user.email,
    action: "MFA_CHANGE",
    target: `user:${user.id}`,
    details: { kind: "passkey-removed", passkeyId: id },
    ...auditContext(req, session),
  });
  return NextResponse.json({ ok: true });
});
