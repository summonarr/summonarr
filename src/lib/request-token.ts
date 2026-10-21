import { purposeHmacHex, signingKey, verifyPurposeHmacHex } from "@/lib/signing-keys";

// HMAC'd with the "request-token" subkey (guardrail 6h), never the raw
// NEXTAUTH_SECRET the session JWT used to share; verified against the previous
// secret's subkey too during a rotation. A token issued before the key changed
// fails once (it lives at most two hours, and the iOS app fetches a fresh one
// for every request).

// Token is valid for up to 2 hours (current bucket + previous bucket); 1-hour granularity keeps it short-lived
function bucket(): number {
  return Math.floor(Date.now() / (3600 * 1000));
}

// Token is scoped to a single (tmdbId, mediaType, userId) tuple — cannot be reused for a different item or user
function message(tmdbId: number, mediaType: string, userId: string, timeBucket: number): string {
  return `req:${tmdbId}:${mediaType}:${userId}:${timeBucket}`;
}

export function generateRequestToken(tmdbId: number, mediaType: string, userId: string): string {
  return purposeHmacHex(signingKey("request-token"), message(tmdbId, mediaType, userId, bucket()));
}

export function verifyRequestToken(
  token: string,
  tmdbId: number,
  mediaType: string,
  userId: string,
): boolean {
  const b = bucket();
  return verifyPurposeHmacHex("request-token", message(tmdbId, mediaType, userId, b), token)
      || verifyPurposeHmacHex("request-token", message(tmdbId, mediaType, userId, b - 1), token);
}
