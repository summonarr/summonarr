import { createHash, timingSafeEqual } from "node:crypto";

// Constant-time string equality for a presented secret. Both sides are hashed
// first, so the compare takes the same time whatever their lengths (a raw
// timingSafeEqual throws on unequal lengths and so leaks the length).
export function safeCompareStrings(a: string, b: string): boolean {
  const ha = createHash("sha256").update(a).digest();
  const hb = createHash("sha256").update(b).digest();
  return timingSafeEqual(ha, hb);
}
