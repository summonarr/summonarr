// Short-lived, single-purpose tokens for the two-factor flows. Pure apart from
// an in-process nonce ledger; no DB.
//
// Three purposes, each with its OWN key, audience and JWT `typ`:
//   - "mfa-signin"       — handed out by the password step when the account has
//                          2FA; redeemed at POST /api/auth/sign-in/mfa.
//   - "passkey-register" — handed out by POST /api/profile/mfa/passkeys/options
//                          (after the enrollment step-up); redeemed when the new
//                          credential is posted back.
//   - "mfa-stepup"       — handed out by POST /api/profile/mfa/challenge; carries
//                          a fresh WebAuthn challenge so a PASSKEY can confirm an
//                          enrollment change (step-up.ts), bound to the session.
//
// NONE of these can ever be a session. The session JWT is HS256 over the raw
// NEXTAUTH_SECRET; these are HS256 over an HKDF-derived subkey (domain-separated
// by purpose), so verifySessionJwt rejects them on the signature alone — and
// they carry no `id`/`role` claims either, which verifySessionJwt also requires.
// Symmetrically, a session JWT (or the other purpose's token) fails here on the
// signature, the `typ` header and the audience. tests/mfa-token.test.mts pins
// every direction.
//
// Single use: each token's jti is registered in an in-process ledger when it is
// signed. A successful redemption CONSUMES it; a failed attempt counts against
// it and the token burns after MAX_TOKEN_FAILURES; an unknown jti is dead. The
// ledger is per-process like the rate limiter — Summonarr runs as one
// long-lived Node server (guardrail 17) — so a restart simply kills every
// in-flight token, which the 5-minute expiry makes harmless.

import { hkdfSync, randomBytes } from "node:crypto";
import { SignJWT, jwtVerify } from "jose";
import { processSingleton } from "@/lib/process-singleton";

export const MFA_TOKEN_TTL_SECONDS = 5 * 60;
export const MAX_TOKEN_FAILURES = 5;

type Purpose = "mfa-signin" | "passkey-register" | "mfa-stepup";

const AUDIENCE: Record<Purpose, string> = {
  "mfa-signin": "summonarr:mfa-signin",
  "passkey-register": "summonarr:passkey-register",
  "mfa-stepup": "summonarr:mfa-stepup",
};
const TYP: Record<Purpose, string> = {
  "mfa-signin": "summonarr-mfa+jwt",
  "passkey-register": "summonarr-passkey-reg+jwt",
  "mfa-stepup": "summonarr-mfa-stepup+jwt",
};

function keyFor(purpose: Purpose): Uint8Array {
  const secret = process.env.NEXTAUTH_SECRET;
  if (!secret) throw new Error("[mfa-token] NEXTAUTH_SECRET must be set");
  return new Uint8Array(hkdfSync("sha256", secret, "summonarr-mfa-token", `summonarr:${purpose}:v1`, 32));
}

// ─── nonce ledger ───────────────────────────────────────────────────────────
//
// Every token is REGISTERED when it is signed, keyed by jti and tagged with its
// subject (the user id). A jti the ledger doesn't know is DEAD — so a restart
// kills every in-flight token (acceptable: they live five minutes) and an
// evicted entry can never be "un-burned" by being recreated fresh.
//
// Bounds (guardrail 6d): at most MAX_LIVE_PER_SUBJECT live tokens per user —
// minting a new one evicts that user's oldest — and MAX_LEDGER overall, where
// a full ledger evicts expired entries first, then the oldest live one. The
// old shape refused EVERY newcomer once the ledger held 50k live entries, so
// one account (its own password, many IPs) could block all MFA sign-ins; now
// the most it can fill is its own five slots.
//
// Redemption is reserve → verify → commit/release. reserveToken is a
// synchronous check-and-set (no await between the read and the write), so two
// parallel requests on one token can never BOTH reach the factor verifier —
// which used to let a pair of requests burn two recovery codes for one sign-in.

interface LedgerEntry {
  sub: string;
  expiresAt: number; // ms
  failures: number;
  consumed: boolean;
  // A request holding this token is verifying its factor right now.
  inFlight: boolean;
}

