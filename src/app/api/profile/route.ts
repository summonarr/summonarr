import { NextResponse } from "next/server";
import { withAuth } from "@/lib/api-auth";
import { maintenanceGuard } from "@/lib/maintenance";
import { invalidateUserSession } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { logAudit, auditContext } from "@/lib/audit";
import { readJsonCappedOr } from "@/lib/body-size";
import { verifyPassword } from "@/lib/password-hash";
import { checkRateLimit } from "@/lib/rate-limit";

// Thrown inside the deactivation transaction to roll it back when the caller is
// the last active admin (guardrail 23: propagate out of the tx, don't swallow).
class LastAdminError extends Error {}

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
  // RFC-2606 reserved `.invalid` TLD — never routable, and `id` keeps it unique.
  const anon = {
    name: "Deleted user",
    email: `deleted-${id}@deleted.invalid`,
    emailVerified: null,
    image: null,
    passwordHash: null,
    discordId: null,
    notificationEmail: null,
    plexClientId: null,
    plexUserId: null,
    jellyfinUserId: null,
    deactivatedAt: now,
    sessionsRevokedAt: now, // pushes every existing JWT's iat below the cutoff
  };

  try {
    await prisma.$transaction(async (tx) => {
      if (target.role === "ADMIN") {
        // Never let the LAST active admin self-delete and lock the instance out of
        // administration. Advisory lock 42 + an atomic count of non-deactivated
        // admins mirrors the admin-delete CAS. A 0-row result throws to roll the
        // whole anonymization back.
        await tx.$executeRawUnsafe("SELECT pg_advisory_xact_lock(42)");
        const rows = await tx.$executeRaw`
          UPDATE "User" SET "deactivatedAt" = ${now}
          WHERE id = ${id} AND "deactivatedAt" IS NULL
          AND (SELECT COUNT(*) FROM "User" WHERE role = 'ADMIN' AND "deactivatedAt" IS NULL) > 1
        `;
        if (rows === 0) throw new LastAdminError();
      }
      // Remove provider tokens/subject (OAuth) + every device session, then
      // anonymize the row in place (keeps requests/votes/issues linked).
      await tx.account.deleteMany({ where: { userId: id } });
      await tx.authSession.deleteMany({ where: { userId: id } });
      await tx.session.deleteMany({ where: { userId: id } });
      // Orphaned device + Discord-link rows would otherwise outlive the anonymized
      // row and keep delivering pushes (to a possibly handed-down device) or leave
      // dangling unique link/merge rows. Remove them in the same transaction.
      await tx.pushSubscription.deleteMany({ where: { userId: id } });
      await tx.discordLinkToken.deleteMany({ where: { userId: id } });
      await tx.discordMergeCode.deleteMany({ where: { userId: id } });
      // Sever the play-history identity link: MediaServerUser FKs this user and isn't
      // cascade-deleted (guardrail 28). Leaving userId set would let a new account with
      // the same email/sub inherit this user's history, IPs, and devices. History rows
      // stay, just unattributed.
      await tx.mediaServerUser.updateMany({ where: { userId: id }, data: { userId: null } });
      await tx.user.update({ where: { id }, data: anon });
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
