// Helpers for the Jellyfin notification-email verification flow (2.2).
//
// A Jellyfin account has no provider-verified email the way Plex/OIDC do, so to
// let such a user route notifications to an arbitrary address WITHOUT reopening
// the "redirect Summonarr's outbound mail at a victim" vector, we require
// proof-of-possession: a one-time token is mailed to the candidate address and
// the address is bound only after the link is clicked.
//
// Storage reuses the (otherwise-dead, NextAuth-legacy) VerificationToken model —
// { identifier, token @unique, expires } — so no schema migration is needed:
//   identifier = "notif-email:<userId>:<normalizedEmail>"
//   token      = sha256(rawToken)   (raw token travels only in the emailed link)
//   expires    = now + TTL
//
// The identifier helpers are pure (unit-tested). node:crypto is a builtin, so no
// "server-only" pin is needed; the module is only imported by server routes.
import { createHash, randomBytes } from "node:crypto";

export const VERIFY_TTL_MS = 30 * 60 * 1000; // 30 minutes
const IDENTIFIER_PREFIX = "notif-email:";

export function generateVerifyToken(): { raw: string; hash: string } {
  const raw = randomBytes(32).toString("hex");
  return { raw, hash: hashVerifyToken(raw) };
}

// Store/look up the HASH so a DB leak can't yield a usable verification link.
export function hashVerifyToken(raw: string): string {
  return createHash("sha256").update(raw).digest("hex");
}

export function buildVerifyIdentifier(userId: string, email: string): string {
  return `${IDENTIFIER_PREFIX}${userId}:${email}`;
}

// Prefix for deleting a user's outstanding verification tokens (one pending at a time).
export function verifyIdentifierPrefixFor(userId: string): string {
  return `${IDENTIFIER_PREFIX}${userId}:`;
}

// userId is a cuid (no ':'); the first ':' after the prefix splits it from the
// email, and the remainder is the (normalized, colon-free) email.
export function parseVerifyIdentifier(identifier: string): { userId: string; email: string } | null {
  if (!identifier.startsWith(IDENTIFIER_PREFIX)) return null;
  const rest = identifier.slice(IDENTIFIER_PREFIX.length);
  const sep = rest.indexOf(":");
  if (sep <= 0) return null;
  const userId = rest.slice(0, sep);
  const email = rest.slice(sep + 1);
  if (!userId || !email) return null;
  return { userId, email };
}
