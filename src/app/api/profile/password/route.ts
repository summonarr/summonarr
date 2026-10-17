import { NextResponse } from "next/server";
import { withAuth } from "@/lib/api-auth";
import { maintenanceGuard } from "@/lib/maintenance";
import { readJsonCapped } from "@/lib/body-size";
import { prisma } from "@/lib/prisma";
import { checkRateLimit } from "@/lib/rate-limit";
import { logAudit, auditContext } from "@/lib/audit";
import { footholdDeletes } from "@/lib/session-footholds";
import { notifyAccountSecurityEvent } from "@/lib/account-security-notify";
import { invalidateUserSession } from "@/lib/auth";
import { hashPassword, MAX_PASSWORD_LENGTH } from "@/lib/password-hash";
import { verifyStepUpPassword } from "@/lib/step-up-auth";
import { translatorForRequest } from "@/lib/i18n/server-locale";
import { tooManyRequests } from "@/lib/http";

// PATCH /api/profile/password — the signed-in user changes their own local
// password; revokes all existing sessions on success.
export const PATCH = withAuth(async (req, _ctx, session) => {
  const t = translatorForRequest(req);
  const maint = await maintenanceGuard(session);
  if (maint) return maint;
  if (!checkRateLimit(`profile-password:${session.user.id}`, 5, 15 * 60 * 1000)) {
    return tooManyRequests(15 * 60, t("apiAuth.common.tooManyAttemptsWait15"));
  }

  const parsed = await readJsonCapped<{ currentPassword?: string; newPassword?: string }>(req, 16384);
  if (parsed instanceof NextResponse) return parsed;
  const body = parsed;

  const { currentPassword, newPassword } = body;

  if (!newPassword || typeof newPassword !== "string") {
    return NextResponse.json({ error: t("apiAuth.profile.newPasswordRequired") }, { status: 400 });
  }

  if (newPassword.length < 12) {
    return NextResponse.json({ error: t("apiAuth.profile.newPasswordTooShort") }, { status: 400 });
  }

  if (newPassword.length > MAX_PASSWORD_LENGTH) {
    return NextResponse.json({ error: t("apiAuth.profile.newPasswordTooLong", { max: MAX_PASSWORD_LENGTH }) }, { status: 400 });
  }

  const user = await prisma.user.findUnique({
    where: { id: session.user.id },
    select: { passwordHash: true, name: true, email: true },
  });

  if (!user) return NextResponse.json({ error: t("apiAuth.common.unauthorized") }, { status: 401 });

  // SSO-provisioned accounts (Plex, Jellyfin, OIDC) authenticate against their
  // upstream identity provider and never have a local passwordHash. Allowing a
  // password to be set on such an account would create a "shadow" local credential
  // that bypasses the IdP entirely: anyone knowing that password could sign in via
  // the local-credentials provider without ever proving control of the SSO identity,
  // defeating provider-side controls (MFA, account disable, password rotation).
  // Hard-refuse the operation for any account with no existing passwordHash.
  if (user.passwordHash === null) {
    return NextResponse.json(
      { error: t("apiAuth.profile.ssoNoPassword") },
      { status: 403 },
    );
  }

  if (currentPassword !== undefined && typeof currentPassword !== "string") {
    // A non-string currentPassword would reach bcrypt and throw an opaque
    // TypeError; reject it explicitly (mirrors the newPassword guard above).
    return NextResponse.json({ error: t("apiAuth.profile.invalidRequest") }, { status: 400 });
  }
  // The current password is a step-up proof like any other: it draws on the
  // shared per-account guess budget and a miss is audited (step-up-auth.ts).
  const verdict = await verifyStepUpPassword({
    userId: session.user.id,
    userName: user.name ?? user.email,
    passwordHash: user.passwordHash,
    password: currentPassword ?? "",
    context: "password-change",
    req,
  });
  if (verdict === "rate-limited") return tooManyRequests(15 * 60, t("apiAuth.common.tooManyAttemptsWait15"));
  if (verdict === "invalid") {
    return NextResponse.json({ error: t("apiAuth.common.invalidPassword") }, { status: 400 });
  }

  const newHash = await hashPassword(newPassword);
  const now = new Date();

  await prisma.$transaction([
    // Stamp passwordChangedAt + sessionsRevokedAt so that any still-valid session
    // JWT issued before this change is invalidated everywhere: the session-refresh
    // path (session-refresh.ts) treats a token whose issue time predates these cutoffs as
    // revoked, so the change takes effect across all replicas without needing
    // server-local session state. The deleteMany below removes the per-device
    // AuthSession rows; the cutoffs are the DB-checked backstop for any JWT that
    // hasn't yet hit a refresh.
    prisma.user.update({
      where: { id: session.user.id },
      data: {
        passwordHash: newHash,
        passwordChangedAt: now,
        sessionsRevokedAt: now,
        // The calendar feed URL is a bearer credential like a session; a
        // password change (the usual compromise response) revokes it too.
        calendarTokenHash: null,
        calendarTokenCreatedAt: null,
      },
    }),
    prisma.authSession.deleteMany({
      where: { userId: session.user.id },
    }),
    // Anything a session holder could have planted that would outlive the
    // sessions (guardrail 6g): push registrations and pending Discord links.
    ...footholdDeletes(prisma, session.user.id),
  ]);

  invalidateUserSession(session.user.id);
  // Best-effort owner email, listing what is still connected (a Discord link, a
  // Trakt connection) — the password change is the usual compromise response.
  void notifyAccountSecurityEvent(session.user.id, "password-changed");

  void logAudit({
    userId: session.user.id,
    userName: user.name ?? user.email ?? "unknown",
    action: "SETTINGS_CHANGE",
    target: `user:${session.user.id}`,
    details: { kind: "password-change" },
    ...auditContext(req, session),
  });

  return NextResponse.json({ ok: true, requiresRelogin: true });
});
