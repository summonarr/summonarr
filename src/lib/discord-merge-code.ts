// The 12-character code POST /api/discord/initiate-merge sends by Discord DM and
// POST /api/discord/confirm-merge redeems (the iOS app's Discord flow, and the
// web's "link by Discord id").
//
// For its 10 minutes the pending row is a credential — redeeming it links that
// Discord account to the user, and the link survives a password change
// (guardrail 6g) — and it lands in every backup. So the row stores an HMAC of
// the code, never the code. Not a plain SHA-256 like the /link token
// (discord-link-token.ts): this code carries only 48 bits, few enough that a
// hash read from the database or a backup could be brute-forced offline inside
// the window. The HMAC is keyed by a NEXTAUTH_SECRET subkey (signing-keys.ts),
// which neither the database nor a backup holds.
//
// The MAC binds the user and the Discord id the code was sent to, so a row
// whose discordId was changed by anything but initiate-merge no longer matches.
// It verifies under NEXTAUTH_SECRET_PREVIOUS too, so a rotation doesn't strand a
// code in flight.
//
// A row written before this shipped holds the plaintext code, which is not a
// MAC. confirm-merge treats it as expired: it deletes the row and tells the user
// to request a new code. That costs one resend; accepting the plaintext would
// keep a path where a stored value is the credential.

import { randomBytes } from "node:crypto";
import { purposeHmacHex, signingKey, verifyPurposeHmacHex } from "@/lib/signing-keys";

const PURPOSE = "discord-merge-code" as const;

function macMessage(userId: string, discordId: string, code: string): string {
  return `discord-merge:v1:${userId}:${discordId}:${code}`;
}

/** 6 random bytes as uppercase hex, plus the MAC to store in its place. */
export function generateDiscordMergeCode(userId: string, discordId: string): { code: string; codeMac: string } {
  const code = randomBytes(6).toString("hex").toUpperCase();
  return { code, codeMac: discordMergeCodeMac(userId, discordId, code) };
}

/** The MAC stored for `code`, under the CURRENT key. */
export function discordMergeCodeMac(userId: string, discordId: string, code: string): string {
  return purposeHmacHex(signingKey(PURPOSE), macMessage(userId, discordId, code));
}

/** What confirm-merge compares: the typed code with stray spaces and case removed. */
export function normalizeDiscordMergeCode(input: string): string {
  return input.trim().toUpperCase();
}

/** True when `stored` is a MAC at all — false for a pre-upgrade plaintext row. */
export function isDiscordMergeCodeMac(stored: string): boolean {
  return /^[0-9a-f]{64}$/.test(stored);
}

/**
 * Constant-time check of a typed (normalized) code against the stored MAC, under
 * the current and the previous key.
 */
export function discordMergeCodeMatches(stored: string, userId: string, discordId: string, code: string): boolean {
  return verifyPurposeHmacHex(PURPOSE, macMessage(userId, discordId, code), stored);
}
