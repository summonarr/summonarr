import "server-only";

// Password step-up shared by every two-factor ENROLLMENT change under
// /api/profile/mfa — the same shape as the existing step-ups on password change
// (PATCH /api/profile/password) and self-delete (DELETE /api/profile): a
// per-user throttle, then the account's current password in the body.
//
// A hijacked or borrowed session therefore can't add its own authenticator to
// the account, strip the owner's, or read out fresh recovery codes.
//
// Two-factor is offered ONLY to local-credentials accounts: Plex / Jellyfin /
// OIDC users authenticate at their provider, which owns MFA there, and a local
// password-less account has nothing for a second factor to sit behind.

import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { checkRateLimit, getClientIp } from "@/lib/rate-limit";
import { verifyPassword, MAX_PASSWORD_LENGTH } from "@/lib/password-hash";
import type { SummonarrSession } from "@/lib/api-auth";
import { translatorForRequest } from "@/lib/i18n/server-locale";
import type { Translator } from "@/lib/i18n/translate";
import { getMfaState, type MfaState, type SecondFactorInput } from "./mfa-store";
import { verifySecondFactorGuarded } from "./lockout";
import { commitToken, releaseToken, reserveToken, verifyMfaStepUpToken } from "./mfa-token";
import { webAuthnConfigFromEnv, type AuthenticationResponseJSON } from "./webauthn";

// English text of apiAuth.mfa.unavailable.
export const MFA_UNAVAILABLE_MESSAGE =
  "Two-factor authentication is available only for accounts that sign in with a password.";

export interface StepUpUser {
  id: string;
  name: string | null;
  email: string;
}

// The non-password half: is this session's account eligible at all?
export async function mfaEligibleUser(session: SummonarrSession, t: Translator): Promise<StepUpUser | NextResponse> {
  const user = await prisma.user.findUnique({
    where: { id: session.user.id },
    select: { id: true, name: true, email: true, passwordHash: true },
  });
  if (!user) return NextResponse.json({ error: t("apiAuth.common.unauthorized") }, { status: 401 });
  if (session.user.provider !== "credentials" || !user.passwordHash) {
    return NextResponse.json({ error: t("apiAuth.mfa.unavailable") }, { status: 403 });
  }
  return { id: user.id, name: user.name, email: user.email };
}

export async function mfaReauthStepUp(
  session: SummonarrSession,
  password: unknown,
  t: Translator,
): Promise<StepUpUser | NextResponse> {
  if (!checkRateLimit(`mfa-stepup:${session.user.id}`, 10, 15 * 60 * 1000)) {
    return NextResponse.json(
      { error: t("apiAuth.common.tooManyAttemptsWait15") },
      { status: 429 },
    );
  }
  const user = await prisma.user.findUnique({
    where: { id: session.user.id },
    select: { id: true, name: true, email: true, passwordHash: true },
  });
  if (!user) return NextResponse.json({ error: t("apiAuth.common.unauthorized") }, { status: 401 });
  if (session.user.provider !== "credentials" || !user.passwordHash) {
    return NextResponse.json({ error: t("apiAuth.mfa.unavailable") }, { status: 403 });
  }
  if (typeof password !== "string" || password.length === 0) {
    return NextResponse.json({ error: t("apiAuth.mfa.currentPasswordRequired") }, { status: 400 });
  }
  if (password.length > MAX_PASSWORD_LENGTH) {
    return NextResponse.json({ error: t("apiAuth.common.invalidPassword") }, { status: 400 });
  }
  if (!(await verifyPassword(password, user.passwordHash))) {
    return NextResponse.json({ error: t("apiAuth.common.invalidPassword") }, { status: 400 });
  }
  return { id: user.id, name: user.name, email: user.email };
}

// ─── second-factor step-up ──────────────────────────────────────────────────
//
// The password alone is NOT enough to change the enrollment of an account that
// already has 2FA. A session obtained by relaying the password and one TOTP
// code through a phishing proxy would otherwise turn a one-time relay into
// durable access: regenerate recovery codes, add its own passkey, or switch 2FA
// off. So once a factor is active, every enrollment change also needs a FRESH
// second factor — a current TOTP code, an unused recovery code (consumed), or a
// passkey assertion over a single-use challenge from POST /api/profile/mfa/challenge.
// The very first factor stays password-only: there is nothing to prove yet.
//
// The verifiers are the sign-in ones (replay-safe CAS writes), wrapped in the
// same persistent lockout (lockout.ts), so a guess here spends the same budget
// as a guess at sign-in.
//
// Body field: `secondFactor`
//   { method: "totp" | "recovery", code }
//   { method: "webauthn", credential: <assertion JSON>, challengeToken }

