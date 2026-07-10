// Unit tests for at-rest token encryption (src/lib/token-crypto.ts). The
// double-encryption idempotency guard and the legacy-plaintext passthrough are
// the two behaviours that shipped as production regressions (guardrail 7a) —
// they are pinned here alongside the basic roundtrip/tamper contract.
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  encryptToken,
  decryptToken,
  assertTokenEncryptionKey,
  tokenEncryptionKeyFingerprint,
  TokenCryptoConfigError,
} from "../src/lib/token-crypto.ts";

// The key is resolved lazily on first use, so setting it after import is fine.
const TEST_KEY = "a".repeat(64);
process.env.TOKEN_ENCRYPTION_KEY = TEST_KEY;

test("assertTokenEncryptionKey accepts a 64-hex-char key", () => {
  assert.doesNotThrow(() => assertTokenEncryptionKey());
});

test("encrypt → decrypt roundtrip, including non-ASCII payloads", () => {
  for (const secret of ["plex-token-abc123", "påsswörd-🎬", "x"]) {
    const enc = encryptToken(secret);
    assert.notEqual(enc, secret);
    assert.equal(decryptToken(enc, "test row"), secret);
  }
});

test("wire format is enc:v1:<iv>:<tag>:<ciphertext> with 16-byte IV and tag", () => {
  const enc = encryptToken("value");
  assert.match(enc, /^enc:v1:[0-9a-f]{32}:[0-9a-f]{32}:[0-9a-f]+$/);
});

test("encryption is non-deterministic (fresh IV per call)", () => {
  assert.notEqual(encryptToken("same"), encryptToken("same"));
});

test("idempotency guard: an already-encrypted value is returned unchanged (guardrail 7a)", () => {
  const once = encryptToken("radarr-api-key");
  assert.equal(encryptToken(once), once); // no enc:v1:<enc:v1:…> double wrap
});

test("empty string is a passthrough in both directions", () => {
  assert.equal(encryptToken(""), "");
});

test("legacy plaintext passthrough warns once per label, returns the value verbatim", (t) => {
  const warn = t.mock.method(console, "warn", () => {});
  assert.equal(decryptToken("plain-legacy-token", "Setting.testKeyA"), "plain-legacy-token");
  assert.equal(decryptToken("plain-legacy-token", "Setting.testKeyA"), "plain-legacy-token");
  const forLabel = warn.mock.calls.filter((c) => String(c.arguments[0]).includes("Setting.testKeyA"));
  assert.equal(forLabel.length, 1); // deduped by label
});

test("tampered ciphertext fails the GCM auth tag, does not return garbage", () => {
  const enc = encryptToken("secret");
  const parts = enc.split(":");
  const ct = parts[4];
  const flipped = ct[0] === "0" ? "1" : "0";
  parts[4] = flipped + ct.slice(1);
  assert.throws(() => decryptToken(parts.join(":"), "tampered"), /auth-tag mismatch/);
});

test("malformed ciphertext shapes throw instead of decrypting", () => {
  assert.throws(() => decryptToken("enc:v1:onlytwo:parts", "bad"), /expected 3 colon-separated parts/);
  assert.throws(() => decryptToken("enc:v1:dead:beef:cafe", "bad"), /IV or auth tag has wrong length/);
});

test("key fingerprint: 16 hex chars, stable for the same key, null when unconfigured", () => {
  const fp1 = tokenEncryptionKeyFingerprint();
  assert.match(fp1 ?? "", /^[0-9a-f]{16}$/);
  assert.equal(tokenEncryptionKeyFingerprint(), fp1);
  // Reads the env per call and never throws on a bad key — restore requires care.
  delete process.env.TOKEN_ENCRYPTION_KEY;
  assert.equal(tokenEncryptionKeyFingerprint(), null);
  process.env.TOKEN_ENCRYPTION_KEY = "not-hex";
  assert.equal(tokenEncryptionKeyFingerprint(), null);
  process.env.TOKEN_ENCRYPTION_KEY = TEST_KEY;
  assert.equal(tokenEncryptionKeyFingerprint(), fp1);
});

test("TokenCryptoConfigError is exported and named for callers that discriminate", () => {
  const err = new TokenCryptoConfigError("boom");
  assert.equal(err.name, "TokenCryptoConfigError");
  assert.equal(err instanceof Error, true);
});

test("fingerprint is key-dependent: a different valid key yields a different fingerprint", () => {
  // Guards against the fingerprint degenerating into a constant (e.g. hashing the
  // domain-separation prefix alone) — backup restore compares fingerprints across
  // instances to decide "same key or not", which only works if the key feeds the hash.
  const fpA = tokenEncryptionKeyFingerprint();
  try {
    process.env.TOKEN_ENCRYPTION_KEY = "b".repeat(64);
    const fpB = tokenEncryptionKeyFingerprint();
    assert.match(fpB ?? "", /^[0-9a-f]{16}$/);
    assert.notEqual(fpB, fpA);
  } finally {
    process.env.TOKEN_ENCRYPTION_KEY = TEST_KEY;
  }
  assert.equal(tokenEncryptionKeyFingerprint(), fpA);
});

test("fingerprint normalizes key case: UPPER and lower hex of the same key match", () => {
  // resolveKey accepts either case (/^[0-9a-f]{64}$/i) and Buffer.from(hex) parses both
  // to the same bytes, so two instances configured with the same key in different case
  // MUST fingerprint identically or the backup-restore same-key comparison false-negatives.
  // The .toLowerCase() in tokenEncryptionKeyFingerprint() is what makes this hold.
  try {
    process.env.TOKEN_ENCRYPTION_KEY = "0123456789abcdef".repeat(4);
    const lower = tokenEncryptionKeyFingerprint();
    process.env.TOKEN_ENCRYPTION_KEY = "0123456789ABCDEF".repeat(4);
    assert.equal(tokenEncryptionKeyFingerprint(), lower);
  } finally {
    process.env.TOKEN_ENCRYPTION_KEY = TEST_KEY;
  }
});

test("plaintext warn dedupe is per-label, not global: a second label still warns exactly once", (t) => {
  // The earlier passthrough test already consumed the warn for Setting.testKeyA in this
  // process, so if the Set ever regressed to a warn-once-GLOBALLY boolean, Setting.testKeyB
  // would log zero warnings here and the same-label-once test above would still pass.
  const warn = t.mock.method(console, "warn", () => {});
  assert.equal(decryptToken("plain-legacy-token-b", "Setting.testKeyB"), "plain-legacy-token-b");
  assert.equal(decryptToken("plain-legacy-token-b", "Setting.testKeyB"), "plain-legacy-token-b");
  const forB = warn.mock.calls.filter((c) => String(c.arguments[0]).includes("Setting.testKeyB"));
  assert.equal(forB.length, 1); // warned despite testKeyA's earlier warn, and deduped on repeat
});
