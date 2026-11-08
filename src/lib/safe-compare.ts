import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";

// Constant-time string equality for a presented secret. Both sides are hashed
// first, so the compare takes the same time whatever their lengths (a raw
// timingSafeEqual throws on unequal lengths and so leaks the length).
// Keyed with a random per-process value: the digests only ever meet inside this
// call, so the key just makes them unpredictable to anyone timing the compare.
const COMPARE_KEY = randomBytes(32);

export function safeCompareStrings(a: string, b: string): boolean {
  const ha = createHmac("sha256", COMPARE_KEY).update(a).digest();
  const hb = createHmac("sha256", COMPARE_KEY).update(b).digest();
  return timingSafeEqual(ha, hb);
}