// English text of apiAuth.mfa.secondFactorRequired.
export const SECOND_FACTOR_REQUIRED_MESSAGE =
  "Confirm this change with a code from your authenticator app, a recovery code or a passkey.";

export interface SecondFactorProof {
  // True when a factor was verified; false when the account had none to prove.
  proved: boolean;
  state: MfaState;
}

function parseStepUpFactor(raw: unknown): { input: SecondFactorInput; challengeToken?: unknown } | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const body = raw as Record<string, unknown>;
  if (body.method === "totp" || body.method === "recovery") {
    if (typeof body.code !== "string" || body.code.length === 0 || body.code.length > 64) return null;
    return { input: { method: body.method, code: body.code } };
  }
  if (body.method === "webauthn") {
    if (!body.credential || typeof body.credential !== "object" || Array.isArray(body.credential)) return null;
    return {
      input: { method: "webauthn", credential: body.credential as AuthenticationResponseJSON },
      challengeToken: body.challengeToken,
    };
  }
  return null;
}

function stepUpMethods(state: MfaState): string[] {
  const methods: string[] = [];
  if (state.totpEnabled) methods.push("totp");
  if (state.passkeys.length > 0 && webAuthnConfigFromEnv()) methods.push("webauthn");
  if (state.recoveryRemaining > 0) methods.push("recovery");
  return methods;
}

// Call AFTER mfaReauthStepUp succeeded. Returns the proof, or the response to
// send. `state` may be passed in when the route already read it.
export async function mfaSecondFactorStepUp(
  req: Request,
  session: SummonarrSession,
  user: StepUpUser,
  raw: unknown,
  state?: MfaState,
): Promise<SecondFactorProof | NextResponse> {
  const t = translatorForRequest(req);
  const current = state ?? (await getMfaState(user.id));
  if (!current.enabled) return { proved: false, state: current };

  const parsed = parseStepUpFactor(raw);
  if (!parsed) {
    return NextResponse.json(
      { error: t("apiAuth.mfa.secondFactorRequired"), secondFactorRequired: true, methods: stepUpMethods(current) },
      { status: 400 },
    );
  }

  let webauthnChallenge: string | undefined;
  let reservedJti: string | null = null;
  if (parsed.input.method === "webauthn") {
    const claims = await verifyMfaStepUpToken(parsed.challengeToken);
    if (
      !claims ||
      claims.userId !== user.id ||
      !session.sessionId ||
      claims.sessionId !== session.sessionId ||
      !reserveToken(claims.jti)
    ) {
      return NextResponse.json(
        { error: t("apiAuth.mfa.passkeyConfirmExpired"), secondFactorRequired: true },
        { status: 400 },
      );
    }
    webauthnChallenge = claims.challenge;
    reservedJti = claims.jti;
  }

  let verdict;
  try {
    verdict = await verifySecondFactorGuarded(user.id, parsed.input, {
      webauthnChallenge,
      webauthnConfig: webAuthnConfigFromEnv(),
      context: "enrollment",
      ipAddress: getClientIp(req.headers),
      userAgent: req.headers.get("user-agent")?.slice(0, 512) ?? null,
    });
  } catch (err) {
    if (reservedJti) releaseToken(reservedJti, { failed: false });
    throw err;
  }
  if (reservedJti) {
    // A step-up challenge is single-use either way: a failed assertion burns it.
    if (verdict.ok) commitToken(reservedJti);
    else releaseToken(reservedJti, { failed: true });
  }
  if (!verdict.ok) {
    if (verdict.locked) return NextResponse.json({ error: t("apiAuth.mfa.locked") }, { status: 429 });
    return NextResponse.json({ error: t("apiAuth.mfa.invalidCode"), secondFactorRequired: true }, { status: 400 });
  }
  return { proved: true, state: current };
}
