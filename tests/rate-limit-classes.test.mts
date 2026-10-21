// The protected rate-limit buckets (guardrail 6e) are split by KEY CLASS, and a
// full class refuses only its own new keys (F020).
//
// A full protected map refuses a NEW key rather than evict a live one. With all
// nine prefixes in one map, an anonymous flood of made-up emails or Jellyfin
// usernames filled it, and from then on a signed-in user could not revoke a
// session, step up, enable 2FA or change their password. `login-email:` and
// `jellyfin-user:` are each their own class; the user-id-keyed prefixes share a
// third.
//
// A full class can't be emptied in-process (its buckets live an hour), so the
// tests here run in order: the jellyfin-user fill, then the user-id fill. The
// login-email fill is the last protected test in tests/rate-limit.test.mts.
import { test } from "node:test";
import assert from "node:assert/strict";
import { checkRateLimit, peekRateLimit, recordFailure, reserveRateLimit } from "../src/lib/rate-limit.ts";

const WINDOW_MS = 3_600_000;
const CAP = 100_000;

const USER_ID_PREFIXES = [
  "mfa-user:",
  "profile-password:",
  "profile-delete:",
  "sessions-delete:",
  "mfa-stepup:",
  "mfa-totp-enable:",
  "step-up-pw:",
];

function assertAccepts(prefix: string): void {
  const id = Math.random();
  assert.equal(peekRateLimit(`${prefix}peek-${id}`, 10, WINDOW_MS), true, `${prefix} peek must see room`);
  assert.notEqual(reserveRateLimit(`${prefix}new-${id}`, 10, WINDOW_MS), null, `${prefix} must accept a new key`);
}

function assertRefuses(prefix: string): void {
  const id = Math.random();
  assert.equal(reserveRateLimit(`${prefix}new-${id}`, 10, WINDOW_MS), null, `${prefix} reserve must fail closed`);
  assert.equal(checkRateLimit(`${prefix}check-${id}`, 10, WINDOW_MS), false, `${prefix} check must fail closed`);
  assert.equal(peekRateLimit(`${prefix}peek-${id}`, 10, WINDOW_MS), false, `${prefix} peek must fail closed`);
  // recordFailure has nowhere to put the hit, so the key stays refused.
  recordFailure(`${prefix}fail-${id}`, WINDOW_MS);
  assert.equal(peekRateLimit(`${prefix}fail-${id}`, 10, WINDOW_MS), false);
}

test("a made-up-username flood that fills jellyfin-user: refuses only new Jellyfin usernames", () => {
  const victim = `jellyfin-user:victim-${Math.random()}`;
  for (let i = 0; i < 10; i++) assert.equal(checkRateLimit(victim, 10, WINDOW_MS), true);
  for (let i = 0; i < CAP; i++) checkRateLimit(`jellyfin-user:fill-${i}`, 10, WINDOW_MS);

  // Fail closed within the class, and the spent bucket was not evicted.
  assertRefuses("jellyfin-user:");
  assert.equal(checkRateLimit(victim, 10, WINDOW_MS), false, "a live bucket must never be evicted");

  // Local-password sign-in and every signed-in action still take new keys.
  assertAccepts("login-email:");
  for (const prefix of USER_ID_PREFIXES) assertAccepts(prefix);
  // The shared map is unaffected too.
  assert.equal(checkRateLimit(`register:${Math.random()}`, 5, WINDOW_MS), true);
});

test("the user-id-keyed prefixes share one class that fails closed and refuses no other class", () => {
  // Runs after the jellyfin-user fill above. Fill the class through a mix of its
  // prefixes: a newcomer of ANY of them is then refused, so they are one class.
  const victim = `step-up-pw:victim-${Math.random()}`;
  for (let i = 0; i < 5; i++) assert.equal(checkRateLimit(victim, 5, WINDOW_MS), true);
  for (let i = 0; i < CAP; i++) {
    const prefix = USER_ID_PREFIXES[i % USER_ID_PREFIXES.length];
    checkRateLimit(`${prefix}fill-${i}`, 10, WINDOW_MS);
  }

  for (const prefix of USER_ID_PREFIXES) assertRefuses(prefix);
  assert.equal(checkRateLimit(victim, 5, WINDOW_MS), false, "a live bucket must never be evicted");

  // Local-password sign-in still takes new keys.
  assertAccepts("login-email:");
});
