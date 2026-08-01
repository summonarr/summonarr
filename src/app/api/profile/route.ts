import { NextResponse } from "next/server";
import { withAuth } from "@/lib/api-auth";
import { maintenanceGuard } from "@/lib/maintenance";
import { invalidateUserSession } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { logAudit, auditContext } from "@/lib/audit";
import { readJsonCappedOr } from "@/lib/body-size";
import { verifyPassword } from "@/lib/password-hash";
import { checkRateLimit } from "@/lib/rate-limit";
import { deactivateUserInTx, LastAdminError } from "@/lib/account-lifecycle";

// DELETE /api/profile — the signed-in user deletes their OWN account.
//
// DISABLES the account: every session is revoked and sign-in is refused for every
// provider, but nothing is scrubbed and nothing is cascade-deleted. Their
// requests / votes / issues stay attached and — the reason this is a disable
// rather than an anonymize — their MediaServerUser link stays intact, so watches
// they keep racking up on Plex/Jellyfin are still attributed to them. An admin
// can re-enable the account (POST /api/admin/users/[id]/reactivate).
//
// The irreversible PII scrub is a SEPARATE admin action
// (POST /api/admin/users/[id]/purge). App Store Review Guideline 5.1.1(v) expects
// an in-app deletion to actually remove the account's data, so a user who wants
// that must have an admin follow up with a purge — see account-lifecycle.ts.
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

  // The role read at the top of this handler is up to ~250 ms stale: verifyPassword
  // runs scrypt tuned to bcrypt cost 12. A promotion landing in that window would pass
  // the STALE "USER" here, and deactivateUserInTx only runs the last-admin CAS for an
  // admin — so the freshly-promoted last admin could delete themselves and leave the
  // instance with none. Re-read inside the transaction, where the CAS can see it.
  let disabledRole: string | null = null;
  try {
    await prisma.$transaction(async (tx) => {
      const fresh = await tx.user.findUnique({ where: { id }, select: { role: true, deactivatedAt: true } });
      // Guardrail 33: re-running the deactivate on an already-disabled ADMIN excludes
      // its own row from the active-admin count and throws LastAdminError spuriously,
      // so callers must short-circuit. A concurrent admin-side removal lands here.
      if (!fresh || fresh.deactivatedAt) return;
      await deactivateUserInTx(tx, id, fresh.role, now);
      disabledRole = fresh.role;
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

  // Account already disabled; a failed audit write must not 500 a successful
  // destructive op (guardrail 26 — logAudit swallows write failures).
  void logAudit({
    userId: id,
    userName: target.name ?? target.email ?? "unknown",
    action: "USER_DEACTIVATE",
    target: `user:${id}`,
    details: { kind: "self-delete", before: { role: disabledRole ?? target.role } },
    ...auditContext(req, session),
  });

  return NextResponse.json({ ok: true });
});
