// Short-lived, single-purpose tokens for the two-factor flows. Pure apart from
// an in-process nonce ledger; no DB.
//
// Two purposes, each with its OWN key, audience and JWT `typ`:
//   - "mfa-signin"       — handed out by the password step when the account has
//                          2FA; redeemed at POST /api/auth/sign-in/mfa.
//   - "passkey-register" — handed out by POST /api/profile/mfa/passkeys/options
//                          (after password step-up); redeemed when the new
//                          credential is posted back.
//
// NONE of these can ever be a session. The session JWT is HS256 over the raw
// NEXTAUTH_SECRET; these are HS256 over an HKDF-derived subkey (domain-separated
// by purpose), so verifySessionJwt rejects them on the signature alone — and
// they carry no `id`/`role` claims either, which verifySessionJwt also requires.
// Symmetrically, a session JWT (or the other purpose's token) fails here on the
// signature, the `typ` header and the audience. tests/mfa-token.test.mts pins
// every direction.
//
// Single use: each token's jti goes into an in-process ledger. A successful
// redemption CONSUMES it; a failed attempt counts against it and the token
// burns after MAX_TOKEN_FAILURES. The ledger is per-process like the rate
// limiter — Summonarr runs as one long-lived Node server (guardrail 17) — and
// the 5-minute expiry bounds anything a restart would forget.

import { hkdfSync, randomBytes } from "node:crypto";
import { SignJWT, jwtVerify } from "jose";
import { processSingleton } from "@/lib/process-singleton";

export const MFA_TOKEN_TTL_SECONDS = 5 * 60;
export const MAX_TOKEN_FAILURES = 5;

type Purpose = "mfa-signin" | "passkey-register";

const AUDIENCE: Record<Purpose, string> = {
  "mfa-signin": "summonarr:mfa-signin",
  "passkey-register": "summonarr:passkey-register",
};
const TYP: Record<Purpose, string> = {
  "mfa-signin": "summonarr-mfa+jwt",
  "passkey-register": "summonarr-passkey-reg+jwt",
};

function keyFor(purpose: Purpose): Uint8Array {
  const secret = process.env.NEXTAUTH_SECRET;
  if (!secret) throw new Error("[mfa-token] NEXTAUTH_SECRET must be set");
  return new Uint8Array(hkdfSync("sha256", secret, "summonarr-mfa-token", `summonarr:${purpose}:v1`, 32));
}

// ─── nonce ledger ───────────────────────────────────────────────────────────

interface LedgerEntry {
  expiresAt: number; // ms
  failures: number;
  consumed: boolean;
}

const MAX_LEDGER = 50_000;
const ledger = processSingleton("mfa-token:ledger", () => new Map<string, LedgerEntry>());

function sweep(now: number): void {
  for (const [k, v] of ledger) if (v.expiresAt < now) ledger.delete(k);
}

function entryFor(jti: string, expSec: number): LedgerEntry {
  const now = Date.now();
  let entry = ledger.get(jti);
  if (!entry) {
    if (ledger.size >= MAX_LEDGER) sweep(now);
    // Still full of live entries: fail closed for the newcomer rather than
    // evicting a live (possibly burned) entry, which would un-burn it.
    if (ledger.size >= MAX_LEDGER) return { expiresAt: 0, failures: MAX_TOKEN_FAILURES, consumed: true };
    entry = { expiresAt: expSec * 1000, failures: 0, consumed: false };
    ledger.set(jti, entry);
  }
  return entry;
}

// True when the token can still be attempted (not consumed, not burned).
export function isTokenUsable(jti: string, expSec: number): boolean {
  const e = entryFor(jti, expSec);
  return !e.consumed && e.failures < MAX_TOKEN_FAILURES;
}

// Atomically claims the token for a successful redemption. Returns false if it
// was already consumed or burned — the caller must then refuse.
export function consumeToken(jti: string, expSec: number): boolean {
  const e = entryFor(jti, expSec);
  if (e.consumed || e.failures >= MAX_TOKEN_FAILURES) return false;
  e.consumed = true;
  return true;
}

// Records a failed attempt; returns the failures so far.
export function recordTokenFailure(jti: string, expSec: number): number {
  const e = entryFor(jti, expSec);
  e.failures += 1;
  return e.failures;
}

// Test seam only.
export function resetMfaTokenLedgerForTests(): void {
  ledger.clear();
}

// ─── sign-in challenge token ────────────────────────────────────────────────

