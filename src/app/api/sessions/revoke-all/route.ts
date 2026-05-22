import { NextResponse } from "next/server";
import { verifyPassword } from "@/lib/password-hash";
import { withAuth } from "@/lib/api-auth";
import { prisma } from "@/lib/prisma";
import { logAudit } from "@/lib/audit";
import { checkRateLimit, getClientIp } from "@/lib/rate-limit";

const STEP_UP_MAX_AGE_MS = 5 * 60 * 1000;

// One-shot "sign out everywhere" endpoint. Two modes via the includeCurrent body flag:
//
//   includeCurrent=false (default): revoke every other AuthSession row, keep the caller
//     signed in. The caller's JWT continues to work; up to ~60s replica lag exists for
//     any stolen JWT replayed elsewhere (acceptable for "kill my old laptop" UX).
//
//   includeCurrent=true: bump User.sessionsRevokedAt — refreshToken() rejects every
//     JWT minted before this timestamp on every replica, so the caller is also signed
//     out. Use this when you suspect compromise.
//
// Step-up auth mirrors DELETE /api/sessions: credentials users prove with
// confirmPassword, SSO users must hold a session younger than 5 minutes.

export const POST = withAuth(async (req, _ctx, session) => {
  if (!checkRateLimit(`sessions-revoke-all:${session.user.id}`, 5, 60 * 60_000)) {
    return NextResponse.json(
      { error: "rate_limit", message: "Too many revoke-all attempts. Try again later." },
      { status: 429 },
    );
  }

  let body: { confirmPassword?: string; includeCurrent?: boolean } = {};
  try {
    body = (await req.json()) ?? {};
  } catch {
    body = {};
  }
  const confirmPassword = typeof body.confirmPassword === "string" ? body.confirmPassword : undefined;
  const includeCurrent = body.includeCurrent === true;

  const user = await prisma.user.findUnique({
    where: { id: session.user.id },
    select: { passwordHash: true },
  });
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  if (user.passwordHash) {
    if (!confirmPassword) {
      return NextResponse.json(
        { error: "password-required", message: "Confirm your password to sign out other devices." },
        { status: 401 },
      );
    }
    const ok = await verifyPassword(confirmPassword, user.passwordHash);
    if (!ok) return NextResponse.json({ error: "invalid-password" }, { status: 401 });
  } else {
    const callerSessionId = session.sessionId;
    if (!callerSessionId) {
      return NextResponse.json(
        { error: "session-too-old", message: "Recent sign-in required to sign out other devices." },
        { status: 401 },
      );
    }
    const caller = await prisma.authSession.findUnique({
      where: { sessionId: callerSessionId },
      select: { createdAt: true },
    });
    if (!caller || Date.now() - caller.createdAt.getTime() > STEP_UP_MAX_AGE_MS) {
      return NextResponse.json(
        { error: "session-too-old", message: "Recent sign-in required to sign out other devices." },
        { status: 401 },
      );
    }
  }

  let deletedCount = 0;
  if (includeCurrent) {
    // Replica-safe full revoke: bump sessionsRevokedAt then delete all rows.
    // refreshToken() in src/lib/auth.ts rejects any JWT with iat < this timestamp.
    await prisma.user.update({
      where: { id: session.user.id },
      data: { sessionsRevokedAt: new Date() },
    });
    const result = await prisma.authSession.deleteMany({ where: { userId: session.user.id } });
    deletedCount = result.count;
  } else {
    const result = await prisma.authSession.deleteMany({
      where: {
        userId: session.user.id,
        ...(session.sessionId ? { NOT: { sessionId: session.sessionId } } : {}),
      },
    });
    deletedCount = result.count;
  }

  void logAudit({
    userId: session.user.id,
    userName: session.user.name ?? session.user.email ?? "unknown",
    action: "SESSION_REVOKE",
    target: `user:${session.user.id}`,
    ipAddress: getClientIp(req.headers),
    userAgent: req.headers.get("user-agent")?.slice(0, 512) ?? null,
    details: {
      kind: includeCurrent ? "revoke-all" : "revoke-others",
      count: deletedCount,
      steppedUp: true,
    },
  });

  return NextResponse.json({ ok: true, count: deletedCount, includeCurrent });
});
