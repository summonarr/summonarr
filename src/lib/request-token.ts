import { createHmac, timingSafeEqual } from "crypto";

function secret(): string {
  const s = process.env.NEXTAUTH_SECRET;
  if (!s) throw new Error("NEXTAUTH_SECRET is required for request signing");
  return s;
}

// Token is valid for up to 2 hours (current bucket + previous bucket); 1-hour granularity keeps it short-lived
function bucket(): number {
  return Math.floor(Date.now() / (3600 * 1000));
}

// Token is scoped to a single (tmdbId, mediaType, userId) tuple — cannot be reused for a different item or user
function sign(tmdbId: number, mediaType: string, userId: string, timeBucket: number): string {
  const payload = `req:${tmdbId}:${mediaType}:${userId}:${timeBucket}`;
  return createHmac("sha256", secret()).update(payload).digest("hex");
}

export function generateRequestToken(tmdbId: number, mediaType: string, userId: string): string {
  return sign(tmdbId, mediaType, userId, bucket());
}

function safeEqual(a: string, b: string): boolean {
  const bufA = Buffer.from(a, "hex");
  const bufB = Buffer.from(b, "hex");
  if (bufA.length !== bufB.length) return false;
  return timingSafeEqual(bufA, bufB);
}

export function verifyRequestToken(
  token: string,
  tmdbId: number,
  mediaType: string,
  userId: string,
): boolean {
  const b = bucket();
  return safeEqual(token, sign(tmdbId, mediaType, userId, b))
      || safeEqual(token, sign(tmdbId, mediaType, userId, b - 1));
}
