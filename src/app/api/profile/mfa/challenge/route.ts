import { randomBytes } from "node:crypto";
import { NextResponse } from "next/server";
import { withAuth } from "@/lib/api-auth";
import { checkRateLimit } from "@/lib/rate-limit";
import { getMfaState } from "@/lib/mfa/mfa-store";
import { MFA_TOKEN_TTL_SECONDS, signMfaStepUpToken } from "@/lib/mfa/mfa-token";
import { mfaEligibleUser } from "@/lib/mfa/step-up";
import { webAuthnConfigFromEnv } from "@/lib/mfa/webauthn";
import { translatorForRequest } from "@/lib/i18n/server-locale";

// POST /api/profile/mfa/challenge — a fresh WebAuthn challenge so a PASSKEY can
// confirm a two-factor enrollment change (the `secondFactor` step-up in
// src/lib/mfa/step-up.ts). Returns { challengeToken, publicKey } where
// publicKey is the PublicKeyCredentialRequestOptions (binary fields base64url)
// for navigator.credentials.get(). The token is single-use, expires in five
// minutes and is bound to this user AND this session; send it back as
// secondFactor.challengeToken with the assertion.
//
// Issuing a challenge changes nothing and discloses only the caller's own
// credential ids, so it needs no password — the change it confirms does.
export const POST = withAuth(async (req, _ctx, session) => {
  const t = translatorForRequest(req);
  const config = webAuthnConfigFromEnv();
  if (!config) {
    return NextResponse.json({ error: t("apiAuth.mfa.passkeysNeedAuthUrl") }, { status: 503 });
  }
  if (!session.sessionId) return NextResponse.json({ error: t("apiAuth.common.unauthorized") }, { status: 401 });
  if (!checkRateLimit(`mfa-stepup-challenge:${session.user.id}`, 30, 15 * 60 * 1000)) {
    return NextResponse.json({ error: t("apiAuth.common.tooManyAttempts15") }, { status: 429 });
  }
  const user = await mfaEligibleUser(session, t);
  if (user instanceof NextResponse) return user;
  const state = await getMfaState(user.id);
  if (state.passkeys.length === 0) {
    return NextResponse.json({ error: t("apiAuth.mfa.noPasskeys") }, { status: 400 });
  }

  const challenge = randomBytes(32).toString("base64url");
  const { token } = await signMfaStepUpToken({ userId: user.id, sessionId: session.sessionId, challenge });
  return NextResponse.json(
    {
      challengeToken: token,
      publicKey: {
        challenge,
        rpId: config.rpId,
        allowCredentials: state.passkeys.map((p) => ({ type: "public-key", id: p.credentialId, transports: p.transports })),
        userVerification: "preferred",
        timeout: MFA_TOKEN_TTL_SECONDS * 1000,
      },
    },
    { headers: { "Cache-Control": "no-store" } },
  );
});
