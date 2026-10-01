import { NextResponse } from "next/server";
import { withAuth } from "@/lib/api-auth";
import { maintenanceGuard } from "@/lib/maintenance";
import { readJsonCapped } from "@/lib/body-size";
import { prisma } from "@/lib/prisma";
import { logAudit, auditContext } from "@/lib/audit";
import { revokeOtherUserSessions } from "@/lib/auth";
import {
  ensureRecoveryCodesInTx,
  getMfaState,
  MAX_PASSKEYS_PER_USER,
  sanitizePasskeyName,
} from "@/lib/mfa/mfa-store";
import { consumeToken, isTokenUsable, recordTokenFailure, verifyPasskeyRegisterToken } from "@/lib/mfa/mfa-token";
import { mfaEligibleUser } from "@/lib/mfa/step-up";
import {
  verifyRegistrationResponse,
  webAuthnConfigFromEnv,
  WebAuthnError,
  type RegistrationResponseJSON,
} from "@/lib/mfa/webauthn";

// POST /api/profile/mfa/passkeys — step 2 of adding a passkey.
// Body: { registrationToken, name, credential } where `credential` is the
// PublicKeyCredential from navigator.credentials.create(), binary fields as
// base64url. The password step-up happened at /passkeys/options; the token it
// issued is single-use, expires in 5 minutes and is bound to this user AND this
// session, so it can't be replayed or completed from somewhere else.
//
// When this is the account's FIRST second factor the response carries ten
// one-time recovery codes and every OTHER session is signed out.
export const POST = withAuth(async (req, _ctx, session) => {
  const maint = await maintenanceGuard(session);
  if (maint) return maint;
  const config = webAuthnConfigFromEnv();
  if (!config) {
    return NextResponse.json({ error: "Passkeys need AUTH_URL to be set to this server's public URL." }, { status: 503 });
  }
  const parsed = await readJsonCapped<{ registrationToken?: unknown; name?: unknown; credential?: unknown }>(req, 64 * 1024);
  if (parsed instanceof NextResponse) return parsed;

  const claims = await verifyPasskeyRegisterToken(parsed.registrationToken);
  if (
    !claims ||
    claims.userId !== session.user.id ||
    !session.sessionId ||
    claims.sessionId !== session.sessionId ||
    !isTokenUsable(claims.jti, claims.exp)
  ) {
    return NextResponse.json({ error: "This passkey setup has expired. Please start again." }, { status: 400 });
  }
  const user = await mfaEligibleUser(session);
  if (user instanceof NextResponse) return user;
  if (!parsed.credential || typeof parsed.credential !== "object") {
    return NextResponse.json({ error: "Missing passkey response" }, { status: 400 });
  }

  let verified;
  try {
    verified = verifyRegistrationResponse({
      response: parsed.credential as RegistrationResponseJSON,
      expectedChallenge: claims.challenge,
      config,
    });
  } catch (err) {
    recordTokenFailure(claims.jti, claims.exp);
    const code = err instanceof WebAuthnError ? err.code : "verify";
    return NextResponse.json({ error: "The passkey could not be verified.", code }, { status: 400 });
  }
  if (!consumeToken(claims.jti, claims.exp)) {
    return NextResponse.json({ error: "This passkey setup has expired. Please start again." }, { status: 400 });
  }

  const before = await getMfaState(user.id);
  if (before.passkeys.length >= MAX_PASSKEYS_PER_USER) {
    return NextResponse.json({ error: `You can register at most ${MAX_PASSKEYS_PER_USER} passkeys.` }, { status: 400 });
  }
  const name = sanitizePasskeyName(parsed.name);

  let recoveryCodes: string[] | null;
  try {
    recoveryCodes = await prisma.$transaction(async (tx) => {
      // The unique credentialId violation, if any, is this tx's FIRST write and
      // propagates (guardrail 23) — nothing earlier to roll back silently.
      await tx.webAuthnCredential.create({
        data: {
          userId: user.id,
          credentialId: verified.credentialId,
          publicKey: verified.publicKey,
          signCount: BigInt(verified.signCount),
          transports: verified.transports,
          name,
          aaguid: verified.aaguid,
          backupEligible: verified.backupEligible,
          backedUp: verified.backedUp,
        },
      });
      return ensureRecoveryCodesInTx(tx, user.id);
    });
  } catch (err) {
    if ((err as { code?: string })?.code === "P2002") {
      return NextResponse.json({ error: "That passkey is already registered." }, { status: 409 });
    }
    throw err;
  }

  const revoked = before.enabled ? 0 : await revokeOtherUserSessions(user.id, session.sessionId);
  void logAudit({
    userId: user.id,
    userName: user.name ?? user.email,
    action: "MFA_CHANGE",
    target: `user:${user.id}`,
    details: { kind: "passkey-added", name, firstFactor: !before.enabled, otherSessionsRevoked: revoked },
    ...auditContext(req, session),
  });
  return NextResponse.json(
    { ok: true, ...(recoveryCodes ? { recoveryCodes } : {}) },
    { headers: { "Cache-Control": "no-store" } },
  );
});
