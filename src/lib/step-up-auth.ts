import { NextResponse, type NextRequest } from "next/server";
import { prisma } from "@/lib/prisma";
import { verifyPassword, MAX_PASSWORD_LENGTH } from "@/lib/password-hash";
import { getClientIp, peekRateLimit, refundHit, reserveRateLimit } from "@/lib/rate-limit";
import { logAudit } from "@/lib/audit";
import { claimSignInLockoutNotice, notifyStepUpLockout } from "@/lib/account-security-notify";
import { parseBearerToken } from "@/lib/mobile-auth";
import type { SummonarrSession } from "@/lib/api-auth";
import { isIndefiniteDeadline, MAX_CONFIGURABLE_SESSION_SECONDS } from "@/lib/session-lifetime";
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
// spend the shared budget (a correct one refunds its own reserved hit), every
// failure is audited as AUTH_LOGIN_FAILED with reason "step_up_password", and
// the failure that fills the budget mails the owner once per window.
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
  // This miss spent the last of the budget, so the owner's own confirmations —
  // signing the guesser's device out, sign out everywhere, a password change —
  // are refused until it drains, and only a signed-in session can have spent it.
  // Tell them, ONCE per window however many attempts follow (the 6i sign-in
  // notice's shape). Raised here, never by a refusal, so a refused attempt reads
  // nothing more; the claim is synchronous and the mail detached, so the
  // caller's verdict and timing don't change.
  if (
    !peekRateLimit(key, STEP_UP_PASSWORD_LIMIT, STEP_UP_PASSWORD_WINDOW_MS) &&
    claimSignInLockoutNotice(key, STEP_UP_PASSWORD_WINDOW_MS)
  ) {
    void notifyStepUpLockout(opts.userId, STEP_UP_PASSWORD_WINDOW_MS);
  }
  return "invalid";
}

// A native-app (iOS) session, which the 6g routes the shipped app calls exempt
// from the step-up (it has no prompt for them). The kind is fixed at sign-in —
// never the header, which the client writes, and never the transport alone: a
// stolen browser cookie replayed as a bearer token is still a web session.
//   - The never-reached sentinel deadline, which only a sign-in presenting
//     X-Summonarr-Client is minted (guardrail 6c).
//   - A native sign-in from before 6c: a fixed 1-year deadline. Told apart by
//     its AuthSession row, whose createdAt and expiresAt are written once at
//     sign-in and never moved (a privilege rotation only renames the row), so
//     their span is the lifetime the session was granted, and a browser's is at
//     most MAX_CONFIGURABLE_SESSION_SECONDS. NEVER the token's iat: the proxy
//     re-signs every bearer request with iat = now, so in a token's last 90
//     days `deadline - iat` reads as a browser's. It must also have arrived as
//     a bearer, as the app's always do: v0.13.7 and v0.13.8 granted the same
//     1-year span to a mobile BROWSER that ticked "remember me", and such a
//     cookie must not pass as the app.
// No row (or no session id) is never native.
export async function isNativeSessionForStepUp(session: SummonarrSession, req: NextRequest): Promise<boolean> {
  const deadline = session.tokenExpiresAt;
  if (typeof deadline !== "number") return false;
  if (isIndefiniteDeadline(deadline)) return true;
  // The same bearer-first read authenticateRequest makes, so this is the
  // transport the session was verified on.
  if (!session.sessionId || parseBearerToken(req.headers.get("authorization")) === null) return false;
  const row = await prisma.authSession.findUnique({
    where: { sessionId: session.sessionId },
    select: { createdAt: true, expiresAt: true },
  });
  if (!row) return false;
  // NaN (an unreadable column) compares false: not native.
  return Number(row.expiresAt) - Number(row.createdAt) > MAX_CONFIGURABLE_SESSION_SECONDS * 1000;
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
