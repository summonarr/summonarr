// Unit tests for scrypt password hashing (src/lib/password-hash.ts). The
// verify path must be strict about format (unknown prefixes and malformed
// hashes fail closed) and the write/sign-in length cap must stay shared so an
// accepted password can always authenticate.
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  hashPassword,
  verifyPassword,
  dummyVerify,
  MAX_PASSWORD_LENGTH,
} from "../src/lib/password-hash.ts";

test("hash → verify roundtrip; wrong password fails", async () => {
  const hash = await hashPassword("correct horse battery staple");
  assert.match(hash, /^scrypt:1:[A-Za-z0-9+/=]+:[A-Za-z0-9+/=]+$/);
  assert.equal(await verifyPassword("correct horse battery staple", hash), true);
  assert.equal(await verifyPassword("Correct horse battery staple", hash), false);
  assert.equal(await verifyPassword("", hash), false);
});

test("same password hashes to different strings (random salt), both verify", async () => {
  const a = await hashPassword("pw");
  const b = await hashPassword("pw");
  assert.notEqual(a, b);
  assert.equal(await verifyPassword("pw", a), true);
  assert.equal(await verifyPassword("pw", b), true);
});

test("malformed / foreign hashes fail closed, never throw", async () => {
  assert.equal(await verifyPassword("pw", ""), false);
  assert.equal(await verifyPassword("pw", "plaintext-not-a-hash"), false);
  assert.equal(await verifyPassword("pw", "bcrypt:2b:whatever"), false); // unknown prefix
  assert.equal(await verifyPassword("pw", "scrypt:1:onlyonepart"), false);
  assert.equal(await verifyPassword("pw", "scrypt:1::"), false); // empty salt + key
});

test("tampered stored key no longer verifies", async () => {
  const hash = await hashPassword("pw");
  const parts = hash.split(":");
  const key = Buffer.from(parts[3], "base64");
  key[0] ^= 0xff;
  parts[3] = key.toString("base64");
  assert.equal(await verifyPassword("pw", parts.join(":")), false);
});

test("dummy verify resolves (timing-equalization path is callable)", async () => {
  await assert.doesNotReject(dummyVerify());
});

test("password length cap is the shared write/sign-in bound", () => {
  assert.equal(MAX_PASSWORD_LENGTH, 1024);
});

test("unicode / multi-byte password roundtrips (utf8 input, no normalization)", async () => {
  // Node's scrypt encodes string passwords as utf8 and applies no Unicode
  // normalization — an encoding or NFC/NFD normalization change would silently
  // invalidate every stored hash. The NFD form of the same visible string is a
  // different byte sequence and must NOT verify.
  const nfc = "pässwörd\u{1F511}".normalize("NFC");
  const nfd = nfc.normalize("NFD");
  assert.notEqual(nfc, nfd); // sanity: distinct code-point sequences
  const hash = await hashPassword(nfc);
  assert.equal(await verifyPassword(nfc, hash), true);
  assert.equal(await verifyPassword(nfd, hash), false);
});

test("invalid-base64 salt/key fails closed (tolerant decode → empty-buffer guard)", async () => {
  // Buffer.from(s, "base64") silently drops invalid characters, so "!!!!"
  // decodes to a ZERO-LENGTH buffer rather than throwing. The
  // salt.length === 0 / expected.length === 0 guard must catch that instead
  // of running scrypt against an empty salt.
  assert.equal(await verifyPassword("pw", "scrypt:1:!!!!:!!!!"), false);
  assert.equal(await verifyPassword("pw", "scrypt:1:!!!!:AAAA"), false); // empty salt, valid key
  assert.equal(await verifyPassword("pw", "scrypt:1:AAAA:!!!!"), false); // valid salt, empty key
});

test("too many colon-separated parts fails closed", async () => {
  // Complements the one-part case above: parts.length !== 2 from the other side.
  assert.equal(await verifyPassword("pw", "scrypt:1:a:b:c"), false);
});

test("current behavior: verify honors the STORED key's length", async () => {
  // keylen is derived from expected.length, and scrypt's PBKDF2-SHA256
  // finalization has an output-prefix property: a hash whose stored key was
  // truncated (here to 16 bytes) STILL verifies for the correct password —
  // the comparison strength silently degrades to the stored length. Pinned as
  // current behavior: hash-row integrity is an assumption of the scheme, not
  // something verifyPassword checks.
  const hash = await hashPassword("pw");
  const parts = hash.split(":");
  const truncated = Buffer.from(parts[3], "base64").subarray(0, 16);
  parts[3] = truncated.toString("base64");
  const shortHash = parts.join(":");
  assert.equal(await verifyPassword("pw", shortHash), true);
  assert.equal(await verifyPassword("wrong", shortHash), false);
});

test("password of exactly MAX_PASSWORD_LENGTH roundtrips (module imposes no cap)", async () => {
  // MAX_PASSWORD_LENGTH is exported for CALLERS to enforce on write and
  // sign-in; hashPassword/verifyPassword themselves accept it — the constant
  // is shared policy, not a module-level guard.
  const pw = "p".repeat(MAX_PASSWORD_LENGTH);
  assert.equal(pw.length, 1024);
  const hash = await hashPassword(pw);
  assert.equal(await verifyPassword(pw, hash), true);
});
