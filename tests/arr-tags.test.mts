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

test("trims a trailing hyphen left behind by the budget slice", () => {
  // idStub "abcdef01" (8 chars) leaves budget = 40 - 8 - 1 = 31; the slug
  // "xxx…xxx-tail" (30 x's + "-tail") slices to exactly 30 x's + "-", so the
  // trailing hyphen must be trimmed before the "-<idStub>" suffix is appended.
  // Without the trim the label would carry a double hyphen ("…xx--abcdef01").
  assert.equal(
    arrRequesterTagLabel("x".repeat(30) + " tail", null, "abcdef0123456789"),
    "x".repeat(30) + "-abcdef01",
  );
});

test("a userId that sanitizes to empty falls back to the 'user' stub", () => {
  // "!!!" strips to nothing, so idStub falls back to "user" — the label must
  // still be non-empty and carry a suffix, never end in a bare hyphen.
  assert.equal(arrRequesterTagLabel("Chris", null, "!!!"), "chris-user");
  // Name+email empty AND id empty: both fallbacks compose to "user-user".
  assert.equal(arrRequesterTagLabel(null, null, "!!!"), "user-user");
});

test("id stub is lowercased so the label round-trips through ARR's lowercase tags", () => {
  // ARR lowercases tag labels server-side; ensureArrTag re-finds by label, so
  // an uppercase userId must produce the same stub as its lowercase form.
  assert.equal(arrRequesterTagLabel("Chris", null, "ABCDEF0123456789"), "chris-abcdef01");
  assert.equal(
    arrRequesterTagLabel("Chris", null, "ABCDEF0123456789"),
    arrRequesterTagLabel("Chris", null, "abcdef0123456789"),
  );
});

test("an email without an '@' is used whole as the slug source", () => {
  // split("@")[0] on an at-less string returns the whole string — pin that.
  assert.equal(arrRequesterTagLabel(null, "justbob", "abcdef0123456789"), "justbob-abcdef01");
});

test("same name + ids sharing the first 8 sanitized chars DO collide (current behavior)", () => {
  // The disambiguation suffix is only the first 8 sanitized id chars, so two
  // users whose ids agree on that prefix collapse to one tag despite the
  // module comment's "never collapse" claim. Negligible for cuid-style ids
  // (random prefixes); pinned here as current behavior, not asserted away.
  const a = arrRequesterTagLabel("John Smith", null, "aaaaaaaa-111");
  const b = arrRequesterTagLabel("John Smith", null, "aaaaaaaa-222");
  assert.equal(a, "john-smith-aaaaaaaa");
  assert.equal(a, b);
});
