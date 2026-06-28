import { NextResponse } from "next/server";
import { verifyPassword } from "@/lib/password-hash";
import { withAuth } from "@/lib/api-auth";
import { readJsonCapped } from "@/lib/body-size";
import { revokeSessionById } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { logAudit } from "@/lib/audit";
import { checkRateLimit, getClientIp } from "@/lib/rate-limit";

export const GET = withAuth(async (_req, _ctx, session) => {
  const sessions = await prisma.authSession.findMany({
    where: { userId: session.user.id },
    orderBy: { lastSeenAt: "desc" },
    select: {
      id:          true,
      sessionId:   true,
      deviceType:  true,
      deviceLabel: true,
      ipAddress:   true,
      createdAt:   true,
      lastSeenAt:  true,
      expiresAt:   true,
    },
  });

  const currentSessionId = session.sessionId;

  return NextResponse.json(
    sessions.map((s) => ({
      ...s,
      isCurrent: s.sessionId === currentSessionId,
    }))
  );
});

const STEP_UP_MAX_AGE_MS = 5 * 60 * 1000;

export const DELETE = withAuth(async (req, _ctx, session) => {
  // Per-user revoke rate cap (10 per minute). Bounds how fast a hijacked cookie or
  // a CSRF-replay attempt can iterate over a user's sessions, so an attacker can't
  // sweep every device off in a tight loop before the user notices or intervenes.
  if (!checkRateLimit(`sessions-delete:${session.user.id}`, 10, 60_000)) {
    return NextResponse.json(
      { error: "rate_limit", message: "Too many revoke attempts. Try again in a minute." },
      { status: 429 },
    );
  }

  const parsed = await readJsonCapped<{ sessionId?: string; confirmPassword?: string }>(req, 16384);
  if (parsed instanceof NextResponse) return parsed;
  const body = parsed;

  const { sessionId, confirmPassword } = body;
  if (!sessionId || typeof sessionId !== "string") {
    return NextResponse.json({ error: "sessionId required" }, { status: 400 });
  }

  const record = await prisma.authSession.findUnique({
    where: { sessionId },
    select: { userId: true, deviceLabel: true, sessionId: true },
  });

  if (!record || record.userId !== session.user.id) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }

  const isSelf = record.sessionId === session.sessionId;
  let steppedUp = false;

  if (!isSelf) {
    // Revoking a session OTHER than the caller's own is a high-value action: a
    // hijacked or CSRF-riding session could otherwise sign the legitimate user out
    // of all their devices (denial of service) or kick a victim off so the attacker
    // alone remains. Require a fresh proof of identity (step-up authentication)
    // before allowing it. Self-revocation (signing out the current device) is benign
    // and skips this. Local-credential users prove possession by re-entering their
    // password (bcrypt-verified below); SSO users have no local passwordHash, so we
    // instead require that the caller's own session was created within the last 5
    // minutes (STEP_UP_MAX_AGE_MS) — i.e. they recently completed a full IdP sign-in.
    const user = await prisma.user.findUnique({
      where: { id: session.user.id },
      select: { passwordHash: true },
    });

    if (!user) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    if (user.passwordHash) {
      if (!confirmPassword || typeof confirmPassword !== "string") {
        return NextResponse.json(
          { error: "password-required", message: "Confirm your password to revoke this device." },
          { status: 401 },
        );
      }
      const ok = await verifyPassword(confirmPassword, user.passwordHash);
      if (!ok) {
        return NextResponse.json({ error: "invalid-password" }, { status: 401 });
      }
      steppedUp = true;
    } else {
      // SSO path: with no local password to challenge, the step-up proof is
      // recency of the caller's own sign-in. Require a caller AuthSession that was
      // created within STEP_UP_MAX_AGE_MS, evidencing a recent full IdP login.
      const callerSessionId = session.sessionId;
      if (!callerSessionId) {
        return NextResponse.json(
          { error: "session-too-old", message: "Recent sign-in required to revoke other devices." },
          { status: 401 },
        );
      }
      const caller = await prisma.authSession.findUnique({
        where: { sessionId: callerSessionId },
        select: { createdAt: true },
      });
      if (!caller || Date.now() - caller.createdAt.getTime() > STEP_UP_MAX_AGE_MS) {
        return NextResponse.json(
          { error: "session-too-old", message: "Recent sign-in required to revoke other devices." },
          { status: 401 },
        );
      }
      steppedUp = true;
    }
  }

  try {
    await revokeSessionById(sessionId);
  } catch (err) {
    // revokeSessionById propagates its transaction failures rather than swallowing
    // them. If the revocation DB write didn't commit, the targeted session is still
    // live — so we must surface a 500 here and NOT fall through to writing an audit
    // log that falsely records a successful revoke. Failing loudly lets the caller
    // retry instead of trusting a revocation that never happened.
    console.error("[sessions] revoke failed:", err);
    return NextResponse.json({ error: "Failed to revoke session" }, { status: 500 });
  }

  void logAudit({
    userId:    session.user.id,
    userName:  session.user.name ?? session.user.email ?? "unknown",
    action:    "SESSION_REVOKE",
    target:    `session:${sessionId}`,
    ipAddress: getClientIp(req.headers),
    userAgent: req.headers.get("user-agent")?.slice(0, 512) ?? null,
    details:   {
      deviceLabel: record.deviceLabel,
      revokedByOwner: true,
      ...(isSelf ? {} : { steppedUp }),
    },
  });

  return NextResponse.json({ ok: true });
});
