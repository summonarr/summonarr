import "server-only";

// The password step's branch for an account with two-factor enabled.
//
// Called by POST /api/auth/sign-in/credentials AFTER the password verified and
// BEFORE anything mints a session. When the account has an active second factor
// it returns the challenge response and the route returns it verbatim — no
// AuthSession row, no JWT, no Set-Cookie. When it returns null the route carries
// on exactly as it always has, so an account WITHOUT 2FA gets a byte-identical
// response to before this feature existed (the iOS app depends on that;
// tests/mfa-signin-routes.test.mts pins it with deepEqual).
//
// Wire contract (HTTP 401, Cache-Control: no-store):
//   {
//     error: "Two-factor authentication required",
//     mfaRequired: true,
//     methods: ("totp" | "webauthn" | "recovery")[],
//     mfaToken: "<opaque>",               // POST it to /api/auth/sign-in/mfa
//     expiresInSeconds: 300,
//     webauthn?: { challenge, rpId, allowCredentials: [{ type, id, transports }],
//                  userVerification: "preferred", timeout }
//   }
// 401 (not 200) on purpose: a client that predates 2FA treats it as a failed
// sign-in and shows `error`, instead of mistaking it for a success with no token.

import { randomBytes } from "node:crypto";
import { NextResponse, type NextRequest } from "next/server";
import { prisma } from "@/lib/prisma";
import { hasNativeClientHeader, NATIVE_CLIENT_HEADER } from "@/lib/mobile-auth";
import { disabledAccountResponse } from "@/lib/sign-in-response";
import { translatorForRequest } from "@/lib/i18n/server-locale";
import { logAudit } from "@/lib/audit";
import { getClientIp } from "@/lib/rate-limit";
import { getMfaState } from "./mfa-store";
import { MFA_TOKEN_TTL_SECONDS, signMfaSigninToken } from "./mfa-token";
import { webAuthnConfigFromEnv } from "./webauthn";

// English text of apiAuth.mfa.required.
export const MFA_REQUIRED_MESSAGE = "Two-factor authentication required";
export const WEBAUTHN_TIMEOUT_MS = MFA_TOKEN_TTL_SECONDS * 1000;

export type MfaMethod = "totp" | "webauthn" | "recovery";

// `passwordVersion` is the fingerprint of the hash the password step VERIFIED
// (authorizeWithCredentials' `_passwordVersion`), not of a re-read: a password
// change landing between the verify and this read would otherwise hand the old
// password a challenge fingerprinted with the NEW hash — one the change was
// supposed to kill. The MFA step compares it with the hash current then.
export async function mfaChallengeFor(
  req: NextRequest,
  user: { id: string; rememberMe?: string; passwordVersion: string },
): Promise<NextResponse | null> {
  // Errors propagate: a failed factor lookup must 500 (no session), never fall
  // through to the no-2FA branch and mint one.
  const state = await getMfaState(user.id);
  if (!state.enabled) return null;

  const row = await prisma.user.findUnique({
    where: { id: user.id },
    select: { passwordHash: true, deactivatedAt: true },
  });
  // Only the human-readable `error` text follows the request's language; every
  // other field of the challenge (mfaRequired, methods, mfaToken, …) is a wire
  // contract and stays as-is (guardrail 6d).
  const t = translatorForRequest(req);
  if (!row?.passwordHash) {
    return NextResponse.json({ error: t("apiAuth.common.invalidCredentials") }, { status: 401 });
  }
  // Same answer the non-2FA path gives a disabled account with a valid password
  // (signInAndMintSession's AccountDeactivatedError) — no second factor needed
  // to learn something the password alone already discloses there.
  if (row.deactivatedAt) return disabledAccountResponse(t);

  const config = webAuthnConfigFromEnv();
  const webauthn =
    state.passkeys.length > 0 && config
      ? {
          challenge: randomBytes(32).toString("base64url"),
          rpId: config.rpId,
          allowCredentials: state.passkeys.map((p) => ({ type: "public-key" as const, id: p.credentialId, transports: p.transports })),
          userVerification: "preferred" as const,
          timeout: WEBAUTHN_TIMEOUT_MS,
        }
      : undefined;

  const methods: MfaMethod[] = [];
  if (state.totpEnabled) methods.push("totp");
  if (webauthn) methods.push("webauthn");
  if (state.recoveryRemaining > 0) methods.push("recovery");

  const { token } = await signMfaSigninToken({
    userId: user.id,
    rememberMe: user.rememberMe,
    native: hasNativeClientHeader(req.headers.get(NATIVE_CLIENT_HEADER)),
    pwv: user.passwordVersion,
    webauthnChallenge: webauthn?.challenge,
  });

  // The password was RIGHT. For a 2FA account that is a meaningful event on its
  // own — it is what a stolen password looks like before the second factor
  // stops it — so it is audited, not just the later second-factor outcome.
  // AUTH_LOGIN_FAILED because no session exists yet (the login is not complete),
  // with its own reason; the details carry no secret.
  void logAudit({
    userId: user.id,
    userName: "anonymous",
    action: "AUTH_LOGIN_FAILED",
    target: "auth:login",
    ipAddress: getClientIp(req.headers),
    userAgent: req.headers.get("user-agent")?.slice(0, 512) ?? null,
    provider: "credentials",
    details: { reason: "mfa_challenge_issued", methods },
  });

  return NextResponse.json(
    {
      error: t("apiAuth.mfa.required"),
      mfaRequired: true,
      methods,
      mfaToken: token,
      expiresInSeconds: MFA_TOKEN_TTL_SECONDS,
      ...(webauthn ? { webauthn } : {}),
    },
    { status: 401, headers: { "Cache-Control": "no-store" } },
  );
}
