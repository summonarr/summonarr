import "server-only";

// Persistent bound on second-factor GUESSING (guardrail 6d).
//
// Why a DB counter: the sign-in MFA step used to be bounded only by an
// in-memory 10-per-15-minutes bucket per user. That resets on every restart,
// and a CORRECT password refunds the password-step limiter — so anyone holding
// the password could mint challenge tokens without limit and keep guessing
// six-digit codes. A counter on the User row survives restarts and replicas.
//
// Rules:
//   - CONSECUTIVE failed codes (TOTP + recovery) are counted, at sign-in AND at
//     the enrollment step-up (step-up.ts) — one budget, wherever the guess is.
//   - At MFA_LOCKOUT_THRESHOLD the counter resets and mfaLockedUntil is set:
//     15 minutes, doubling per lockout, capped at 24 hours. While it is in the
//     future every CODE is refused WITHOUT being checked (so a correct one isn't
//     burned either) with one generic message.
//   - A successful code resets the consecutive count. The escalation level
//     (mfaLockoutCount) is reset only once the last lockout is more than
//     MFA_LOCKOUT_MAX_MS in the past — an owner signing in between an attacker's
//     bursts must not hand the attacker a fresh 15-minute rung each time.
//   - PASSKEYS are exempt in both directions: an assertion can't be guessed, so
//     a failed one never counts, and a passkey still works DURING a lockout (the
//     lockout exists to stop guessing, and this is how the real owner gets in
//     while someone holding their password is hammering codes). A passkey
//     success deliberately does NOT clear the count or the lockout: it proves
//     the owner is present, not that the code guesser has gone away.
//   - Imposing a lockout is audited (AUTH_LOGIN_FAILED, reason "mfa_lockout",
//     logAudit post-commit — guardrail 26) and mailed to the owner (best-effort).
//     Exactly one request imposes it: the transition is a conditional UPDATE.

import { prisma } from "@/lib/prisma";
import { logAudit } from "@/lib/audit";
import { verifySecondFactor, type SecondFactorInput } from "./mfa-store";
import { notifyMfaSecurityEvent } from "./notify";
import type { WebAuthnConfig } from "./webauthn";

export const MFA_LOCKOUT_THRESHOLD = 10;
export const MFA_LOCKOUT_BASE_MS = 15 * 60 * 1000;
export const MFA_LOCKOUT_MAX_MS = 24 * 60 * 60 * 1000;
// English text of apiAuth.mfa.locked (responses go through the catalog).
export const MFA_LOCKED_MESSAGE =
  "Too many incorrect verification codes. Code sign-in is temporarily locked for this account — try again later.";

// Pure: lockout length for the (priorLockouts + 1)-th lockout.
export function lockoutDurationMs(priorLockouts: number): number {
  const n = Math.max(0, Math.min(priorLockouts, 20));
  return Math.min(MFA_LOCKOUT_BASE_MS * 2 ** n, MFA_LOCKOUT_MAX_MS);
}

// The active lockout's end, or null when codes may be tried.
export async function activeMfaLockout(userId: string, nowMs = Date.now()): Promise<Date | null> {
  const row = await prisma.user.findUnique({ where: { id: userId }, select: { mfaLockedUntil: true } });
  const until = row?.mfaLockedUntil ?? null;
  return until && until.getTime() > nowMs ? until : null;
}

export interface FailureOutcome {
  // Set when THIS failure tripped a lockout.
  lockedUntil: Date | null;
  imposed: boolean;
}

// Counts one failed code. The increment is atomic in SQL; the lockout
// transition is a compare-and-swap on "still at or over the threshold", so two
// concurrent failures can't both impose (or double-escalate) it.
export async function recordMfaCodeFailure(userId: string, nowMs = Date.now()): Promise<FailureOutcome> {
  const row = await prisma.user.update({
    where: { id: userId },
    data: { mfaFailedAttempts: { increment: 1 } },
    select: { mfaFailedAttempts: true, mfaLockoutCount: true },
  });
  if (row.mfaFailedAttempts < MFA_LOCKOUT_THRESHOLD) return { lockedUntil: null, imposed: false };
  const until = new Date(nowMs + lockoutDurationMs(row.mfaLockoutCount));
  const res = await prisma.user.updateMany({
    where: { id: userId, mfaFailedAttempts: { gte: MFA_LOCKOUT_THRESHOLD } },
    data: { mfaFailedAttempts: 0, mfaLockoutCount: { increment: 1 }, mfaLockedUntil: until },
  });
  return { lockedUntil: until, imposed: res.count === 1 };
}

// A code verified. Conditional writes, so the common case (nothing to reset)
// costs no write at all.
export async function recordMfaCodeSuccess(userId: string, nowMs = Date.now()): Promise<void> {
  await prisma.user.updateMany({
    where: { id: userId, mfaFailedAttempts: { gt: 0 } },
    data: { mfaFailedAttempts: 0 },
  });
  await prisma.user.updateMany({
    where: {
      id: userId,
      mfaLockoutCount: { gt: 0 },
      OR: [{ mfaLockedUntil: null }, { mfaLockedUntil: { lt: new Date(nowMs - MFA_LOCKOUT_MAX_MS) } }],
    },
    data: { mfaLockoutCount: 0, mfaLockedUntil: null },
  });
}

export type GuardedVerdict =
  | { ok: true }
  | { ok: false; reason: string; locked: boolean };

export interface GuardContext {
  webauthnChallenge?: string;
  webauthnConfig: WebAuthnConfig | null;
  // Where the guess happened, for the lockout audit row.
  context: "sign-in" | "enrollment";
  ipAddress?: string | null;
  userAgent?: string | null;
}

// verifySecondFactor (the replay-safe CAS verifiers — not a fork of them) wrapped
// in the persistent lockout. Every caller that checks a code goes through here.
export async function verifySecondFactorGuarded(
  userId: string,
  input: SecondFactorInput,
  ctx: GuardContext,
): Promise<GuardedVerdict> {
  const isCode = input.method === "totp" || input.method === "recovery";
  if (isCode && (await activeMfaLockout(userId))) {
    return { ok: false, reason: "locked", locked: true };
  }
  const verdict = await verifySecondFactor(userId, input, {
    webauthnChallenge: ctx.webauthnChallenge,
    webauthnConfig: ctx.webauthnConfig,
  });
  if (verdict.ok) {
    if (isCode) await recordMfaCodeSuccess(userId);
    return { ok: true };
  }
  if (!isCode) return { ok: false, reason: verdict.reason, locked: false };

  const outcome = await recordMfaCodeFailure(userId);
  if (outcome.imposed && outcome.lockedUntil) {
    const user = await prisma.user.findUnique({ where: { id: userId }, select: { name: true, email: true } });
    void logAudit({
      userId,
      userName: user?.name ?? user?.email ?? "unknown",
      action: "AUTH_LOGIN_FAILED",
      target: `user:${userId}`,
      ipAddress: ctx.ipAddress ?? null,
      userAgent: ctx.userAgent ?? null,
      provider: "credentials",
      details: {
        reason: "mfa_lockout",
        context: ctx.context,
        lockedUntil: outcome.lockedUntil.toISOString(),
        threshold: MFA_LOCKOUT_THRESHOLD,
      },
    });
    void notifyMfaSecurityEvent(userId, "lockout");
  }
  return { ok: false, reason: verdict.reason, locked: outcome.lockedUntil !== null };
}
