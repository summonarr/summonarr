import { NextResponse, type NextRequest } from "next/server";
import { prisma } from "@/lib/prisma";
import { verifyPassword, MAX_PASSWORD_LENGTH } from "@/lib/password-hash";
import { getClientIp, refundHit, reserveRateLimit } from "@/lib/rate-limit";
import { logAudit } from "@/lib/audit";
import type { SummonarrSession } from "@/lib/api-auth";
import { isIndefiniteDeadline } from "@/lib/session-lifetime";
import type { Translator } from "@/lib/i18n/translate";

// Step-up authentication for actions a hijacked session must not be able to take
// on the owner's behalf (guardrails 6e, 6g).
//
// Every step-up PASSWORD check — signing out another device, sign out
// everywhere, deleting the account, changing the password, a two-factor
// enrollment change, linking Discord, connecting Trakt — goes through
// verifyStepUpPassword. Each route keeps its own rate limit, but they all also
// draw on ONE per-account budget of failed guesses. Before this, every route had
// its own bucket, so a stolen session could test passwords at ~11 a minute
// across them (about 16k a day, more than the sign-in limit allows) and no
// failure was ever audited.

export const STEP_UP_PASSWORD_LIMIT = 10;
export const STEP_UP_PASSWORD_WINDOW_MS = 15 * 60 * 1000;

// An SSO account has no local password to challenge, so its proof is the
// recency of its own sign-in: the caller's session must be this young.
export const STEP_UP_MAX_AGE_MS = 5 * 60 * 1000;

export type StepUpPasswordVerdict = "ok" | "invalid" | "rate-limited";

// Checks a step-up password against the account's hash. Only FAILED guesses
// spend the shared budget (a correct one refunds its own reserved hit), and
// every failure is audited as AUTH_LOGIN_FAILED with reason "step_up_password".
export async function verifyStepUpPassword(opts: {
  userId: string;
  userName: string | null | undefined;
  passwordHash: string;
  password: string;
  // What the step-up was for — recorded in the audit row.
  context: string;
  req: NextRequest;
}): Promise<StepUpPasswordVerdict> {
  // A PROTECTED rate-limit prefix (rate-limit.ts, guardrail 6e): never evicted
  // while it holds live hits, so a flood of other keys can't hand it back.
  const key = `step-up-pw:${opts.userId}`;
  const hitAt = reserveRateLimit(key, STEP_UP_PASSWORD_LIMIT, STEP_UP_PASSWORD_WINDOW_MS);
  if (hitAt === null) return "rate-limited";
  const ok =
    opts.password.length > 0 &&
    opts.password.length <= MAX_PASSWORD_LENGTH &&
    (await verifyPassword(opts.password, opts.passwordHash));
  if (ok) {
    refundHit(key, hitAt);
    return "ok";
  }
  void logAudit({
    userId: opts.userId,
    userName: opts.userName ?? "unknown",
    action: "AUTH_LOGIN_FAILED",
    target: "auth:step-up",
    ipAddress: getClientIp(opts.req.headers),
    userAgent: opts.req.headers.get("user-agent")?.slice(0, 512) ?? null,
    details: { reason: "step_up_password", context: opts.context },
  });
  return "invalid";
}

// A native-app (iOS) session: its deadline is the never-reached sentinel, which
// only a sign-in presenting X-Summonarr-Client is minted (guardrail 6c). The
// kind is fixed at sign-in and carried in the signed token, so — unlike the
// transport — a stolen browser cookie can't claim it.
export function isNativeSession(session: SummonarrSession): boolean {
  return typeof session.tokenExpiresAt === "number" && isIndefiniteDeadline(session.tokenExpiresAt);
}

export interface StepUpMessages {
  // Shown when a password account sent no password yet.
  passwordRequired: string;
  // Shown when an SSO account's session is older than STEP_UP_MAX_AGE_MS.
  recentSignInRequired: string;
}

// The full step-up gate used by DELETE /api/sessions, sign out everywhere,
// Discord linking and Trakt connecting: a password account re-enters its
// password; an SSO account must have signed in within STEP_UP_MAX_AGE_MS.
//
// Returns null when the caller passed, otherwise the response to send. The
// response shapes are a wire contract the web client (and the iOS app for the
// sessions routes) branches on:
//   401 { error: "password-required", message }
//   401 { error: "invalid-password" }
//   401 { error: "session-too-old", message }
//   429 { error: "rate_limit", message }
export async function requireStepUp(opts: {
  req: NextRequest;
  session: SummonarrSession;
  confirmPassword: unknown;
  context: string;
  messages: StepUpMessages;
  t: Translator;
}): Promise<NextResponse | null> {
  const { session, t } = opts;
  const user = await prisma.user.findUnique({
    where: { id: session.user.id },
    select: { passwordHash: true },
  });
  if (!user) return NextResponse.json({ error: t("apiAuth.common.unauthorized") }, { status: 401 });

  if (user.passwordHash) {
    if (typeof opts.confirmPassword !== "string" || opts.confirmPassword.length === 0) {
      return NextResponse.json(
        { error: "password-required", message: opts.messages.passwordRequired },
        { status: 401 },
      );
    }
    const verdict = await verifyStepUpPassword({
      userId: session.user.id,
      userName: session.user.name ?? session.user.email,
      passwordHash: user.passwordHash,
      password: opts.confirmPassword,
      context: opts.context,
      req: opts.req,
    });
    if (verdict === "rate-limited") {
      return NextResponse.json(
        { error: "rate_limit", message: t("apiAuth.common.tooManyAttemptsWait15") },
        { status: 429 },
      );
    }
    if (verdict === "invalid") return NextResponse.json({ error: "invalid-password" }, { status: 401 });
    return null;
  }

  // SSO: no local password to challenge, so the proof is a recent full sign-in
  // at the identity provider — the caller's own AuthSession must be young.
  const callerSessionId = session.sessionId;
  const caller = callerSessionId
    ? await prisma.authSession.findUnique({ where: { sessionId: callerSessionId }, select: { createdAt: true } })
    : null;
  if (!caller || Date.now() - caller.createdAt.getTime() > STEP_UP_MAX_AGE_MS) {
    return NextResponse.json(
      { error: "session-too-old", message: opts.messages.recentSignInRequired },
      { status: 401 },
    );
  }
  return null;
}