export const MAX_LEDGER = 50_000;
let ledgerCap = MAX_LEDGER;
export const MAX_LIVE_PER_SUBJECT = 5;
const ledger = processSingleton("mfa-token:ledger", () => new Map<string, LedgerEntry>());
// jti list per subject, in mint order (oldest first).
const bySubject = processSingleton("mfa-token:by-subject", () => new Map<string, string[]>());

function removeEntry(jti: string): void {
  const entry = ledger.get(jti);
  if (!entry) return;
  ledger.delete(jti);
  const list = bySubject.get(entry.sub);
  if (!list) return;
  const next = list.filter((j) => j !== jti);
  if (next.length === 0) bySubject.delete(entry.sub);
  else bySubject.set(entry.sub, next);
}

function sweepExpired(now: number): void {
  for (const [jti, entry] of ledger) if (entry.expiresAt <= now) removeEntry(jti);
}

// Called by every sign* function below, at mint time.
function registerToken(jti: string, sub: string, expSec: number): void {
  const now = Date.now();
  const mine = (bySubject.get(sub) ?? []).filter((j) => {
    const e = ledger.get(j);
    if (!e || e.expiresAt <= now) {
      removeEntry(j);
      return false;
    }
    return true;
  });
  // Per-subject cap: the newest token wins, the subject's oldest dies.
  while (mine.length >= MAX_LIVE_PER_SUBJECT) removeEntry(mine.shift()!);
  if (ledger.size >= ledgerCap) sweepExpired(now);
  // Still full of live entries: evict the oldest overall (Map iteration is
  // insertion order). An evicted token is dead, never fresh again.
  while (ledger.size >= ledgerCap) {
    const oldest = ledger.keys().next().value as string | undefined;
    if (oldest === undefined) break;
    removeEntry(oldest);
  }
  ledger.set(jti, { sub, expiresAt: expSec * 1000, failures: 0, consumed: false, inFlight: false });
  const list = bySubject.get(sub) ?? [];
  list.push(jti);
  bySubject.set(sub, list.filter((j) => ledger.has(j)));
}

function liveEntry(jti: string): LedgerEntry | null {
  const entry = ledger.get(jti);
  if (!entry) return null;
  if (entry.expiresAt <= Date.now()) {
    removeEntry(jti);
    return null;
  }
  return entry;
}

// True when the token can still be attempted (known, unexpired, not consumed,
// not burned). A token another request is verifying right now is still
// "usable" — reserveToken is what arbitrates between them.
export function isTokenUsable(jti: string): boolean {
  const e = liveEntry(jti);
  return !!e && !e.consumed && e.failures < MAX_TOKEN_FAILURES;
}

// Claims the token for ONE verification attempt. False when it is unknown,
// expired, consumed, burned, or another request already holds it.
export function reserveToken(jti: string): boolean {
  const e = liveEntry(jti);
  if (!e || e.consumed || e.failures >= MAX_TOKEN_FAILURES || e.inFlight) return false;
  e.inFlight = true;
  return true;
}

// Ends a reservation without redeeming. `failed: true` counts a wrong answer
// (the increment is synchronous, so concurrent failures can't be lost).
// Returns the failures so far.
export function releaseToken(jti: string, opts: { failed: boolean }): number {
  const e = ledger.get(jti);
  if (!e) return MAX_TOKEN_FAILURES;
  e.inFlight = false;
  if (opts.failed) e.failures += 1;
  return e.failures;
}

// Redeems a reserved token. False if it was evicted meanwhile — refuse then.
export function commitToken(jti: string): boolean {
  const e = ledger.get(jti);
  if (!e || !e.inFlight) return false;
  e.inFlight = false;
  e.consumed = true;
  return true;
}

// Reserve + commit in one step, for flows whose verification already ran.
export function consumeToken(jti: string): boolean {
  return reserveToken(jti) && commitToken(jti);
}

// Records a failed attempt outside a reservation; returns the failures so far.
export function recordTokenFailure(jti: string): number {
  const e = ledger.get(jti);
  if (!e) return MAX_TOKEN_FAILURES;
  e.failures += 1;
  return e.failures;
}

