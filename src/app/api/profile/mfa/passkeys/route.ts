import { NextResponse } from "next/server";
import { withAuth } from "@/lib/api-auth";
import { maintenanceGuard } from "@/lib/maintenance";
import { readJsonCapped } from "@/lib/body-size";
import { prisma } from "@/lib/prisma";
import { logAudit, auditContext } from "@/lib/audit";
import { revokeOtherUserSessionsInTx } from "@/lib/auth";
import { markSessionForceRevoked } from "@/lib/session-revocation";
import {
  ensureRecoveryCodesInTx,
  getMfaState,
  getMfaStateInTx,
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
  type VerifiedRegistration,
} from "@/lib/mfa/webauthn";
import { translatorForRequest } from "@/lib/i18n/server-locale";
import { isPrismaErrorCode } from "@/lib/prisma-errors";

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
type RegisterOutcome =
  | { kind: "added"; recoveryCodes: string[] | null; firstFactor: boolean; revokedSessionIds: string[] }
  | { kind: "gained-factor" }
  | { kind: "max" };

/**
 * Stores the verified passkey under the per-user MFA lock, re-judging the
 * account's factors there. The first factor also gets the recovery codes, and
 * signs out the OTHER sessions in this same transaction: a separate one that
 * failed would 500 a registration that already committed (codes never shown)
 * and leave those sessions live (6d). A duplicate credential id throws the
 * unique violation (P2002) to the caller.
 */
async function storePasskey(opts: {
  userId: string;
  sessionId: string | undefined;
  factorVerified: boolean;
  verified: VerifiedRegistration;
  name: string;
}): Promise<RegisterOutcome> {
  const { userId, verified } = opts;
  return prisma.$transaction(async (tx): Promise<RegisterOutcome> => {
    // Lock FIRST, then read the factor state inside it: every enrollment
    // write for this user (another passkey, TOTP setup/enable, recovery
    // codes) takes the same lock, so this read can't be stale by the time
    // the credential lands. The route's earlier read is a request old.
    await lockUserMfaInTx(tx, userId);
    const state = await getMfaStateInTx(tx, userId);
    if (state.enabled && !opts.factorVerified) return { kind: "gained-factor" };
    if (state.passkeys.length >= MAX_PASSKEYS_PER_USER) return { kind: "max" };
    // The unique credentialId violation, if any, is this tx's FIRST write and
    // propagates (guardrail 23) — nothing earlier to roll back silently.
    await tx.webAuthnCredential.create({
      data: {
        userId,
        credentialId: verified.credentialId,
        publicKey: verified.publicKey,
        signCount: BigInt(verified.signCount),
        transports: verified.transports,
        name: opts.name,
        aaguid: verified.aaguid,
        backupEligible: verified.backupEligible,
        backedUp: verified.backedUp,
      },
    });
    // First factor: a pending authenticator secret issued on the password
    // alone must not be confirmable once the account has 2FA (totp/enable
    // takes no password), so it goes.
    if (!state.enabled) await tx.userTotp.deleteMany({ where: { userId, enabledAt: null } });
    const recoveryCodes = await ensureRecoveryCodesInTx(tx, userId);
    const firstFactor = !state.enabled;
    const revokedSessionIds = firstFactor ? await revokeOtherUserSessionsInTx(tx, userId, opts.sessionId) : [];
    return { kind: "added", recoveryCodes, firstFactor, revokedSessionIds };
  });
}

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
  // re-read under the lock in storePasskey.
  const before = await getMfaState(user.id);
  if (before.enabled && !claims.factorVerified) {
    return NextResponse.json({ error: t("apiAuth.mfa.passkeySetupExpired") }, { status: 400 });
  }

  let verified: VerifiedRegistration;
  try {
    // The cast only names the shape: verifyRegistrationResponse treats its
    // input as untrusted and checks every field it reads (type, ids, the
    // base64url of each binary field), refusing anything else with a
    // WebAuthnError — whose code is answered below.
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
  let outcome: RegisterOutcome;
  try {
    outcome = await storePasskey({ userId: user.id, sessionId: session.sessionId, factorVerified: claims.factorVerified, verified, name });
  } catch (err) {
    if (isPrismaErrorCode(err, "P2002")) {
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

  // Committed: only now mark the revoked sessions in memory (guardrail 27).
  for (const sessionId of outcome.revokedSessionIds) markSessionForceRevoked(sessionId);
  const revoked = outcome.revokedSessionIds.length;
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
