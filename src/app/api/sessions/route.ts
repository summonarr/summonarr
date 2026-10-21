import { NextResponse } from "next/server";
import { requireStepUp } from "@/lib/step-up-auth";
import { withAuth } from "@/lib/api-auth";
import { readJsonCapped } from "@/lib/body-size";
import { revokeSessionById } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { logAudit } from "@/lib/audit";
import { checkRateLimit, getClientIp } from "@/lib/rate-limit";
import { isIndefiniteDeadline } from "@/lib/session-lifetime";
import { translatorForRequest } from "@/lib/i18n/server-locale";

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

  // `indefinite` is ADDITIVE (safe for the pinned iOS decoders — guardrail 6c):
  // it lets clients label a never-expiring native session without hardcoding
  // the sentinel date the raw expiresAt serializes to.
  return NextResponse.json(
    sessions.map((s) => ({
      ...s,
      isCurrent: s.sessionId === currentSessionId,
      indefinite: isIndefiniteDeadline(s.expiresAt),
    }))
  );
});

export const DELETE = withAuth(async (req, _ctx, session) => {
  const t = translatorForRequest(req);
  // Per-user revoke rate cap (10 per minute). Bounds how fast a hijacked cookie or
  // a CSRF-replay attempt can iterate over a user's sessions, so an attacker can't
  // sweep every device off in a tight loop before the user notices or intervenes.
  if (!checkRateLimit(`sessions-delete:${session.user.id}`, 10, 60_000)) {
    return NextResponse.json(
      { error: "rate_limit", message: t("apiAuth.sessions.revokeRateLimit") },
      { status: 429 },
    );
  }

  const parsed = await readJsonCapped<{ sessionId?: string; confirmPassword?: string }>(req, 16384);
  if (parsed instanceof NextResponse) return parsed;
  const body = parsed;

  const { sessionId, confirmPassword } = body;
  if (!sessionId || typeof sessionId !== "string") {
    return NextResponse.json({ error: t("apiAuth.sessions.sessionIdRequired") }, { status: 400 });
  }

  const record = await prisma.authSession.findUnique({
    where: { sessionId },
    select: { userId: true, deviceLabel: true, sessionId: true },
  });

  if (!record || record.userId !== session.user.id) {
    return NextResponse.json({ error: t("apiAuth.common.notFound") }, { status: 404 });
  }

  const isSelf = record.sessionId === session.sessionId;
  let steppedUp = false;

  if (!isSelf) {
    // Revoking a session OTHER than the caller's own is high-value: a hijacked or
    // CSRF-riding session could sign the user out everywhere or kick a victim off so
    // the attacker alone remains. Require step-up auth; self-revocation is benign and
    // skips it. Credential users re-enter their password; SSO users must have signed
    // in within STEP_UP_MAX_AGE_MS (step-up-auth.ts).
    const denied = await requireStepUp({
      req,
      session,
      confirmPassword,
      context: "session-revoke",
      messages: {
        passwordRequired: t("apiAuth.sessions.confirmPasswordRevoke"),
        recentSignInRequired: t("apiAuth.sessions.recentSignInRevoke"),
      },
      t,
    });
    if (denied) return denied;
    steppedUp = true;
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
    return NextResponse.json({ error: t("apiAuth.sessions.revokeFailed") }, { status: 500 });
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
