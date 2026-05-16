import { NextResponse } from "next/server";
import { withAuth } from "@/lib/api-auth";
import { prisma } from "@/lib/prisma";
import { checkRateLimit } from "@/lib/rate-limit";
import { logAudit } from "@/lib/audit";
import bcrypt from "bcryptjs";

export const PATCH = withAuth(async (req, _ctx, session) => {
  if (!checkRateLimit(`profile-password:${session.user.id}`, 5, 15 * 60 * 1000)) {
    return NextResponse.json(
      { error: "Too many attempts — please wait 15 minutes before trying again." },
      { status: 429 },
    );
  }

  let body: { currentPassword?: string; newPassword?: string };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  const { currentPassword, newPassword } = body;

  if (!newPassword || typeof newPassword !== "string") {
    return NextResponse.json({ error: "New password is required" }, { status: 400 });
  }

  if (newPassword.length < 8) {
    return NextResponse.json({ error: "New password must be at least 8 characters" }, { status: 400 });
  }

  if (newPassword.length > 1024) {
    return NextResponse.json({ error: "New password must be at most 1024 characters" }, { status: 400 });
  }

  const user = await prisma.user.findUnique({
    where: { id: session.user.id },
    select: { passwordHash: true, name: true, email: true },
  });

  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  // C-3: SSO accounts have no passwordHash. Hard-refuse password set so a
  // shadow local password can't be created and used to bypass the IdP.
  if (user.passwordHash === null) {
    return NextResponse.json(
      { error: "Local passwords are not available for SSO accounts. Sign in with your provider." },
      { status: 403 },
    );
  }

  const currentOk = await bcrypt.compare(currentPassword ?? "", user.passwordHash);
  if (!currentOk) {
    return NextResponse.json({ error: "Invalid password" }, { status: 400 });
  }

  const newHash = await bcrypt.hash(newPassword, 12);
  const now = new Date();

  await prisma.$transaction([
    // passwordChangedAt + sessionsRevokedAt: cross-replica JWT invalidation via auth.ts refreshToken()
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
