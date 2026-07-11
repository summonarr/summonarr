// Fail-closed contract for at-rest token encryption (src/lib/token-crypto.ts)
// when TOKEN_ENCRYPTION_KEY is missing or malformed. This is the runtime half of
// the boot guarantee: instrumentation.ts calls assertTokenEncryptionKey() and
// exits on failure, but encryptToken/decryptToken must ALSO throw on their own —
// a silent plaintext fallback would write secrets unencrypted to the DB.
//
// This lives in its own file (not token-crypto.test.mts) because resolveKey()
// caches the key module-wide after the first SUCCESSFUL resolution — once the
// main file's valid key is resolved, the missing/malformed paths are unreachable
// in that process. The harness runs each test file in its own child process with
// file-local env, so this file deletes the key before any resolution. Test order
// matters here: all failure cases run first (failed resolutions do not cache),
// and the final test performs the process's first successful resolution to pin
// that UPPERCASE hex is accepted.
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  encryptToken,
  decryptToken,
  assertTokenEncryptionKey,
  TokenCryptoConfigError,
} from "../src/lib/token-crypto.ts";

delete process.env.TOKEN_ENCRYPTION_KEY;

// Well-formed envelope (3 parts, 16-byte IV and tag) so decryptToken gets past the
// shape checks and reaches key resolution.
const WELL_FORMED = "enc:v1:" + "00".repeat(16) + ":" + "00".repeat(16) + ":" + "00";

test("assertTokenEncryptionKey throws TokenCryptoConfigError when the key is missing", () => {
  assert.throws(() => assertTokenEncryptionKey(), TokenCryptoConfigError);
});

test("encryptToken fails closed without a key — never returns plaintext as 'ciphertext'", () => {
  assert.throws(() => encryptToken("plex-token-abc123"), TokenCryptoConfigError);
});

test("decryptToken on an encrypted value fails closed without a key, preserving the config error", () => {
  // decryptToken deliberately re-throws TokenCryptoConfigError (not the generic
  // auth-tag-mismatch error) so callers can distinguish "key missing" from "wrong key".
  assert.throws(() => decryptToken(WELL_FORMED, "test row"), TokenCryptoConfigError);
});

test("malformed keys are rejected: 63 hex chars, 65 hex chars, non-hex", () => {
  for (const bad of ["a".repeat(63), "a".repeat(65), "g".repeat(64), "not-a-key"]) {
    process.env.TOKEN_ENCRYPTION_KEY = bad;
    assert.throws(() => assertTokenEncryptionKey(), TokenCryptoConfigError);
    assert.throws(() => encryptToken("secret"), TokenCryptoConfigError);
  }
});

test("key-independent passthroughs still work with no valid key configured", (t) => {
  // These paths return before resolveKey() runs, so a misconfigured instance can
  // still round-trip empty values, already-encrypted rows, and legacy plaintext
  // (with the operator warning) instead of hard-crashing every Setting read.
  process.env.TOKEN_ENCRYPTION_KEY = "not-a-key";
  const warn = t.mock.method(console, "warn", () => {});
  assert.equal(encryptToken(""), "");
  assert.equal(encryptToken(WELL_FORMED), WELL_FORMED); // idempotency guard precedes key resolution
  assert.equal(decryptToken("legacy-plaintext", "Setting.nokeyRow"), "legacy-plaintext");
  assert.equal(warn.mock.calls.length, 1);
});

test("UPPERCASE hex key is accepted (/i in resolveKey) and round-trips", () => {
  // MUST be the last test in this file: it performs the first successful key
  // resolution, which caches module-wide and makes failure paths unreachable.
  process.env.TOKEN_ENCRYPTION_KEY = "AB0123456789CDEF".repeat(4);
  assert.doesNotThrow(() => assertTokenEncryptionKey());
  const enc = encryptToken("jellyfin-api-key");
  assert.match(enc, /^enc:v1:/);
  assert.equal(decryptToken(enc, "test row"), "jellyfin-api-key");
});
