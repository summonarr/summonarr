// Unit tests for the Jellyfin notification-email verification helpers
// (src/lib/notification-email-verify.ts). The identifier round-trip and the
// per-user prefix are security-relevant (they scope which account a confirmed
// link binds to), so they're covered here.
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  buildVerifyIdentifier,
  parseVerifyIdentifier,
  verifyIdentifierPrefixFor,
  hashVerifyToken,
  generateVerifyToken,
} from "../src/lib/notification-email-verify.ts";

test("identifier round-trips userId + email", () => {
  const id = buildVerifyIdentifier("u_abc123", "jane.doe@example.com");
  assert.deepEqual(parseVerifyIdentifier(id), { userId: "u_abc123", email: "jane.doe@example.com" });
});

test("parseVerifyIdentifier rejects foreign / malformed identifiers", () => {
  assert.equal(parseVerifyIdentifier("other:u:e@x.co"), null); // wrong prefix
  assert.equal(parseVerifyIdentifier("notif-email:onlyuserid"), null); // no email separator
  assert.equal(parseVerifyIdentifier("notif-email::e@x.co"), null); // empty userId
});

test("per-user prefix matches only that user's identifiers", () => {
  const prefix = verifyIdentifierPrefixFor("u_abc123");
  assert.equal(buildVerifyIdentifier("u_abc123", "a@b.co").startsWith(prefix), true);
  assert.equal(buildVerifyIdentifier("u_other", "a@b.co").startsWith(prefix), false);
});

test("prefix does not match a longer userId sharing the same leading chars", () => {
  // The trailing ':' in verifyIdentifierPrefixFor is load-bearing: without it,
  // deleting "u_abc"'s pending tokens by prefix would also delete "u_abc123"'s.
  const shortUserPrefix = verifyIdentifierPrefixFor("u_abc");
  assert.equal(buildVerifyIdentifier("u_abc123", "a@b.co").startsWith(shortUserPrefix), false);
  assert.equal(buildVerifyIdentifier("u_abc", "a@b.co").startsWith(shortUserPrefix), true);
});

test("parseVerifyIdentifier rejects an empty email after the separator", () => {
  assert.equal(parseVerifyIdentifier("notif-email:uid:"), null);
});

test("identifier round-trips an email containing a colon (split on FIRST colon)", () => {
  // parseVerifyIdentifier splits userId from email at the first ':' after the
  // prefix (userId is a cuid, which never contains ':'); everything after it —
  // colons included — is the email.
  const id = buildVerifyIdentifier("uid", "a:b@x.co");
  assert.deepEqual(parseVerifyIdentifier(id), { userId: "uid", email: "a:b@x.co" });
});

test("generateVerifyToken returns a fresh random token on every call", () => {
  // A regression to a constant/reused token would break the proof-of-possession
  // guarantee entirely (any prior link would verify any address).
  const a = generateVerifyToken();
  const b = generateVerifyToken();
  assert.notEqual(a.raw, b.raw);
  assert.notEqual(a.hash, b.hash);
});

test("hashVerifyToken is deterministic; generateVerifyToken hashes its own raw", () => {
  assert.equal(hashVerifyToken("abc"), hashVerifyToken("abc"));
  assert.notEqual(hashVerifyToken("abc"), hashVerifyToken("abd"));
  const { raw, hash } = generateVerifyToken();
  assert.equal(hash, hashVerifyToken(raw));
  assert.equal(/^[0-9a-f]{64}$/.test(raw), true); // 32 random bytes, hex
  assert.equal(/^[0-9a-f]{64}$/.test(hash), true); // sha256, hex
});
