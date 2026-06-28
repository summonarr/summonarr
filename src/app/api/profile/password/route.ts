import { NextResponse } from "next/server";
import { withAuth } from "@/lib/api-auth";
import { readJsonCapped } from "@/lib/body-size";
import { prisma } from "@/lib/prisma";
import { checkRateLimit } from "@/lib/rate-limit";
import { logAudit } from "@/lib/audit";
import { hashPassword, verifyPassword, MAX_PASSWORD_LENGTH } from "@/lib/password-hash";

export const PATCH = withAuth(async (req, _ctx, session) => {
  if (!checkRateLimit(`profile-password:${session.user.id}`, 5, 15 * 60 * 1000)) {
    return NextResponse.json(
      { error: "Too many attempts — please wait 15 minutes before trying again." },
      { status: 429 },
    );
  }

  const parsed = await readJsonCapped<{ currentPassword?: string; newPassword?: string }>(req, 16384);
  if (parsed instanceof NextResponse) return parsed;
  const body = parsed;

  const { currentPassword, newPassword } = body;

  if (!newPassword || typeof newPassword !== "string") {
    return NextResponse.json({ error: "New password is required" }, { status: 400 });
  }

  if (newPassword.length < 12) {
    return NextResponse.json({ error: "New password must be at least 12 characters" }, { status: 400 });
  }

  if (newPassword.length > MAX_PASSWORD_LENGTH) {
    return NextResponse.json({ error: `New password must be at most ${MAX_PASSWORD_LENGTH} characters` }, { status: 400 });
  }

  const user = await prisma.user.findUnique({
    where: { id: session.user.id },
    select: { passwordHash: true, name: true, email: true },
  });

  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  // SSO-provisioned accounts (Plex, Jellyfin, OIDC) authenticate against their
  // upstream identity provider and never have a local passwordHash. Allowing a
  // password to be set on such an account would create a "shadow" local credential
  // that bypasses the IdP entirely: anyone knowing that password could sign in via
  // the local-credentials provider without ever proving control of the SSO identity,
  // defeating provider-side controls (MFA, account disable, password rotation).
  // Hard-refuse the operation for any account with no existing passwordHash.
  if (user.passwordHash === null) {
    return NextResponse.json(
      { error: "Local passwords are not available for SSO accounts. Sign in with your provider." },
      { status: 403 },
    );
  }

  if (currentPassword !== undefined && typeof currentPassword !== "string") {
    // A non-string currentPassword would reach bcrypt and throw an opaque
    // TypeError; reject it explicitly (mirrors the newPassword guard above).
    return NextResponse.json({ error: "Invalid request" }, { status: 400 });
  }
  const currentOk = await verifyPassword(currentPassword ?? "", user.passwordHash);
  if (!currentOk) {
    return NextResponse.json({ error: "Invalid password" }, { status: 400 });
  }

  const newHash = await hashPassword(newPassword);
  const now = new Date();

  await prisma.$transaction([
    // Stamp passwordChangedAt + sessionsRevokedAt so that any still-valid session
    // JWT issued before this change is invalidated everywhere: the session-refresh
    // path (auth.ts) treats a token whose issue time predates these cutoffs as
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
      },
    }),
    prisma.authSession.deleteMany({
      where: { userId: session.user.id },
    }),
  ]);

  void logAudit({
    userId: session.user.id,
    userName: user.name ?? user.email ?? "unknown",
    action: "SETTINGS_CHANGE",
    target: `user:${session.user.id}`,
    details: { kind: "password-change" },
  });

  return NextResponse.json({ ok: true, requiresRelogin: true });
});
