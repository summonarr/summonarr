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
  lockUserMfaInTx,
  MAX_PASSKEYS_PER_USER,
  sanitizePasskeyName,
} from "@/lib/mfa/mfa-store";
import { consumeToken, isTokenUsable, recordTokenFailure, verifyPasskeyRegisterToken } from "@/lib/mfa/mfa-token";
import { mfaEligibleUser } from "@/lib/mfa/step-up";
import { notifyMfaSecurityEvent } from "@/lib/mfa/notify";
import {
  verifyRegistrationResponse,
  webAuthnConfigFromEnv,
  WebAuthnError,
  type RegistrationResponseJSON,
} from "@/lib/mfa/webauthn";
import { translatorForRequest } from "@/lib/i18n/server-locale";

// POST /api/profile/mfa/passkeys — step 2 of adding a passkey.
// Body: { registrationToken, name, credential } where `credential` is the
// PublicKeyCredential from navigator.credentials.create(), binary fields as
// base64url. The enrollment step-up happened at /passkeys/options; the token it
// issued is single-use, expires in 5 minutes and is bound to this user AND this
// session, so it can't be replayed or completed from somewhere else. A token
// minted on the password alone (the account had no factor then) is refused if
// the account has gained a factor since — judged INSIDE the write transaction,
// under the per-user MFA lock, so two password-only registrations racing each
// other (or a TOTP enable) can't both land as "the first factor".
//
// When this is the account's FIRST second factor the response carries ten
// one-time recovery codes and every OTHER session is signed out.
export const POST = withAuth(async (req, _ctx, session) => {
  const t = translatorForRequest(req);
  const maint = await maintenanceGuard(session);
  if (maint) return maint;
  const config = webAuthnConfigFromEnv();
  if (!config) {
    return NextResponse.json({ error: t("apiAuth.mfa.passkeysNeedAuthUrl") }, { status: 503 });
  }
  const parsed = await readJsonCapped<{ registrationToken?: unknown; name?: unknown; credential?: unknown }>(req, 64 * 1024);
  if (parsed instanceof NextResponse) return parsed;

  const claims = await verifyPasskeyRegisterToken(parsed.registrationToken);
  if (
    !claims ||
    claims.userId !== session.user.id ||
    !session.sessionId ||
    claims.sessionId !== session.sessionId ||
    !isTokenUsable(claims.jti)
  ) {
    return NextResponse.json({ error: t("apiAuth.mfa.passkeySetupExpired") }, { status: 400 });
  }
  const user = await mfaEligibleUser(session, t);
  if (user instanceof NextResponse) return user;
  if (!parsed.credential || typeof parsed.credential !== "object") {
    return NextResponse.json({ error: t("apiAuth.mfa.passkeyResponseMissing") }, { status: 400 });
  }
  // Early answer only (it spends nothing); the authoritative check is the
  // re-read under the lock below.
  const before = await getMfaState(user.id);
  if (before.enabled && !claims.factorVerified) {
    return NextResponse.json({ error: t("apiAuth.mfa.passkeySetupExpired") }, { status: 400 });
  }

  let verified;
  try {
    verified = verifyRegistrationResponse({
      response: parsed.credential as RegistrationResponseJSON,
      expectedChallenge: claims.challenge,
      config,
    });
  } catch (err) {
    recordTokenFailure(claims.jti);
    const code = err instanceof WebAuthnError ? err.code : "verify";
    return NextResponse.json({ error: t("apiAuth.mfa.passkeyNotVerified"), code }, { status: 400 });
  }
  if (!consumeToken(claims.jti)) {
    return NextResponse.json({ error: t("apiAuth.mfa.passkeySetupExpired") }, { status: 400 });
  }

  const name = sanitizePasskeyName(parsed.name);

  let outcome:
    | { kind: "added"; recoveryCodes: string[] | null; firstFactor: boolean }
    | { kind: "gained-factor" }
    | { kind: "max" };
  try {
    outcome = await prisma.$transaction(async (tx) => {
      // Lock FIRST, then read the factor state inside it: every enrollment
      // write for this user (another passkey, TOTP setup/enable, recovery
      // codes) takes the same lock, so this read can't be stale by the time
      // the credential lands. The `before` read above is a request old.
      await lockUserMfaInTx(tx, user.id);
      const state = await getMfaState(user.id, tx);
      if (state.enabled && !claims.factorVerified) return { kind: "gained-factor" as const };
      if (state.passkeys.length >= MAX_PASSKEYS_PER_USER) return { kind: "max" as const };
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
      // First factor: a pending authenticator secret issued on the password
      // alone must not be confirmable once the account has 2FA (totp/enable
      // takes no password), so it goes.
      if (!state.enabled) await tx.userTotp.deleteMany({ where: { userId: user.id, enabledAt: null } });
      return { kind: "added" as const, recoveryCodes: await ensureRecoveryCodesInTx(tx, user.id), firstFactor: !state.enabled };
    });
  } catch (err) {
    if ((err as { code?: string })?.code === "P2002") {
      return NextResponse.json({ error: t("apiAuth.mfa.passkeyAlreadyRegistered") }, { status: 409 });
    }
    throw err;
  }
  if (outcome.kind === "gained-factor") {
    return NextResponse.json({ error: t("apiAuth.mfa.passkeySetupExpired") }, { status: 400 });
  }
  if (outcome.kind === "max") {
    return NextResponse.json({ error: t("apiAuth.mfa.maxPasskeys", { max: MAX_PASSKEYS_PER_USER }) }, { status: 400 });
  }
  const { recoveryCodes, firstFactor } = outcome;

  const revoked = firstFactor ? await revokeOtherUserSessions(user.id, session.sessionId) : 0;
  void notifyMfaSecurityEvent(user.id, "passkey-added");
  void logAudit({
    userId: user.id,
    userName: user.name ?? user.email,
    action: "MFA_CHANGE",
    target: `user:${user.id}`,
    details: { kind: "passkey-added", name, firstFactor, otherSessionsRevoked: revoked },
    ...auditContext(req, session),
  });
  return NextResponse.json(
    { ok: true, ...(recoveryCodes ? { recoveryCodes } : {}) },
    { headers: { "Cache-Control": "no-store" } },
  );
});
