// Unit tests for the two-factor primitives that need no DB: RFC 4226 HOTP /
// RFC 6238 TOTP (src/lib/mfa/totp.ts) and the one-time recovery codes
// (src/lib/mfa/recovery-codes.ts).
//
// The TOTP vectors are the RFC's own (RFC 4226 Appendix D, RFC 6238 Appendix B,
// RFC 4648 §10) — an implementation that passes them interoperates with every
// authenticator app. The window/replay tests pin guardrail 6d's acceptance
// rule: ±1 step, and never a step at or below the last accepted one.
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  base32Decode,
  base32Encode,
  buildOtpauthUri,
  generateTotpSecret,
  hotp,
  totpAt,
  totpStep,
  verifyTotp,
  TOTP_PERIOD_SECONDS,
} from "../src/lib/mfa/totp.ts";
import {
  generateRecoveryCode,
  generateRecoveryCodes,
  hashRecoveryCode,
  normalizeRecoveryCode,
  recoveryHashesEqual,
  RECOVERY_CODE_COUNT,
} from "../src/lib/mfa/recovery-codes.ts";

const SHA1_KEY = Buffer.from("12345678901234567890", "ascii");
const SHA256_KEY = Buffer.from("12345678901234567890123456789012", "ascii");
const SHA512_KEY = Buffer.from("1234567890123456789012345678901234567890123456789012345678901234", "ascii");

// ── RFC 4648 base32 ─────────────────────────────────────────────────────────

test("base32: RFC 4648 §10 vectors (unpadded) encode and decode", () => {
  const vectors: [string, string][] = [
    ["f", "MY"],
    ["fo", "MZXQ"],
    ["foo", "MZXW6"],
    ["foob", "MZXW6YQ"],
    ["fooba", "MZXW6YTB"],
    ["foobar", "MZXW6YTBOI"],
  ];
  for (const [plain, encoded] of vectors) {
    assert.equal(base32Encode(Buffer.from(plain)), encoded, plain);
    assert.equal(base32Decode(encoded)?.toString(), plain, encoded);
    // Padding, lower case and spaces as people paste them are tolerated.
    assert.equal(base32Decode(`${encoded.toLowerCase()}====`)?.toString(), plain);
  }
  assert.equal(base32Decode("MZXW 6YTB OI")?.toString(), "foobar");
});

test("base32: invalid characters, impossible lengths and non-zero trailing bits are refused", () => {
  assert.equal(base32Decode("MZXW1"), null, "1 is not in the alphabet");
  assert.equal(base32Decode("M"), null, "a 1-symbol tail can't be produced by an encoder");
  assert.equal(base32Decode("MZ"), null, "MZ has non-zero trailing bits (canonical is MY)");
  assert.equal(base32Decode(""), null);
});

test("generated secrets are 160-bit and round-trip through base32", () => {
  const s = generateTotpSecret();
  assert.match(s, /^[A-Z2-7]{32}$/);
  assert.equal(base32Decode(s)?.length, 20);
  assert.notEqual(generateTotpSecret(), s);
});

// ── RFC 4226 / RFC 6238 vectors ─────────────────────────────────────────────

test("HOTP: RFC 4226 Appendix D (SHA-1, 6 digits, counters 0–9)", () => {
  const expected = ["755224", "287082", "359152", "969429", "338314", "254676", "287922", "162583", "399871", "520489"];
  expected.forEach((code, counter) => assert.equal(hotp(SHA1_KEY, counter), code, `counter ${counter}`));
});

test("TOTP: RFC 6238 Appendix B (8 digits, SHA-1 / SHA-256 / SHA-512)", () => {
  const rows: [number, string, string, string][] = [
    [59, "94287082", "46119246", "90693936"],
    [1111111109, "07081804", "68084774", "25091201"],
    [1111111111, "14050471", "67062674", "99943326"],
    [1234567890, "89005924", "91819424", "93441116"],
    [2000000000, "69279037", "90698825", "38618901"],
    [20000000000, "65353130", "77737706", "47863826"],
  ];
  for (const [t, sha1, sha256, sha512] of rows) {
    const ms = t * 1000;
    assert.equal(totpAt(SHA1_KEY, ms, { digits: 8, algorithm: "sha1" }), sha1, `sha1 @${t}`);
    assert.equal(totpAt(SHA256_KEY, ms, { digits: 8, algorithm: "sha256" }), sha256, `sha256 @${t}`);
    assert.equal(totpAt(SHA512_KEY, ms, { digits: 8, algorithm: "sha512" }), sha512, `sha512 @${t}`);
  }
});

// ── verifyTotp: window, replay, format ──────────────────────────────────────

const SECRET = base32Encode(SHA1_KEY);
const NOW = 1_700_000_000_000; // a fixed instant, mid-step
const codeAt = (stepOffset: number) => hotp(SHA1_KEY, totpStep(NOW) + stepOffset);

