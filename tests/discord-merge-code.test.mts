// The confirm-merge code is stored as an HMAC (src/lib/discord-merge-code.ts).
// The routes are pinned in tests/discord-routes.test.mts (initiate-merge stores
// only the MAC; confirm-merge verifies it, treats a plaintext row as expired, and
// consumes the code inside the merge transaction). This file pins the helpers:
// the MAC is keyed (a plain hash of a 48-bit code would be brute-forceable from
// a DB read), it binds the user and the Discord id, and it survives a rotation
// through NEXTAUTH_SECRET_PREVIOUS.
import { test, afterEach } from "node:test";
import assert from "node:assert/strict";
import { createHash, createHmac } from "node:crypto";

const SECRET = "discord-merge-code-test-secret-0123456789abcdef";
const OLD = "discord-merge-code-OLD-secret-0123456789abcdef!";
process.env.NEXTAUTH_SECRET = SECRET;
delete process.env.NEXTAUTH_SECRET_PREVIOUS;

const {
  generateDiscordMergeCode,
  discordMergeCodeMac,
  discordMergeCodeMatches,
  isDiscordMergeCodeMac,
  normalizeDiscordMergeCode,
} = await import("../src/lib/discord-merge-code.ts");

afterEach(() => {
  process.env.NEXTAUTH_SECRET = SECRET;
  delete process.env.NEXTAUTH_SECRET_PREVIOUS;
});

const USER = "user-1";
const DISCORD = "123456789012345678";

test("a generated code is 12 uppercase hex characters and its MAC verifies", () => {
  const seen = new Set<string>();
  for (let i = 0; i < 50; i++) {
    const { code, codeMac } = generateDiscordMergeCode(USER, DISCORD);
    assert.match(code, /^[0-9A-F]{12}$/);
    assert.ok(isDiscordMergeCodeMac(codeMac));
    assert.equal(codeMac, discordMergeCodeMac(USER, DISCORD, code));
    assert.ok(discordMergeCodeMatches(codeMac, USER, DISCORD, code));
    seen.add(code);
  }
  assert.equal(seen.size, 50, "codes are random");
});

test("PIN: the stored value is a KEYED MAC — not a plain hash, not an HMAC under the raw secret", () => {
  const { code, codeMac } = generateDiscordMergeCode(USER, DISCORD);
  assert.notEqual(codeMac, createHash("sha256").update(code).digest("hex"), "a plain hash of 48 bits is brute-forceable");
  const rawKeyed = createHmac("sha256", SECRET).update(`discord-merge:v1:${USER}:${DISCORD}:${code}`).digest("hex");
  assert.notEqual(codeMac, rawKeyed, "the key is a purpose subkey, never NEXTAUTH_SECRET itself (guardrail 6h)");
  assert.ok(!codeMac.includes(code));
});

test("PIN: the MAC binds the code, the user and the Discord id", () => {
  const { code, codeMac } = generateDiscordMergeCode(USER, DISCORD);
  assert.equal(discordMergeCodeMatches(codeMac, USER, DISCORD, "000000000000"), false, "a wrong code");
  assert.equal(discordMergeCodeMatches(codeMac, "user-2", DISCORD, code), false, "another user");
  assert.equal(discordMergeCodeMatches(codeMac, USER, "876543210987654321", code), false, "another Discord id");
  assert.equal(discordMergeCodeMatches(codeMac, USER, DISCORD, code.toLowerCase()), false, "the route normalizes first");
  assert.ok(discordMergeCodeMatches(codeMac, USER, DISCORD, normalizeDiscordMergeCode(` ${code.toLowerCase()} `)));
});

test("a plaintext (pre-upgrade) row is not a MAC and never matches its own code", () => {
  assert.equal(isDiscordMergeCodeMac("ABCDEF123456"), false);
  assert.equal(discordMergeCodeMatches("ABCDEF123456", USER, DISCORD, "ABCDEF123456"), false);
  // Junk around a real MAC is not a MAC either.
  const { codeMac } = generateDiscordMergeCode(USER, DISCORD);
  assert.equal(isDiscordMergeCodeMac(`${codeMac}00`), false);
  assert.equal(isDiscordMergeCodeMac(codeMac.toUpperCase()), false);
});

test("a code sent before a rotation still verifies while NEXTAUTH_SECRET_PREVIOUS holds the old secret", () => {
  process.env.NEXTAUTH_SECRET = OLD;
  const { code, codeMac } = generateDiscordMergeCode(USER, DISCORD);
  process.env.NEXTAUTH_SECRET = SECRET;
  process.env.NEXTAUTH_SECRET_PREVIOUS = OLD;
  assert.ok(discordMergeCodeMatches(codeMac, USER, DISCORD, code), "rotation must not strand a code in flight");
  delete process.env.NEXTAUTH_SECRET_PREVIOUS;
  assert.equal(discordMergeCodeMatches(codeMac, USER, DISCORD, code), false, "and dies with the old secret");
});
