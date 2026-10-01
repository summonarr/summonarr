import "server-only";

// Prisma-backed half of two-factor auth: reading a user's factors, verifying a
// second factor with replay-safe compare-and-swap writes, and the enrollment
// write sets. The pure rules live in totp.ts / recovery-codes.ts / webauthn.ts.
//
// The FACTOR ROWS are the only source of truth for "this account has 2FA"
// (getMfaState): there is no denormalized User flag that could drift to false
// and silently skip the second factor.
//
// Every "use once" property is a conditional UPDATE whose row count decides,
// never a read-then-write:
//   - TOTP:      UPDATE … SET lastUsedStep = s WHERE lastUsedStep IS NULL OR < s
//   - recovery:  UPDATE … SET usedAt = now   WHERE usedAt IS NULL
//   - passkey:   UPDATE … SET signCount = n  WHERE signCount = <value verified>
// so two concurrent requests presenting the same code/assertion can't both win.

import { createHash, createHmac } from "node:crypto";
import { prisma } from "@/lib/prisma";
import { verifyTotp, generateTotpSecret } from "./totp";
import { generateRecoveryCodes, hashRecoveryCode, normalizeRecoveryCode, recoveryHashesEqual } from "./recovery-codes";
import {
  assertionCredentialId,
  verifyAuthenticationResponse,
  WebAuthnError,
  type AuthenticationResponseJSON,
  type WebAuthnConfig,
} from "./webauthn";

// Same derivation as account-lifecycle.ts: the encryption extension changes
// the client's type, so derive the tx client from the extended client.
export type MfaTxClient = Omit<
  typeof prisma,
  "$connect" | "$disconnect" | "$on" | "$transaction" | "$use" | "$extends"
>;

export const MAX_PASSKEYS_PER_USER = 10;
export const PASSKEY_NAME_MAX = 64;

export interface PasskeySummary {
  id: string;
  credentialId: string;
  transports: string[];
  name: string;
  createdAt: Date;
  lastUsedAt: Date | null;
  backedUp: boolean;
}

export interface MfaState {
  totpEnabled: boolean;
  // A secret was issued by /totp/setup and not yet confirmed.
  totpPending: boolean;
  passkeys: PasskeySummary[];
  recoveryRemaining: number;
  // At least one second factor is active — the password alone is not enough.
  enabled: boolean;
}

export async function getMfaState(userId: string, db: MfaTxClient = prisma): Promise<MfaState> {
  const [totp, passkeys, recoveryRemaining] = await Promise.all([
    db.userTotp.findUnique({ where: { userId }, select: { enabledAt: true } }),
    db.webAuthnCredential.findMany({
      where: { userId },
      select: { id: true, credentialId: true, transports: true, name: true, createdAt: true, lastUsedAt: true, backedUp: true },
      orderBy: { createdAt: "asc" },
    }),
    db.mfaRecoveryCode.count({ where: { userId, usedAt: null } }),
  ]);
  const totpEnabled = !!totp?.enabledAt;
  return {
    totpEnabled,
    totpPending: !!totp && !totp.enabledAt,
    passkeys,
    recoveryRemaining,
    enabled: totpEnabled || passkeys.length > 0,
  };
}

// Stable, non-identifying WebAuthn user handle (§5.4.3 says it must not carry
// PII): a hash of the user id, never the email.
export function webAuthnUserHandle(userId: string): string {
  return createHash("sha256").update(`summonarr-webauthn-user:v1:${userId}`).digest("base64url");
}

// Fingerprint of the password hash a sign-in challenge was issued against.
// Keyed, so the value carried in the (client-readable) challenge token reveals
// nothing about the hash itself. A changed password ⇒ a different value ⇒ the
// pending challenge is dead.
export function passwordVersion(passwordHash: string): string {
  const secret = process.env.NEXTAUTH_SECRET;
  if (!secret) throw new Error("[mfa] NEXTAUTH_SECRET must be set");
  return createHmac("sha256", secret).update(`summonarr-pwv:v1:${passwordHash}`).digest("base64url").slice(0, 32);
}

// ─── second-factor verification (sign-in) ────────────────────────────────────

