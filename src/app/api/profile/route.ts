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
import { translatorForRequest } from "@/lib/i18n/server-locale";
import { tooManyRequests } from "@/lib/http";

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
  const t = translatorForRequest(req);
  const maint = await maintenanceGuard(session);
  if (maint) return maint;
  const id = session.user.id;

  const target = await prisma.user.findUnique({
    where: { id },
    select: { role: true, name: true, email: true, deactivatedAt: true, passwordHash: true },
  });
  if (!target) return NextResponse.json({ error: t("apiAuth.common.notFound") }, { status: 404 });
  if (target.deactivatedAt) return NextResponse.json({ ok: true }); // idempotent

  // Step-up for local-credential accounts: this signs the user out everywhere and
  // only an admin can undo it, so require the current password in the body to
  // confirm it's the account owner and not a
  // ride-along on a hijacked/borrowed session. SSO-provisioned accounts have no
  // local passwordHash to verify against; the session itself is their proof.
  if (target.passwordHash !== null) {
    if (!checkRateLimit(`profile-delete:${id}`, 5, 15 * 60 * 1000)) {
      return tooManyRequests(15 * 60, t("apiAuth.common.tooManyAttemptsWait15"));
    }
    const parsed = await readJsonCappedOr<{ password?: unknown }>(req, 16384, {});
    if (parsed instanceof NextResponse) return parsed;
    const password = parsed.password;
    if (typeof password !== "string" || password.length === 0) {
      return NextResponse.json({ error: t("apiAuth.profile.passwordRequiredDelete") }, { status: 400 });
    }
    const ok = await verifyPassword(password, target.passwordHash);
    if (!ok) {
      return NextResponse.json({ error: t("apiAuth.common.invalidPassword") }, { status: 400 });
    }
  }

  const now = new Date();

  // The role read at the top of this handler is up to ~250 ms stale: verifyPassword
  // runs scrypt tuned to bcrypt cost 12. A promotion landing in that window would pass
  // the STALE "USER" here, and deactivateUserInTx only runs the last-admin CAS for an
  // admin — so the freshly-promoted last admin could delete themselves and leave the
  // instance with none. Re-read inside the transaction, where the CAS can see it.
  // The role this call actually disabled, or null when the in-tx re-read found the
  // row already gone/disabled (nothing was written by THIS request).
  let disabledRole: string | null;
  try {
    disabledRole = await prisma.$transaction(async (tx): Promise<string | null> => {
      const fresh = await tx.user.findUnique({ where: { id }, select: { role: true, deactivatedAt: true } });
      // Guardrail 33: re-running the deactivate on an already-disabled ADMIN excludes
      // its own row from the active-admin count and throws LastAdminError spuriously,
      // so callers must short-circuit. A concurrent admin-side removal lands here.
      if (!fresh || fresh.deactivatedAt) return null;
      await deactivateUserInTx(tx, id, fresh.role, now);
      return fresh.role;
    });
  } catch (err) {
    if (err instanceof LastAdminError) {
      return NextResponse.json(
        { error: t("apiAuth.profile.lastAdmin") },
        { status: 400 },
      );
    }
    throw err;
  }

  invalidateUserSession(id);

  // A concurrent removal (admin DELETE landing inside the verifyPassword window)
  // already disabled the row and wrote its own audit entry. This request changed
  // nothing, so it must not record a self-delete that never happened.
  if (disabledRole === null) return NextResponse.json({ ok: true });

  // Account already disabled; a failed audit write must not 500 a successful
  // destructive op (guardrail 26 — logAudit swallows write failures).
  void logAudit({
    userId: id,
    userName: target.name ?? target.email ?? "unknown",
    action: "USER_DEACTIVATE",
    target: `user:${id}`,
    details: { kind: "self-delete", before: { role: disabledRole } },
    ...auditContext(req, session),
  });

  return NextResponse.json({ ok: true });
});
