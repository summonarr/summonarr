// Unit tests for the request-signing token (src/lib/request-token.ts). The token
// scopes a request/vote action to a single (tmdbId, mediaType, userId) tuple, so
// its binding is a real anti-abuse control — a token minted for one user/item
// MUST NOT verify for another. The HMAC secret is read per-call from the env, so
// we set a test secret before the assertions run.
import { test } from "node:test";
import assert from "node:assert/strict";
import { generateRequestToken, verifyRequestToken } from "../src/lib/request-token.ts";

process.env.NEXTAUTH_SECRET = process.env.NEXTAUTH_SECRET ?? "test-secret-for-request-token-signing-0123456789";

test("a freshly minted token verifies for the same (tmdbId, mediaType, userId)", () => {
  const t = generateRequestToken(603, "MOVIE", "u_alice");
  assert.equal(verifyRequestToken(t, 603, "MOVIE", "u_alice"), true);
});

test("token binding — cannot be reused for a different item or user", () => {
  const t = generateRequestToken(603, "MOVIE", "u_alice");
  assert.equal(verifyRequestToken(t, 604, "MOVIE", "u_alice"), false); // different tmdbId
  assert.equal(verifyRequestToken(t, 603, "TV", "u_alice"), false); // different mediaType
  assert.equal(verifyRequestToken(t, 603, "MOVIE", "u_bob"), false); // different user
});

test("garbage / empty tokens do not verify", () => {
  assert.equal(verifyRequestToken("deadbeef", 603, "MOVIE", "u_alice"), false);
  assert.equal(verifyRequestToken("", 603, "MOVIE", "u_alice"), false);
  assert.equal(verifyRequestToken("not-hex-zz", 603, "MOVIE", "u_alice"), false);
});
