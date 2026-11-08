// Structural pin: a success path that refunds its reserved rate-limit hit must
// refund THAT hit (the timestamp reserveRateLimit returned), never "the newest".
// Under concurrency the newest hit can be another caller's failed attempt, and
// popping it refills an attacker's guess budget. The credentials path is pinned
// behaviourally in auth.test.mts; the MFA second step is pinned here.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const read = (p: string) => readFileSync(new URL(`../${p}`, import.meta.url), "utf8");

test("sign-in/mfa reserves with reserveRateLimit and refunds its own hit", () => {
  const src = read("src/app/api/auth/sign-in/mfa/route.ts");
  // Reserved for CODE methods only (guardrail 6e) — a passkey attempt reserves
  // nothing (0, which refundHit treats as "nothing to remove").
  assert.match(src, /const userHitAt = isCode \? reserveRateLimit\(userKey,[^;]*\) : 0;/);
  assert.match(src, /refundHit\(userKey, userHitAt\)/);
  assert.doesNotMatch(src, /refundHit\(userKey\)/, "a bare refundHit pops the newest hit");
});
