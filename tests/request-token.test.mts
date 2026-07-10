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

// Expiry: the hour bucket is part of the HMAC payload and verify accepts the
// current bucket plus the previous one (a boundary-straddling request must not
// break), but nothing older. bucket() calls Date.now() per invocation, so a
// stubbed clock makes the window fully deterministic. If a regression dropped
// timeBucket from the payload (tokens valid forever) or the b-1 grace, this
// test is the only one that would catch it.
test("token expires after the previous-bucket grace window", () => {
  const realNow = Date.now;
  try {
    const t0 = 1_700_000_000_000; // fixed epoch; exact value irrelevant, clock is fully stubbed
    Date.now = () => t0;
    const token = generateRequestToken(603, "MOVIE", "u_alice");

    // Same bucket: valid.
    assert.equal(verifyRequestToken(token, 603, "MOVIE", "u_alice"), true);

    // One bucket later: still valid via the previous-bucket grace.
    Date.now = () => t0 + 3600 * 1000;
    assert.equal(verifyRequestToken(token, 603, "MOVIE", "u_alice"), true);

    // Two buckets later: expired.
    Date.now = () => t0 + 2 * 3600 * 1000;
    assert.equal(verifyRequestToken(token, 603, "MOVIE", "u_alice"), false);
  } finally {
    Date.now = realNow;
  }
});

// Secret-dependence: the HMAC key is read from the env per call. If sign()
// degenerated to an unkeyed sha256 of the payload, every other test here would
// still pass — verifying under a different secret is the only offline proof
// that the secret is actually mixed into the digest.
test("token minted under one secret does not verify under another", () => {
  const original = process.env.NEXTAUTH_SECRET;
  try {
    const token = generateRequestToken(603, "MOVIE", "u_alice");
    process.env.NEXTAUTH_SECRET = "a-completely-different-secret-value-9876543210";
    assert.equal(verifyRequestToken(token, 603, "MOVIE", "u_alice"), false);
    // Restoring the original secret makes the same token verify again,
    // proving the secret flip (not the clock or binding) caused the failure.
    process.env.NEXTAUTH_SECRET = original;
    assert.equal(verifyRequestToken(token, 603, "MOVIE", "u_alice"), true);
  } finally {
    process.env.NEXTAUTH_SECRET = original;
  }
});

// Fail-closed: with no secret configured, signing must throw rather than
// silently HMAC with an empty/undefined key (which would mint tokens any
// unauthenticated party could forge by computing the same keyless digest).
test("missing NEXTAUTH_SECRET throws instead of signing with an empty key", () => {
  const original = process.env.NEXTAUTH_SECRET;
  try {
    delete process.env.NEXTAUTH_SECRET;
    assert.throws(
      () => generateRequestToken(603, "MOVIE", "u_alice"),
      /NEXTAUTH_SECRET is required for request signing/,
    );
    assert.throws(
      () => verifyRequestToken("deadbeef", 603, "MOVIE", "u_alice"),
      /NEXTAUTH_SECRET is required for request signing/,
    );
  } finally {
    process.env.NEXTAUTH_SECRET = original;
  }
});

// Wire format: 64 lowercase hex chars (sha256 hex digest). safeEqual decodes
// both sides with Buffer.from(x, "hex"), which tolerantly truncates at the
// first non-hex character — so a symmetric encoding change (e.g. base64 on
// both mint and verify) would still self-verify while silently shrinking the
// bytes actually compared. Pinning the format guards that decoding assumption.
test("token wire format is exactly 64 lowercase hex characters", () => {
  const token = generateRequestToken(603, "MOVIE", "u_alice");
  assert.match(token, /^[0-9a-f]{64}$/);
});
