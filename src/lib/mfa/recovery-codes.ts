// One-time recovery codes — pure, node:crypto only.
//
// Each code carries 80 bits of entropy (16 symbols from a 32-symbol alphabet),
// so storing a plain SHA-256 of it is safe: a stolen table can't be brute-forced
// back to codes (2^80 guesses), and a per-row salt would buy nothing while
// making the single-use lookup slower. The plaintext is shown to the user once
// and never stored.

import { createHash, randomBytes, timingSafeEqual } from "node:crypto";

export const RECOVERY_CODE_COUNT = 10;

// 32 symbols, no I/O/0/1 — nothing a person can misread off a printout.
const ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
const CODE_SYMBOLS = 16;
const GROUP = 4;

// Draws 16 symbols from 10 random bytes (80 bits, 5 bits per symbol — no
// modulo bias because the alphabet is exactly 2^5).
export function generateRecoveryCode(): string {
  const bytes = randomBytes(10);
  let bits = 0;
  let value = 0;
  let raw = "";
  for (const byte of bytes) {
    value = ((value << 8) | byte) & 0xffff;
    bits += 8;
    while (bits >= 5) {
      raw += ALPHABET[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  const groups: string[] = [];
  for (let i = 0; i < CODE_SYMBOLS; i += GROUP) groups.push(raw.slice(i, i + GROUP));
  return groups.join("-");
}

export function generateRecoveryCodes(count = RECOVERY_CODE_COUNT): string[] {
  const out = new Set<string>();
  while (out.size < count) out.add(generateRecoveryCode());
  return [...out];
}

// Accepts any case, spaces and dashes; returns the bare 16-symbol form, or null
// when it can't be one of ours (so a TOTP code typed into the recovery field is
// rejected without a DB read).
export function normalizeRecoveryCode(input: string): string | null {
  const s = input.replace(/[\s-]/g, "").toUpperCase();
  if (s.length !== CODE_SYMBOLS) return null;
  for (const ch of s) if (!ALPHABET.includes(ch)) return null;
  return s;
}

// Domain-separated so the hash can't be confused with any other SHA-256 in the
// schema. Input must already be normalized.
export function hashRecoveryCode(normalized: string): string {
  return createHash("sha256").update(`summonarr-recovery:v1:${normalized}`).digest("hex");
}

// Constant-time hex-digest equality (both sides are fixed-length SHA-256 hex).
export function recoveryHashesEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a, "utf8");
  const bb = Buffer.from(b, "utf8");
  if (ab.length !== bb.length) return false;
  return timingSafeEqual(ab, bb);
}
