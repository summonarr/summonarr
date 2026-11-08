import { NextResponse, type NextRequest } from "next/server";
import { withAuth, type SummonarrSession } from "@/lib/api-auth";
import { maintenanceGuard } from "@/lib/maintenance";
import { invalidateUserSession } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { logAudit, auditContext } from "@/lib/audit";
import { readJsonCappedOr } from "@/lib/body-size";
import { isNativeSessionForStepUp, requireStepUp, verifyStepUpPassword } from "@/lib/step-up-auth";
import { mfaSecondFactorStepUp } from "@/lib/mfa/step-up";
import { checkRateLimit } from "@/lib/rate-limit";
import { deactivateUserInTx, LastAdminError, lockUserRolesInTx } from "@/lib/account-lifecycle";
import { translatorForRequest } from "@/lib/i18n/server-locale";
import { tooManyRequests } from "@/lib/http";
import type { Translator } from "@/lib/i18n/translate";

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
//
// Body: { password, secondFactor? } for a local-password account. On one with an
// active second factor, a WEB session must also send `secondFactor` — the shape
// and the `400 { error, secondFactorRequired, methods }` answer of every other
// 2FA step-up (src/lib/mfa/step-up.ts). An account with no local password (Plex,
// Jellyfin, OIDC) has nothing to re-enter: a WEB session must have signed in
// within the last 5 minutes instead (401 { error: "session-too-old", message },
// the 6g step-up's answer).

type DeleteTarget = { name: string | null; email: string; passwordHash: string | null };

// Step-up for a local-credentials account: this signs the user out everywhere
// and only an admin can undo it, so the current password in the body confirms
// it's the account owner and not a ride-along on a hijacked or borrowed
// session. Null = passed.
async function passwordStepUp(
  req: NextRequest,
  session: SummonarrSession,
  target: DeleteTarget & { passwordHash: string },
  t: Translator,
): Promise<NextResponse | null> {
  const id = session.user.id;
  const parsed = await readJsonCappedOr<{ password?: unknown; secondFactor?: unknown }>(req, 16384, {});
  if (parsed instanceof NextResponse) return parsed;
  const password = parsed.password;
  if (typeof password !== "string" || password.length === 0) {
    return NextResponse.json({ error: t("apiAuth.profile.passwordRequiredDelete") }, { status: 400 });
  }
  const verdict = await verifyStepUpPassword({
    userId: id,
    userName: target.name ?? target.email,
    passwordHash: target.passwordHash,
    password,
    context: "account-delete",
    req,
  });
  if (verdict === "rate-limited") return tooManyRequests(15 * 60, t("apiAuth.common.tooManyAttemptsWait15"));
  if (verdict === "invalid") {
    return NextResponse.json({ error: t("apiAuth.common.invalidPassword") }, { status: 400 });
  }
  // The password alone is what a phishing relay or an autofilled, unlocked
  // browser holds, and only an admin can undo this. So an account with an
  // active second factor needs a fresh one too, checked after the password
  // so a wrong password never burns a code (guardrail 6d).
  //
  // A NATIVE session is exempt: the shipped iOS app's in-app deletion (an App
  // Store requirement) sends no `secondFactor` and has no prompt for one, so
  // this is a wire contract like 6g's native exemption. It leaves the relay
  // path open — a relay can choose a native sign-in — until the app shows its
  // StepUpSheet on `secondFactorRequired` here and the exemption is removed.
  if (await isNativeSessionForStepUp(session, req)) return null;
  const proof = await mfaSecondFactorStepUp(
    req,
    session,
    { id, name: target.name, email: target.email },
    parsed.secondFactor,
    undefined,
    { context: "account-delete" },
  );
  return proof instanceof NextResponse ? proof : null;
}

// Step-up for an account with no local password (Plex, Jellyfin, OIDC): the
// proof is a recent full sign-in, as on every other 6g step-up. A stale or
// stolen session must not be able to lock the owner out of their account.
// A NATIVE session is exempt, as above: the shipped iOS app's in-app deletion
// has no prompt, and its sign-in may be months old. Null = passed.
async function recentSignInStepUp(req: NextRequest, session: SummonarrSession, t: Translator): Promise<NextResponse | null> {
  if (await isNativeSessionForStepUp(session, req)) return null;
  return requireStepUp({
    req,
    session,
    confirmPassword: undefined,
    context: "account-delete",
    messages: {
      passwordRequired: t("apiAuth.profile.passwordRequiredDelete"),
      recentSignInRequired: t("apiAuth.stepUp.recentSignIn"),
    },
    t,
  });
}

// Disables the caller's own account and answers the role this call disabled,
// or null when the in-tx re-read found the row already gone/disabled (nothing
// was written by THIS request). Throws LastAdminError for the last admin.
//
// The role read before the step-up is up to ~250 ms stale: verifyPassword
// runs scrypt. A promotion landing in that window would pass the STALE "USER",
// and deactivateUserInTx only runs the last-admin CAS for an admin — so the
// freshly-promoted last admin could delete themselves and leave the instance
// with none. So the role is re-read inside the transaction, where the CAS can
// see it, and under lock 42 FIRST: a promotion or an admin-side disable holds
// that lock while it commits, so an unlocked read could still miss either one.
async function disableOwnAccount(id: string, now: Date): Promise<string | null> {
  return prisma.$transaction(async (tx): Promise<string | null> => {
    await lockUserRolesInTx(tx);
    const fresh = await tx.user.findUnique({ where: { id }, select: { role: true, deactivatedAt: true } });
    // Guardrail 33: re-running the deactivate on an already-disabled ADMIN excludes
    // its own row from the active-admin count and throws LastAdminError spuriously,
    // so callers must short-circuit. A concurrent admin-side removal lands here.
    if (!fresh || fresh.deactivatedAt) return null;
    await deactivateUserInTx(tx, id, fresh.role, now);
    return fresh.role;
  });
}

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

  // One budget for every account kind's attempts (a protected prefix — guardrail 6e).
  if (!checkRateLimit(`profile-delete:${id}`, 5, 15 * 60 * 1000)) {
    return tooManyRequests(15 * 60, t("apiAuth.common.tooManyAttemptsWait15"));
  }
  const passwordHash = target.passwordHash;
  const denied = passwordHash !== null
    ? await passwordStepUp(req, session, { ...target, passwordHash }, t)
    : await recentSignInStepUp(req, session, t);
  if (denied) return denied;

  let disabledRole: string | null;
  try {
    disabledRole = await disableOwnAccount(id, new Date());
  } catch (err) {
    if (err instanceof LastAdminError) {
      return NextResponse.json({ error: t("apiAuth.profile.lastAdmin") }, { status: 400 });
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
