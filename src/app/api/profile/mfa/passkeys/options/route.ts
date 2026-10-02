import { randomBytes } from "node:crypto";
import { NextResponse } from "next/server";
import { withAuth } from "@/lib/api-auth";
import { maintenanceGuard } from "@/lib/maintenance";
import { readJsonCapped } from "@/lib/body-size";
import { getMfaState, MAX_PASSKEYS_PER_USER, webAuthnUserHandle } from "@/lib/mfa/mfa-store";
import { MFA_TOKEN_TTL_SECONDS, signPasskeyRegisterToken } from "@/lib/mfa/mfa-token";
import { mfaReauthStepUp, mfaSecondFactorStepUp } from "@/lib/mfa/step-up";
import { SUPPORTED_COSE_ALGS, webAuthnConfigFromEnv } from "@/lib/mfa/webauthn";

// POST /api/profile/mfa/passkeys/options — step 1 of adding a passkey.
// Body: { password, secondFactor? } — the second factor is required when the
// account already has an active factor (step-up.ts); a first passkey is
// password-only. Returns the PublicKeyCredentialCreationOptions (binary
// fields base64url) for navigator.credentials.create(), plus a short-lived
// single-use `registrationToken` that carries the challenge, is bound to this
// user AND this session, and records whether a second factor was verified.
// Step 2 is POST /api/profile/mfa/passkeys.
export const POST = withAuth(async (req, _ctx, session) => {
  const maint = await maintenanceGuard(session);
  if (maint) return maint;
  const config = webAuthnConfigFromEnv();
  if (!config) {
    return NextResponse.json({ error: "Passkeys need AUTH_URL to be set to this server's public URL." }, { status: 503 });
  }
  if (!session.sessionId) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const parsed = await readJsonCapped<{ password?: unknown; secondFactor?: unknown }>(req, 64 * 1024);
  if (parsed instanceof NextResponse) return parsed;
  const user = await mfaReauthStepUp(session, parsed.password);
  if (user instanceof NextResponse) return user;

  const state = await getMfaState(user.id);
  if (state.passkeys.length >= MAX_PASSKEYS_PER_USER) {
    return NextResponse.json({ error: `You can register at most ${MAX_PASSKEYS_PER_USER} passkeys.` }, { status: 400 });
  }
  const proof = await mfaSecondFactorStepUp(req, session, user, parsed.secondFactor, state);
  if (proof instanceof NextResponse) return proof;

  const challenge = randomBytes(32).toString("base64url");
  const { token } = await signPasskeyRegisterToken({
    userId: user.id,
    sessionId: session.sessionId,
    challenge,
    factorVerified: proof.proved,
  });
  return NextResponse.json(
    {
      registrationToken: token,
      publicKey: {
        rp: { id: config.rpId, name: config.rpName },
        user: { id: webAuthnUserHandle(user.id), name: user.email, displayName: user.name ?? user.email },
        challenge,
        pubKeyCredParams: SUPPORTED_COSE_ALGS.map((alg) => ({ type: "public-key", alg })),
        timeout: MFA_TOKEN_TTL_SECONDS * 1000,
        attestation: "none",
        authenticatorSelection: { residentKey: "discouraged", requireResidentKey: false, userVerification: "preferred" },
        excludeCredentials: state.passkeys.map((p) => ({ type: "public-key", id: p.credentialId, transports: p.transports })),
      },
    },
    { headers: { "Cache-Control": "no-store" } },
  );
});