// Test seams only.
export function resetMfaTokenLedgerForTests(cap = MAX_LEDGER): void {
  ledger.clear();
  bySubject.clear();
  ledgerCap = cap;
}
export function mfaTokenLedgerSizeForTests(): { total: number; forSubject: (sub: string) => number } {
  return { total: ledger.size, forSubject: (sub) => (bySubject.get(sub) ?? []).filter((j) => liveEntry(j)).length };
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
  registerToken(jti, input.userId, exp);
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
  // Whether the options step verified a second factor (true) or the account
  // had none yet (false). A registration whose token says false is refused if
  // the account has gained a factor since — otherwise a token minted on the
  // password alone could add a passkey to an account that now has 2FA.
  factorVerified: boolean;
  jti: string;
  exp: number;
}

export async function signPasskeyRegisterToken(input: { userId: string; sessionId: string; challenge: string; factorVerified: boolean }): Promise<{ token: string; jti: string; exp: number }> {
  const now = Math.floor(Date.now() / 1000);
  const exp = now + MFA_TOKEN_TTL_SECONDS;
  const jti = randomBytes(16).toString("base64url");
  const token = await new SignJWT({ sid: input.sessionId, ch: input.challenge, fv: input.factorVerified })
    .setProtectedHeader({ alg: "HS256", typ: TYP["passkey-register"] })
    .setSubject(input.userId)
    .setAudience(AUDIENCE["passkey-register"])
    .setJti(jti)
    .setIssuedAt(now)
    .setExpirationTime(exp)
    .sign(keyFor("passkey-register"));
  registerToken(jti, input.userId, exp);
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
    if (typeof payload.sid !== "string" || typeof payload.ch !== "string" || typeof payload.fv !== "boolean") return null;
    return {
      userId: payload.sub,
      sessionId: payload.sid,
      challenge: payload.ch,
      factorVerified: payload.fv,
      jti: payload.jti,
      exp: payload.exp,
    };
  } catch {
    return null;
  }
}

// ─── enrollment step-up passkey challenge ───────────────────────────────────

export interface MfaStepUpClaims {
  userId: string;
  // The session that asked for the challenge; the assertion must come back on
  // that same session.
  sessionId: string;
  challenge: string; // base64url
  jti: string;
  exp: number;
}

export async function signMfaStepUpToken(input: { userId: string; sessionId: string; challenge: string }): Promise<{ token: string; jti: string; exp: number }> {
  const now = Math.floor(Date.now() / 1000);
  const exp = now + MFA_TOKEN_TTL_SECONDS;
  const jti = randomBytes(16).toString("base64url");
  const token = await new SignJWT({ sid: input.sessionId, ch: input.challenge })
    .setProtectedHeader({ alg: "HS256", typ: TYP["mfa-stepup"] })
    .setSubject(input.userId)
    .setAudience(AUDIENCE["mfa-stepup"])
    .setJti(jti)
    .setIssuedAt(now)
    .setExpirationTime(exp)
    .sign(keyFor("mfa-stepup"));
  registerToken(jti, input.userId, exp);
  return { token, jti, exp };
}

export async function verifyMfaStepUpToken(token: unknown): Promise<MfaStepUpClaims | null> {
  if (typeof token !== "string" || token.length === 0 || token.length > 4096) return null;
  try {
    const { payload, protectedHeader } = await jwtVerify(token, keyFor("mfa-stepup"), {
      algorithms: ["HS256"],
      audience: AUDIENCE["mfa-stepup"],
      typ: TYP["mfa-stepup"],
    });
    if (protectedHeader.typ !== TYP["mfa-stepup"]) return null;
    if (typeof payload.sub !== "string" || typeof payload.jti !== "string" || typeof payload.exp !== "number") return null;
    if (typeof payload.sid !== "string" || typeof payload.ch !== "string") return null;
    return { userId: payload.sub, sessionId: payload.sid, challenge: payload.ch, jti: payload.jti, exp: payload.exp };
  } catch {
    return null;
  }
}
