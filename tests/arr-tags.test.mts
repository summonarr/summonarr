// Unit tests for the Radarr/Sonarr requester tag label (src/lib/arr-tags.ts).
import { test } from "node:test";
import assert from "node:assert/strict";
import { arrRequesterTagLabel } from "../src/lib/arr-tags.ts";

test("prefers display name, sanitized to a lowercase slug with an id suffix", () => {
  assert.equal(arrRequesterTagLabel("Chris Burton", "c@example.com", "u_12345678"), "chris-burton-u1234567");
  assert.equal(arrRequesterTagLabel("Ünïcodé!! 42", null, "u_12345678"), "n-cod-42-u1234567");
});

test("falls back to the email local-part when name is blank", () => {
  assert.equal(arrRequesterTagLabel(null, "alice.smith@example.com", "u_12345678"), "alice-smith-u1234567");
  assert.equal(arrRequesterTagLabel("   ", "bob@example.com", "u_12345678"), "bob-u1234567");
});

test("two users with the same display name get distinct tags (id disambiguation)", () => {
  const a = arrRequesterTagLabel("John Smith", "john1@example.com", "aaaaaaaa11112222");
  const b = arrRequesterTagLabel("John Smith", "john2@example.com", "bbbbbbbb33334444");
  assert.notEqual(a, b);
  // Human-readable name portion is preserved in both.
  assert.equal(a.startsWith("john-smith-"), true);
  assert.equal(b.startsWith("john-smith-"), true);
});

test("falls back to a user-id stub when name and email are empty", () => {
  assert.equal(arrRequesterTagLabel(null, null, "abcdef0123456789"), "user-abcdef01");
  assert.equal(arrRequesterTagLabel("", "", "abcdef0123456789"), "user-abcdef01");
});

test("label is always non-empty and length-capped", () => {
  const long = "x".repeat(200);
  const label = arrRequesterTagLabel(long, null, "abcdef0123456789");
  assert.equal(label.length <= 40, true);
  assert.equal(label.length > 0, true);
  // A name that sanitizes to empty (all punctuation) still yields the id stub.
  assert.equal(arrRequesterTagLabel("!!!", null, "abcdef0123456789"), "user-abcdef01");
});