export async function verifyTotpForUser(userId: string, code: string, nowMs = Date.now()): Promise<boolean> {
  const row = await prisma.userTotp.findUnique({ where: { userId } });
  if (!row?.enabledAt || !row.secret) return false;
  const verdict = verifyTotp(row.secret, code, { nowMs, lastUsedStep: row.lastUsedStep });
  if (!verdict.ok) return false;
  // Replay protection: the step must still be newer than the stored one AT
  // WRITE TIME. A concurrent request with the same code loses this CAS.
  const res = await prisma.userTotp.updateMany({
    where: {
      userId,
      enabledAt: { not: null },
      OR: [{ lastUsedStep: null }, { lastUsedStep: { lt: verdict.step } }],
    },
    data: { lastUsedStep: verdict.step },
  });
  return res.count === 1;
}

export async function consumeRecoveryCode(userId: string, input: string): Promise<boolean> {
  const normalized = normalizeRecoveryCode(input);
  if (!normalized) return false;
  const hash = hashRecoveryCode(normalized);
  const rows = await prisma.mfaRecoveryCode.findMany({
    where: { userId, usedAt: null },
    select: { id: true, codeHash: true },
  });
  // Compare against every unused code — no early exit, constant-time compares.
  let matchId: string | null = null;
  for (const row of rows) {
    if (recoveryHashesEqual(row.codeHash, hash) && matchId === null) matchId = row.id;
  }
  if (!matchId) return false;
  const res = await prisma.mfaRecoveryCode.updateMany({
    where: { id: matchId, userId, usedAt: null },
    data: { usedAt: new Date() },
  });
  return res.count === 1;
}

export type PasskeyVerdict = { ok: true } | { ok: false; code: string };

export async function verifyPasskeyForUser(
  userId: string,
  response: AuthenticationResponseJSON,
  expectedChallenge: string,
  config: WebAuthnConfig,
): Promise<PasskeyVerdict> {
  let credentialId: string;
  try {
    credentialId = assertionCredentialId(response);
  } catch (err) {
    return { ok: false, code: err instanceof WebAuthnError ? err.code : "shape" };
  }
  // Scoped to THIS user: another account's credential id simply isn't found.
  const row = await prisma.webAuthnCredential.findFirst({ where: { credentialId, userId } });
  if (!row) return { ok: false, code: "credential" };
  let verified;
  try {
    verified = verifyAuthenticationResponse({
      response,
      expectedChallenge,
      config,
      credential: { credentialId: row.credentialId, publicKey: row.publicKey, signCount: Number(row.signCount) },
      expectedUserHandle: webAuthnUserHandle(userId),
    });
  } catch (err) {
    return { ok: false, code: err instanceof WebAuthnError ? err.code : "verify" };
  }
  const res = await prisma.webAuthnCredential.updateMany({
    where: { id: row.id, userId, signCount: row.signCount },
    data: { signCount: BigInt(verified.newSignCount), lastUsedAt: new Date(), backedUp: verified.backedUp },
  });
  // Lost the race to a concurrent assertion with the same counter.
  if (res.count !== 1) return { ok: false, code: "counter" };
  return { ok: true };
}

export type SecondFactorInput =
  | { method: "totp"; code: string }
  | { method: "recovery"; code: string }
  | { method: "webauthn"; credential: AuthenticationResponseJSON };

export async function verifySecondFactor(
  userId: string,
  input: SecondFactorInput,
  ctx: { webauthnChallenge?: string; webauthnConfig: WebAuthnConfig | null },
): Promise<{ ok: true } | { ok: false; reason: string }> {
  if (input.method === "totp") {
    return (await verifyTotpForUser(userId, input.code)) ? { ok: true } : { ok: false, reason: "totp" };
  }
  if (input.method === "recovery") {
    return (await consumeRecoveryCode(userId, input.code)) ? { ok: true } : { ok: false, reason: "recovery" };
  }
  if (!ctx.webauthnChallenge || !ctx.webauthnConfig) return { ok: false, reason: "webauthn-unavailable" };
  const verdict = await verifyPasskeyForUser(userId, input.credential, ctx.webauthnChallenge, ctx.webauthnConfig);
  return verdict.ok ? { ok: true } : { ok: false, reason: `webauthn:${verdict.code}` };
}

// ─── enrollment ─────────────────────────────────────────────────────────────

