// Unit tests for src/lib/session-lifetime.ts — the never-expires sentinel a
// native (iOS) session carries as its deadline (guardrail 6c) and the
// predicate the device list uses to render it as "Never expires".
//
// The sentinel is load-bearing in three places that all expect a real
// number/date — the JWT `exp`, the non-null AuthSession.expiresAt column, and
// the /api/sessions wire contract the iOS app decodes as a non-optional string —
// so these pins guard its SHAPE: a finite, far-future, second-aligned instant
// that survives every representation it travels in.
import { test } from "node:test";
import assert from "node:assert/strict";

import {
  NEVER_EXPIRES_AT_MS,
  NEVER_EXPIRES_AT_SEC,
  isIndefiniteDeadline,
} from "../src/lib/session-lifetime.ts";

const DAY_MS = 86_400_000;

test("the sentinel is a finite far-future instant, second-aligned, and the two units agree", () => {
  assert.ok(Number.isSafeInteger(NEVER_EXPIRES_AT_MS));
  assert.ok(Number.isSafeInteger(NEVER_EXPIRES_AT_SEC));
  assert.equal(NEVER_EXPIRES_AT_SEC * 1000, NEVER_EXPIRES_AT_MS, "a JWT exp in seconds must round-trip to the Date exactly");
  // Far enough out that no configured duration (capped at 90d) or clock skew can
  // reach it, yet representable everywhere it is stored: JS Date, a Postgres
  // timestamp(3), and an ISO string.
  assert.equal(new Date(NEVER_EXPIRES_AT_MS).getUTCFullYear(), 9999);
  assert.equal(new Date(NEVER_EXPIRES_AT_MS).toISOString(), "9999-01-01T00:00:00.000Z");
  assert.ok(NEVER_EXPIRES_AT_MS > Date.now() + 200 * 365 * DAY_MS);
});

test("isIndefiniteDeadline recognises the sentinel in every shape the deadline travels in", () => {
  // Epoch seconds (the JWT claim), a Date (the Prisma row), an ISO string (a
  // Date after crossing the RSC / JSON boundary).
  assert.equal(isIndefiniteDeadline(NEVER_EXPIRES_AT_SEC), true);
  assert.equal(isIndefiniteDeadline(new Date(NEVER_EXPIRES_AT_MS)), true);
  assert.equal(isIndefiniteDeadline(new Date(NEVER_EXPIRES_AT_MS).toISOString()), true);
  // Defensive: anything PAST the sentinel is indefinite too.
  assert.equal(isIndefiniteDeadline(NEVER_EXPIRES_AT_SEC + 1), true);
});

test("isIndefiniteDeadline is false for every real deadline — including the 90-day configuration ceiling — and for garbage", () => {
  const ninetyDaysOut = Date.now() + 90 * DAY_MS;
  assert.equal(isIndefiniteDeadline(Math.floor(ninetyDaysOut / 1000)), false);
  assert.equal(isIndefiniteDeadline(new Date(ninetyDaysOut)), false);
  assert.equal(isIndefiniteDeadline(new Date(ninetyDaysOut).toISOString()), false);
  // One second short of the sentinel is still a (theoretical) real deadline.
  assert.equal(isIndefiniteDeadline(NEVER_EXPIRES_AT_SEC - 1), false);
  // Unparseable input must never read as "never expires" — that would hide a
  // broken row behind a reassuring label.
  assert.equal(isIndefiniteDeadline("not a date"), false);
  assert.equal(isIndefiniteDeadline(Number.NaN), false);
  assert.equal(isIndefiniteDeadline(new Date(Number.NaN)), false);
});
