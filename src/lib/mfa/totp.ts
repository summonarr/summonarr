// RFC 4226 (HOTP) / RFC 6238 (TOTP) — pure, node:crypto only, no DB.
//
// The authenticator-app second factor for local-credentials sign-in. Every
// comparison against a candidate code is constant-time over the WHOLE window:
// verifyTotp computes and compares all 2*window+1 steps and only then decides,
// so response timing doesn't reveal which step (if any) matched.
//
// Replay protection is the caller's job, with the step this returns: the DB
// stores the highest step ever accepted (UserTotp.lastUsedStep) and accepts a
// code only for a STRICTLY greater step, as a compare-and-swap — see
// verifyTotpForUser in mfa-store.ts. verifyTotp also refuses a step at or below
// a supplied lastUsedStep so a pure caller can't forget it.

import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";

export const TOTP_PERIOD_SECONDS = 30;
export const TOTP_DIGITS = 6;
// ±1 step (±30 s) of clock drift, the RFC 6238 §5.2 recommendation.
export const TOTP_WINDOW = 1;
// 160-bit secret — the RFC 4226 §4 recommended key length for HMAC-SHA1.
export const TOTP_SECRET_BYTES = 20;
export const TOTP_ISSUER = "Summonarr";

export type TotpAlgorithm = "sha1" | "sha256" | "sha512";

const B32_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";

// RFC 4648 base32, no padding — the form every authenticator app accepts in an
// otpauth:// URI.
export function base32Encode(bytes: Uint8Array): string {
  let out = "";
  let bits = 0;
  let value = 0;
  for (const byte of bytes) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      out += B32_ALPHABET[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += B32_ALPHABET[(value << (5 - bits)) & 31];
  return out;
}

// Tolerant of case, spaces and trailing "=" padding (people paste secrets);
// strict about everything else. Returns null on any character outside the
// alphabet, on a length no encoder can produce, or on non-zero trailing bits.
export function base32Decode(input: string): Buffer | null {
  const s = input.replace(/[\s=]/g, "").toUpperCase();
  if (s.length === 0) return null;
  // Valid unpadded lengths mod 8 are 0, 2, 4, 5, 7.
  if (![0, 2, 4, 5, 7].includes(s.length % 8)) return null;
  const out: number[] = [];
  let bits = 0;
  let value = 0;
  for (const ch of s) {
    const idx = B32_ALPHABET.indexOf(ch);
    if (idx === -1) return null;
    value = (value << 5) | idx;
    bits += 5;
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 0xff);
      bits -= 8;
    }
    value &= 0xff; // keep the accumulator small; only the low `bits` matter
  }
  if (bits > 0 && (value & ((1 << bits) - 1)) !== 0) return null;
  return Buffer.from(out);
}

export function generateTotpSecret(): string {
  return base32Encode(randomBytes(TOTP_SECRET_BYTES));
}

// RFC 4226 §5.3: HMAC over the 8-byte big-endian counter, dynamic truncation,
// modulo 10^digits, zero-padded.
export function hotp(key: Uint8Array, counter: number, digits = TOTP_DIGITS, algorithm: TotpAlgorithm = "sha1"): string {
  if (!Number.isSafeInteger(counter) || counter < 0) throw new RangeError("HOTP counter must be a non-negative safe integer");
  const msg = Buffer.alloc(8);
  msg.writeBigUInt64BE(BigInt(counter));
  const mac = createHmac(algorithm, key).update(msg).digest();
  const offset = mac[mac.length - 1] & 0x0f;
  const binary =
    ((mac[offset] & 0x7f) << 24) |
    (mac[offset + 1] << 16) |
    (mac[offset + 2] << 8) |
    mac[offset + 3];
  return String(binary % 10 ** digits).padStart(digits, "0");
}

export function totpStep(nowMs: number, period = TOTP_PERIOD_SECONDS): number {
  return Math.floor(nowMs / 1000 / period);
}

// The code for an absolute time — used by tests (RFC 6238 Appendix B vectors)
// and by nothing that accepts input.
export function totpAt(key: Uint8Array, nowMs: number, opts: { digits?: number; algorithm?: TotpAlgorithm; period?: number } = {}): string {
  return hotp(key, totpStep(nowMs, opts.period), opts.digits, opts.algorithm);
}

export type TotpVerdict =
  | { ok: true; step: number }
  | { ok: false; reason: "format" | "secret" | "mismatch" | "replay" };

// Normalizes what a person types ("123 456", "123-456") to bare digits.
export function normalizeTotpCode(code: string): string {
  return code.replace(/[\s-]/g, "");
}

export function verifyTotp(
  secretBase32: string,
  code: string,
  opts: { nowMs: number; lastUsedStep?: number | null; window?: number },
): TotpVerdict {
  const normalized = normalizeTotpCode(code);
  if (!new RegExp(`^\\d{${TOTP_DIGITS}}$`).test(normalized)) return { ok: false, reason: "format" };
  const key = base32Decode(secretBase32);
  if (!key || key.length === 0) return { ok: false, reason: "secret" };
  const window = opts.window ?? TOTP_WINDOW;
  const current = totpStep(opts.nowMs);
  const candidate = Buffer.from(normalized, "utf8");
  let matched = -1;
  // Every step in the window is computed and compared — no early exit — so the
  // time taken doesn't depend on which step matched.
  for (let step = current - window; step <= current + window; step++) {
    if (step < 0) continue;
    const expected = Buffer.from(hotp(key, step), "utf8");
    const equal = timingSafeEqual(expected, candidate);
    if (equal && matched === -1) matched = step;
  }
  if (matched === -1) return { ok: false, reason: "mismatch" };
  if (opts.lastUsedStep != null && matched <= opts.lastUsedStep) return { ok: false, reason: "replay" };
  return { ok: true, step: matched };
}

// otpauth://totp/<issuer>:<account>?secret=…&issuer=… — the Key URI Format the
// authenticator apps (Google Authenticator, 1Password, Aegis, …) consume. The
// parameters are the RFC 6238 defaults, spelled out so an app that guesses
// differently can't silently disagree.
export function buildOtpauthUri(opts: { secret: string; accountName: string; issuer?: string }): string {
  const issuer = opts.issuer ?? TOTP_ISSUER;
  const label = `${encodeURIComponent(issuer)}:${encodeURIComponent(opts.accountName)}`;
  const params = new URLSearchParams({
    secret: opts.secret,
    issuer,
    algorithm: "SHA1",
    digits: String(TOTP_DIGITS),
    period: String(TOTP_PERIOD_SECONDS),
  });
  return `otpauth://totp/${label}?${params.toString()}`;
}
