// Helpers for the Jellyfin notification-email verification flow.
//
// A Jellyfin account has no provider-verified email the way Plex/OIDC do, so to
// let such a user route notifications to an arbitrary address WITHOUT reopening
// the "redirect Summonarr's outbound mail at a victim" vector, we require
// proof-of-possession: a one-time token is mailed to the candidate address and
// the address is bound only after the link is clicked.
//
// Storage reuses the VerificationToken table left over from NextAuth
// ({ identifier, token @unique, expires }), so no schema change was needed:
//   identifier = "notif-email:<userId>:<normalizedEmail>"
//   token      = sha256(rawToken)   (raw token travels only in the emailed link)
//   expires    = now + TTL
//
// The helpers are pure (unit-tested). There is no "server-only" import because
// node:crypto is built into Node; only server routes import this module.
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

// Splits an identifier back into { userId, email }. userId is a cuid, which never
// contains ':', so the first ':' after the prefix separates the two. Returns null
// for anything that isn't one of our identifiers.
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
