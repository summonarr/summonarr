// Unit tests for the shared 429 helper (src/lib/http.ts). Rate-limited routes
// all funnel through tooManyRequests(); the Retry-After header must stay
// spec-compliant (an integer number of seconds, RFC 9110 §10.2.3) or
// well-behaved clients mis-parse the backoff hint — so fractional windows are
// floored and the value is clamped to a minimum of 1 second (Retry-After: 0
// would invite an immediate retry loop).
import { test } from "node:test";
import assert from "node:assert/strict";
import { tooManyRequests } from "../src/lib/http.ts";

test("defaults: 429 JSON with Retry-After 60 and the standard message", async () => {
  const res = tooManyRequests();
  assert.equal(res.status, 429);
  assert.equal(res.headers.get("retry-after"), "60");
  assert.match(res.headers.get("content-type") ?? "", /application\/json/);
  assert.deepEqual(await res.json(), { error: "Too many requests — try again later." });
});

test("custom window and message flow through verbatim", async () => {
  const res = tooManyRequests(300, "Slow down.");
  assert.equal(res.status, 429);
  assert.equal(res.headers.get("retry-after"), "300");
  assert.deepEqual(await res.json(), { error: "Slow down." });
});

test("fractional seconds are floored to an integer (spec-compliant Retry-After)", () => {
  assert.equal(tooManyRequests(90.7).headers.get("retry-after"), "90");
  assert.equal(tooManyRequests(59.999).headers.get("retry-after"), "59");
});

test("zero, negative, and sub-second windows all clamp to a 1-second floor", () => {
  assert.equal(tooManyRequests(0).headers.get("retry-after"), "1");
  assert.equal(tooManyRequests(-5).headers.get("retry-after"), "1");
  assert.equal(tooManyRequests(0.4).headers.get("retry-after"), "1");
  assert.equal(tooManyRequests(1).headers.get("retry-after"), "1");
});
