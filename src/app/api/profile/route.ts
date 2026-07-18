import { NextResponse } from "next/server";
import { withAuth } from "@/lib/api-auth";
import { maintenanceGuard } from "@/lib/maintenance";
import { invalidateUserSession } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { logAudit, auditContext } from "@/lib/audit";
import { readJsonCappedOr } from "@/lib/body-size";
import { verifyPassword } from "@/lib/password-hash";
import { checkRateLimit } from "@/lib/rate-limit";
import { anonymizeUserInTx, LastAdminError } from "@/lib/anonymize-user";

// DELETE /api/profile — the signed-in user deletes their OWN account.
//
// Required by App Store Review Guideline 5.1.1(v). We satisfy it with
// ANONYMIZE + DISABLE rather than a hard row delete: the user's personal data is
// scrubbed (name / email / password / image / Discord / notification email +
// the Plex/Jellyfin provider-subject keys + their OAuth Account rows), every
// session is revoked, and the row is marked `deactivatedAt` so it can never sign
// in again — but their requests / votes / issues stay attached to the now
// de-identified "Deleted user" row so the instance keeps its history. A bare
// "disable" that retained personal data would NOT satisfy 5.1.1(v); the PII scrub
// is what makes this a deletion.
export const DELETE = withAuth(async (req, _ctx, session) => {
  const maint = await maintenanceGuard();
  if (maint) return maint;
  const id = session.user.id;

  const target = await prisma.user.findUnique({
    where: { id },
    select: { role: true, name: true, email: true, deactivatedAt: true, passwordHash: true },
  });
  if (!target) return NextResponse.json({ error: "Not found" }, { status: 404 });
  if (target.deactivatedAt) return NextResponse.json({ ok: true }); // idempotent

  // Step-up for local-credential accounts: deletion is irreversible, so require
  // the current password in the body to confirm it's the account owner and not a
  // ride-along on a hijacked/borrowed session. SSO-provisioned accounts have no
  // local passwordHash to verify against; the session itself is their proof.
  if (target.passwordHash !== null) {
    if (!checkRateLimit(`profile-delete:${id}`, 5, 15 * 60 * 1000)) {
      return NextResponse.json(
        { error: "Too many attempts — please wait 15 minutes before trying again." },
        { status: 429 },
      );
    }
    const parsed = await readJsonCappedOr<{ password?: unknown }>(req, 16384, {});
    if (parsed instanceof NextResponse) return parsed;
    const password = parsed.password;
    if (typeof password !== "string" || password.length === 0) {
      return NextResponse.json({ error: "Password is required to delete your account" }, { status: 400 });
    }
    const ok = await verifyPassword(password, target.passwordHash);
    if (!ok) {
      return NextResponse.json({ error: "Invalid password" }, { status: 400 });
    }
  }

  const now = new Date();

  try {
    await prisma.$transaction(async (tx) => {
      await anonymizeUserInTx(tx, id, target.role, now);
    });
  } catch (err) {
    if (err instanceof LastAdminError) {
      return NextResponse.json(
        { error: "You are the last admin. Promote another user to admin before deleting your account." },
        { status: 400 },
      );
    }
    throw err;
  }

  invalidateUserSession(id);

  // Account already anonymized; a failed audit write must not 500 a successful
  // destructive op (guardrail 26 — logAudit swallows write failures).
  void logAudit({
    userId: id,
    userName: target.name ?? target.email ?? "unknown",
    action: "USER_DELETE",
    target: `user:${id}`,
    details: { kind: "self-delete-anonymize", before: { role: target.role } },
    ...auditContext(req, session),
  });

  return NextResponse.json({ ok: true });
});