test("verifyTotp accepts the current step and ±1 step of drift, reporting the matched step", () => {
  const current = totpStep(NOW);
  for (const off of [-1, 0, 1]) {
    const v = verifyTotp(SECRET, codeAt(off), { nowMs: NOW });
    assert.deepEqual(v, { ok: true, step: current + off }, `offset ${off}`);
  }
});

test("verifyTotp REFUSES codes two or more steps away", () => {
  for (const off of [-3, -2, 2, 3]) {
    assert.deepEqual(verifyTotp(SECRET, codeAt(off), { nowMs: NOW }), { ok: false, reason: "mismatch" }, `offset ${off}`);
  }
});

test("replay protection: a step at or BELOW lastUsedStep is refused even though the code is valid", () => {
  const current = totpStep(NOW);
  // The exact step just used.
  assert.deepEqual(verifyTotp(SECRET, codeAt(0), { nowMs: NOW, lastUsedStep: current }), { ok: false, reason: "replay" });
  // An older step still inside the window.
  assert.deepEqual(verifyTotp(SECRET, codeAt(-1), { nowMs: NOW, lastUsedStep: current }), { ok: false, reason: "replay" });
  // The NEXT step is fine — normal use 30s later.
  assert.deepEqual(verifyTotp(SECRET, codeAt(1), { nowMs: NOW, lastUsedStep: current }), { ok: true, step: current + 1 });
});

test("verifyTotp normalizes spaces/dashes and refuses malformed input before any HMAC", () => {
  const c = codeAt(0);
  assert.equal(verifyTotp(SECRET, `${c.slice(0, 3)} ${c.slice(3)}`, { nowMs: NOW }).ok, true);
  assert.equal(verifyTotp(SECRET, `${c.slice(0, 3)}-${c.slice(3)}`, { nowMs: NOW }).ok, true);
  for (const bad of ["", "12345", "1234567", "abcdef", "12345a"]) {
    assert.deepEqual(verifyTotp(SECRET, bad, { nowMs: NOW }), { ok: false, reason: "format" }, bad);
  }
  assert.deepEqual(verifyTotp("", c, { nowMs: NOW }), { ok: false, reason: "secret" }, "an empty (undecryptable) secret verifies nothing");
});

test("a wrong secret never verifies another secret's code", () => {
  const other = generateTotpSecret();
  assert.equal(verifyTotp(other, codeAt(0), { nowMs: NOW }).ok, false);
});

test("otpauth URI: issuer-prefixed label, the RFC 6238 defaults spelled out", () => {
  const uri = new URL(buildOtpauthUri({ secret: "JBSWY3DPEHPK3PXP", accountName: "a+b@example.com" }));
  assert.equal(uri.protocol, "otpauth:");
  assert.equal(uri.host, "totp");
  assert.equal(decodeURIComponent(uri.pathname), "/Summonarr:a+b@example.com");
  assert.equal(uri.searchParams.get("secret"), "JBSWY3DPEHPK3PXP");
  assert.equal(uri.searchParams.get("issuer"), "Summonarr");
  assert.equal(uri.searchParams.get("algorithm"), "SHA1");
  assert.equal(uri.searchParams.get("digits"), "6");
  assert.equal(uri.searchParams.get("period"), String(TOTP_PERIOD_SECONDS));
});

// ── recovery codes ──────────────────────────────────────────────────────────

test("recovery codes: ten distinct XXXX-XXXX-XXXX-XXXX codes from an unambiguous alphabet", () => {
  const codes = generateRecoveryCodes();
  assert.equal(codes.length, RECOVERY_CODE_COUNT);
  assert.equal(new Set(codes).size, codes.length);
  for (const c of codes) assert.match(c, /^[A-HJ-NP-Z2-9]{4}(-[A-HJ-NP-Z2-9]{4}){3}$/);
});

test("recovery codes: normalization accepts what people type and refuses everything else", () => {
  const c = generateRecoveryCode();
  const bare = c.replace(/-/g, "");
  assert.equal(normalizeRecoveryCode(c), bare);
  assert.equal(normalizeRecoveryCode(c.toLowerCase()), bare);
  assert.equal(normalizeRecoveryCode(` ${bare.slice(0, 8)} ${bare.slice(8)} `), bare);
  assert.equal(normalizeRecoveryCode("123456"), null, "a TOTP code is not a recovery code");
  assert.equal(normalizeRecoveryCode("O0O0-I1I1-O0O0-I1I1"), null, "ambiguous symbols are not in the alphabet");
});

test("recovery codes: the stored hash is domain-separated SHA-256 and compares in constant time", () => {
  const n = normalizeRecoveryCode(generateRecoveryCode())!;
  const h = hashRecoveryCode(n);
  assert.match(h, /^[0-9a-f]{64}$/);
  assert.equal(hashRecoveryCode(n), h, "deterministic");
  assert.ok(recoveryHashesEqual(h, hashRecoveryCode(n)));
  assert.ok(!recoveryHashesEqual(h, hashRecoveryCode(normalizeRecoveryCode(generateRecoveryCode())!)));
  assert.ok(!recoveryHashesEqual(h, h.slice(0, 63)), "length mismatch is a plain false, not a throw");
});