// Issues (or re-issues) a PENDING TOTP secret. Refuses when TOTP is already
// enabled — replacing an active secret must go through removal first, which is
// its own step-up'd, audited change.
export async function beginTotpEnrollment(userId: string): Promise<{ secret: string } | "already-enabled"> {
  const existing = await prisma.userTotp.findUnique({ where: { userId }, select: { enabledAt: true } });
  if (existing?.enabledAt) return "already-enabled";
  const secret = generateTotpSecret();
  if (existing) {
    // Conditional on still-pending, so a concurrent confirm can't be clobbered.
    const res = await prisma.userTotp.updateMany({
      where: { userId, enabledAt: null },
      data: { secret, lastUsedStep: null },
    });
    if (res.count !== 1) return "already-enabled";
  } else {
    await prisma.userTotp.create({ data: { userId, secret } });
  }
  return { secret };
}

export type ConfirmTotpResult = "ok" | "invalid" | "no-pending" | "already-enabled";

// Turns a pending secret into an active factor once the user proves their app
// generates codes for it. The step used to confirm becomes lastUsedStep, so the
// same code can't then be replayed at sign-in.
export async function confirmTotpEnrollmentInTx(
  tx: MfaTxClient,
  userId: string,
  code: string,
  nowMs = Date.now(),
): Promise<ConfirmTotpResult> {
  const row = await tx.userTotp.findUnique({ where: { userId } });
  if (!row) return "no-pending";
  if (row.enabledAt) return "already-enabled";
  const verdict = verifyTotp(row.secret, code, { nowMs, lastUsedStep: null });
  if (!verdict.ok) return "invalid";
  // updatedAt pins the exact pending secret we verified against — a setup that
  // re-issued the secret in between makes this a no-op.
  const res = await tx.userTotp.updateMany({
    where: { userId, enabledAt: null, updatedAt: row.updatedAt },
    data: { enabledAt: new Date(nowMs), lastUsedStep: verdict.step },
  });
  return res.count === 1 ? "ok" : "invalid";
}

// Replaces every recovery code with a fresh set; returns the plaintext (shown
// once). Runs inside the caller's transaction.
export async function replaceRecoveryCodesInTx(tx: MfaTxClient, userId: string): Promise<string[]> {
  const codes = generateRecoveryCodes();
  await tx.mfaRecoveryCode.deleteMany({ where: { userId } });
  await tx.mfaRecoveryCode.createMany({
    data: codes.map((c) => ({ userId, codeHash: hashRecoveryCode(normalizeRecoveryCode(c)!) })),
  });
  return codes;
}

// When the FIRST factor is enabled the user gets recovery codes; afterwards an
// existing unused set is left alone (regenerating is an explicit action).
export async function ensureRecoveryCodesInTx(tx: MfaTxClient, userId: string): Promise<string[] | null> {
  const remaining = await tx.mfaRecoveryCode.count({ where: { userId, usedAt: null } });
  if (remaining > 0) return null;
  return replaceRecoveryCodesInTx(tx, userId);
}

// After a factor is removed: if nothing is left, the recovery codes go too —
// they would otherwise be live credentials for a 2FA that no longer exists.
export async function dropRecoveryCodesIfNoFactorInTx(tx: MfaTxClient, userId: string): Promise<void> {
  const [totp, passkeys] = await Promise.all([
    tx.userTotp.findUnique({ where: { userId }, select: { enabledAt: true } }),
    tx.webAuthnCredential.count({ where: { userId } }),
  ]);
  if (!totp?.enabledAt && passkeys === 0) {
    await tx.mfaRecoveryCode.deleteMany({ where: { userId } });
  }
}

// Removes every second factor and recovery code — disable-all, admin reset and
// account purge share this one write set.
export async function deleteAllMfaInTx(tx: MfaTxClient, userId: string): Promise<void> {
  await tx.userTotp.deleteMany({ where: { userId } });
  await tx.webAuthnCredential.deleteMany({ where: { userId } });
  await tx.mfaRecoveryCode.deleteMany({ where: { userId } });
}

// Display name for a passkey: trimmed, control characters stripped, capped.
export function sanitizePasskeyName(input: unknown, fallback = "Passkey"): string {
  if (typeof input !== "string") return fallback;
  const cleaned = input.replace(/[\u0000-\u001f\u007f<>]/g, "").trim().slice(0, PASSKEY_NAME_MAX);
  return cleaned.length > 0 ? cleaned : fallback;
}
