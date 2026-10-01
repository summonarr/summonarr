// Secret for the personal iCal feed URL (/api/calendar/feed/<token>.ics).
//
// Calendar apps (Google, Apple, Outlook) poll a bare URL: no cookie, no header,
// so the URL is the credential. Storage mirrors the webhook secrets (guardrail 2)
// and the notification-email verify token: only a SHA-256 hash is persisted
// (`User.calendarTokenHash`), the comparison is timing-safe, and the plaintext
// exists only in the response that generated it.
//
// Hash-only (rather than encrypted-at-rest) is deliberate: the profile page
// cannot show an existing URL again, only replace it. That costs one click when
// the user loses the URL, and buys that a DB read or a backup file can never be
// turned back into a working feed URL. The token carries 256 bits of entropy,
// so an unsalted SHA-256 is not brute-forceable.

import { createHash, randomBytes, timingSafeEqual } from "node:crypto";

/** 32 random bytes, base64url — 43 characters, URL- and filename-safe. */
export function generateCalendarToken(): string {
  return randomBytes(32).toString("base64url");
}

/** Hex SHA-256 of the plaintext token — the only form ever stored. */
export function hashCalendarToken(token: string): string {
  return createHash("sha256").update(token, "utf8").digest("hex");
}

const TOKEN_RE = /^[A-Za-z0-9_-]{43}$/;

/**
 * Cheap shape check run BEFORE any DB read, so a scanner's garbage never costs a
 * query. Exactly the shape generateCalendarToken produces.
 */
export function isWellFormedCalendarToken(token: string): boolean {
  return TOKEN_RE.test(token);
}

/**
 * Timing-safe check of a presented token against a stored hash. The route looks
 * the row up BY hash (a unique index), so this is a second, constant-time
 * confirmation that the row it found is the one the token names.
 */
export function calendarTokenMatches(storedHash: string | null | undefined, token: string): boolean {
  if (!storedHash) return false;
  const a = Buffer.from(hashCalendarToken(token), "hex");
  const b = Buffer.from(storedHash, "hex");
  if (a.length !== b.length || a.length !== 32) return false;
  return timingSafeEqual(a, b);
}

/**
 * Pull the token out of the feed URL's final path segment. `<token>.ics` is the
 * documented form (some clients refuse a subscription URL without the suffix);
 * the bare token is accepted too.
 */
export function tokenFromFeedSegment(segment: string): string {
  let s = segment;
  try {
    s = decodeURIComponent(segment);
  } catch {
    return "";
  }
  return s.toLowerCase().endsWith(".ics") ? s.slice(0, -4) : s;
}
