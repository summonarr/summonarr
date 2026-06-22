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
  // Per-user cap: cookie/CSRF-replay attempts can't sweep all devices in a tight loop
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
    // H-9: revoking *other* devices is high-value and protected by step-up.
    // Local users prove possession with bcrypt; SSO users (no passwordHash)
    // must have signed in within the last 5 minutes.
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
      // SSO path: require a recently created caller AuthSession
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
    // revokeSessionById no longer swallows tx failures — surface a 500 rather
    // than auditing a revocation that may not have committed (the row could
    // still be live).
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
