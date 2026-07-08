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

test("hashVerifyToken is deterministic; generateVerifyToken hashes its own raw", () => {
  assert.equal(hashVerifyToken("abc"), hashVerifyToken("abc"));
  assert.notEqual(hashVerifyToken("abc"), hashVerifyToken("abd"));
  const { raw, hash } = generateVerifyToken();
  assert.equal(hash, hashVerifyToken(raw));
  assert.equal(/^[0-9a-f]{64}$/.test(raw), true); // 32 random bytes, hex
  assert.equal(/^[0-9a-f]{64}$/.test(hash), true); // sha256, hex
});