export interface MfaSigninClaims {
  userId: string;
  jti: string;
  exp: number; // seconds
  // The password step's "remember me" choice, carried so the session minted
  // after the second factor gets the same lifetime.
  rememberMe?: string;
  // Whether the password step came from a native client (X-Summonarr-Client).
  // The MFA step must match: the header selects a never-expiring session and a
  // token in the body (guardrails 6b/6c), so it can't change mid-flow.
  native: boolean;
  // Fingerprint of the password hash the first factor was verified against. A
  // password change between the two steps kills the challenge.
  pwv: string;
  // base64url WebAuthn challenge for an assertion, present when the account has
  // passkeys. Bound into the signed token so it can't be swapped.
  webauthnChallenge?: string;
}

export async function signMfaSigninToken(input: Omit<MfaSigninClaims, "jti" | "exp">): Promise<{ token: string; jti: string; exp: number }> {
  const now = Math.floor(Date.now() / 1000);
  const exp = now + MFA_TOKEN_TTL_SECONDS;
  const jti = randomBytes(16).toString("base64url");
  const token = await new SignJWT({
    native: input.native,
    pwv: input.pwv,
    ...(input.rememberMe !== undefined ? { rm: input.rememberMe } : {}),
    ...(input.webauthnChallenge ? { wch: input.webauthnChallenge } : {}),
  })
    .setProtectedHeader({ alg: "HS256", typ: TYP["mfa-signin"] })
    .setSubject(input.userId)
    .setAudience(AUDIENCE["mfa-signin"])
    .setJti(jti)
    .setIssuedAt(now)
    .setExpirationTime(exp)
    .sign(keyFor("mfa-signin"));
  return { token, jti, exp };
}

export async function verifyMfaSigninToken(token: unknown): Promise<MfaSigninClaims | null> {
  if (typeof token !== "string" || token.length === 0 || token.length > 4096) return null;
  try {
    const { payload, protectedHeader } = await jwtVerify(token, keyFor("mfa-signin"), {
      algorithms: ["HS256"],
      audience: AUDIENCE["mfa-signin"],
      typ: TYP["mfa-signin"],
    });
    if (protectedHeader.typ !== TYP["mfa-signin"]) return null;
    if (typeof payload.sub !== "string" || typeof payload.jti !== "string" || typeof payload.exp !== "number") return null;
    if (typeof payload.native !== "boolean" || typeof payload.pwv !== "string") return null;
    if (payload.rm !== undefined && typeof payload.rm !== "string") return null;
    if (payload.wch !== undefined && typeof payload.wch !== "string") return null;
    return {
      userId: payload.sub,
      jti: payload.jti,
      exp: payload.exp,
      native: payload.native,
      pwv: payload.pwv,
      rememberMe: payload.rm as string | undefined,
      webauthnChallenge: payload.wch as string | undefined,
    };
  } catch {
    return null;
  }
}

// ─── passkey registration token ─────────────────────────────────────────────

export interface PasskeyRegisterClaims {
  userId: string;
  // The session that passed the password step-up — the registration must be
  // completed from that same session.
  sessionId: string;
  challenge: string; // base64url
  jti: string;
  exp: number;
}

export async function signPasskeyRegisterToken(input: { userId: string; sessionId: string; challenge: string }): Promise<{ token: string; jti: string; exp: number }> {
  const now = Math.floor(Date.now() / 1000);
  const exp = now + MFA_TOKEN_TTL_SECONDS;
  const jti = randomBytes(16).toString("base64url");
  const token = await new SignJWT({ sid: input.sessionId, ch: input.challenge })
    .setProtectedHeader({ alg: "HS256", typ: TYP["passkey-register"] })
    .setSubject(input.userId)
    .setAudience(AUDIENCE["passkey-register"])
    .setJti(jti)
    .setIssuedAt(now)
    .setExpirationTime(exp)
    .sign(keyFor("passkey-register"));
  return { token, jti, exp };
}

export async function verifyPasskeyRegisterToken(token: unknown): Promise<PasskeyRegisterClaims | null> {
  if (typeof token !== "string" || token.length === 0 || token.length > 4096) return null;
  try {
    const { payload, protectedHeader } = await jwtVerify(token, keyFor("passkey-register"), {
      algorithms: ["HS256"],
      audience: AUDIENCE["passkey-register"],
      typ: TYP["passkey-register"],
    });
    if (protectedHeader.typ !== TYP["passkey-register"]) return null;
    if (typeof payload.sub !== "string" || typeof payload.jti !== "string" || typeof payload.exp !== "number") return null;
    if (typeof payload.sid !== "string" || typeof payload.ch !== "string") return null;
    return { userId: payload.sub, sessionId: payload.sid, challenge: payload.ch, jti: payload.jti, exp: payload.exp };
  } catch {
    return null;
  }
}
