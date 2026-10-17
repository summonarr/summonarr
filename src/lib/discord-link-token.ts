// The one-time code that links a Discord account to a Summonarr account.
//
// POST /api/discord/generate-link mints it and shows it once; the user types it
// into Discord's /link command (interactions/route.ts) within 10 minutes. For
// those 10 minutes the row is a live credential — redeeming it lets a Discord
// account request, report issues and (for a request manager) approve AS the
// user — and it also lands in every backup.
//
// So only a SHA-256 hash is stored, in `DiscordLinkToken.token`, the way the
// notification-email verify token is stored in `VerificationToken.token` and the
// calendar feed token in `User.calendarTokenHash`. /link hashes what it is
// handed and looks the row up by that, so a value read out of the database or a
// backup file cannot be redeemed. The code carries 128 bits of entropy, so an
// unsalted SHA-256 is not brute-forceable.
//
// Codes minted before this shipped hold their plaintext in that column. They are
// deliberately NOT accepted: /link never looks a row up by the code itself (that
// lookup is exactly what would let a stored hash be redeemed), so such a code
// answers "invalid" once and the user generates a new one. They expire within 10
// minutes of the upgrade, and the purge-auth-sessions cron sweeps the rows.

import { createHash, randomBytes } from "node:crypto";

/** 16 random bytes as uppercase hex — the 32-character code the user types. */
export function generateDiscordLinkToken(): { token: string; tokenHash: string } {
  const token = randomBytes(16).toString("hex").toUpperCase();
  return { token, tokenHash: hashDiscordLinkToken(token) };
}

/** What /link compares: the typed code with stray spaces and case removed. */
export function normalizeDiscordLinkToken(input: string): string {
  return input.trim().toUpperCase();
}

const TOKEN_RE = /^[0-9A-F]{32}$/;

/**
 * Shape check run BEFORE any DB read, on a normalized code, so a typo or a
 * guess never costs a query. Exactly the shape generateDiscordLinkToken
 * produces — which a 64-character stored hash is not.
 */
export function isWellFormedDiscordLinkToken(token: string): boolean {
  return TOKEN_RE.test(token);
}

/** Hex SHA-256 of a normalized code — the only form ever stored. */
export function hashDiscordLinkToken(token: string): string {
  return createHash("sha256").update(token, "utf8").digest("hex");
}
