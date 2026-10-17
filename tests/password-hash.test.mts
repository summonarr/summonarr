// Unit tests for scrypt password hashing (src/lib/password-hash.ts). The
// verify path must be strict about format (unknown prefixes and malformed
// hashes fail closed) and the write/sign-in length cap must stay shared so an
// accepted password can always authenticate.
//
// Guardrail 6i pins: the scrypt:2 format records its own N/r/p and is written at
// SCRYPT_PARAMS (OWASP's N=2^17, r=8, p=1); legacy scrypt:1 hashes still verify
// and report needsRehash; every verify — current, legacy, dummy — does the SAME
// scrypt work (so timing can't tell an unknown account from a legacy one); at
// most MAX_CONCURRENT_HASHES derivations run at once; and the CLI scripts'
// copies of hashPassword write hashes the app accepts at the current cost.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { scrypt as scryptCb, randomBytes } from "node:crypto";
import { promisify } from "node:util";
import { stripTypeScriptTypes } from "node:module";
import {
  hashPassword,
  verifyPassword,
  dummyVerify,
  needsRehash,
  hashSlotStats,
  scryptWorkDone,
  MAX_PASSWORD_LENGTH,
  MAX_CONCURRENT_HASHES,
  SCRYPT_PARAMS,
  LEGACY_V1_PARAMS,
} from "../src/lib/password-hash.ts";

const scrypt = promisify(scryptCb) as (
  pw: string,
  salt: Buffer,
  keylen: number,
  opts: { N: number; r: number; p: number; maxmem: number },
) => Promise<Buffer>;

// Builds a hash the way an older build (scrypt:1) or a different parameter set
// (scrypt:2 with other N/r/p) would have, without going through hashPassword.
async function rawHash(
  password: string,
  params: { ln: number; r: number; p: number },
  format: "v1" | "v2",
): Promise<string> {
  const salt = randomBytes(16);
  const key = await scrypt(password, salt, 64, {
    N: 2 ** params.ln,
    r: params.r,
    p: params.p,
    maxmem: 2 * 128 * 2 ** params.ln * params.r,
  });
  const tail = `${salt.toString("base64")}:${key.toString("base64")}`;
  return format === "v1" ? `scrypt:1:${tail}` : `scrypt:2:${params.ln}:${params.r}:${params.p}:${tail}`;
}

const CURRENT_WORK = 2 ** SCRYPT_PARAMS.ln * SCRYPT_PARAMS.r * SCRYPT_PARAMS.p;

async function workOf(fn: () => Promise<unknown>): Promise<number> {
  const before = scryptWorkDone();
  await fn();
  return scryptWorkDone() - before;
}

test("hash → verify roundtrip; wrong password fails", async () => {
  const hash = await hashPassword("correct horse battery staple");
  assert.match(hash, /^scrypt:2:17:8:1:[A-Za-z0-9+/=]+:[A-Za-z0-9+/=]+$/);
  assert.equal(await verifyPassword("correct horse battery staple", hash), true);
  assert.equal(await verifyPassword("Correct horse battery staple", hash), false);
  assert.equal(await verifyPassword("", hash), false);
});

test("new hashes are written at OWASP's scrypt baseline (N=2^17, r=8, p=1) and need no rehash", async () => {
  assert.deepEqual({ ...SCRYPT_PARAMS }, { ln: 17, r: 8, p: 1 });
  const hash = await hashPassword("pw");
  assert.equal(needsRehash(hash), false);
  // The stored parameters are the real ones: an independent scrypt at 2^17/8/1
  // over the stored salt reproduces the stored key.
  const parts = hash.split(":");
  const salt = Buffer.from(parts[5], "base64");
  const key = await scrypt("pw", salt, 64, { N: 2 ** 17, r: 8, p: 1, maxmem: 256 * 1024 * 1024 });
  assert.equal(key.toString("base64"), parts[6]);
});

test("a legacy scrypt:1 hash (2^15, no stored parameters) still verifies and reports needsRehash", async () => {
  assert.deepEqual({ ...LEGACY_V1_PARAMS }, { ln: 15, r: 8, p: 1 });
  const legacy = await rawHash("old-password", LEGACY_V1_PARAMS, "v1");
  assert.equal(await verifyPassword("old-password", legacy), true);
  assert.equal(await verifyPassword("wrong", legacy), false);
  assert.equal(needsRehash(legacy), true);
});

test("a scrypt:2 hash verifies with the parameters IT records, and any other set than the current one needs a rehash", async () => {
  const cheaper = await rawHash("pw", { ln: 15, r: 8, p: 1 }, "v2");
  assert.equal(await verifyPassword("pw", cheaper), true, "verified at the stored 2^15, not the code's 2^17");
  assert.equal(needsRehash(cheaper), true);
  const otherR = await rawHash("pw", { ln: 14, r: 4, p: 2 }, "v2");
  assert.equal(await verifyPassword("pw", otherR), true);
  assert.equal(needsRehash(otherR), true);
});

test("needsRehash is true for anything that isn't a full-length current hash", async () => {
  const hash = await hashPassword("pw");
  const parts = hash.split(":");
  parts[6] = Buffer.from(parts[6], "base64").subarray(0, 32).toString("base64");
  assert.equal(needsRehash(parts.join(":")), true, "a short stored key");
  assert.equal(needsRehash(""), true);
  assert.equal(needsRehash("bcrypt:2b:whatever"), true);
});

test("stored parameters are bounded: an out-of-range or malformed set is refused BEFORE any scrypt runs", async () => {
  // Each would be cheap to compute if the bound were missing, so a regression
  // fails here instead of hanging.
  const cases: Array<[string, { ln: number; r: number; p: number }]> = [
    ["N below 2^14", { ln: 13, r: 8, p: 1 }],
    ["r above 16", { ln: 14, r: 17, p: 1 }],
    ["p above 4", { ln: 14, r: 1, p: 5 }],
    ["N above 2^20", { ln: 21, r: 1, p: 1 }],
    ["memory above 256 MiB", { ln: 18, r: 9, p: 1 }],
  ];
  for (const [label, params] of cases) {
    const salt = randomBytes(16).toString("base64");
    const key = randomBytes(64).toString("base64");
    const hash = `scrypt:2:${params.ln}:${params.r}:${params.p}:${salt}:${key}`;
    const work = await workOf(async () => assert.equal(await verifyPassword("pw", hash), false, label));
    assert.equal(work, 0, `${label}: refused without deriving`);
  }
  const salt = randomBytes(16).toString("base64");
  for (const bad of ["017:8:1", "17:08:1", "+17:8:1", "17:8:1.0", "0x11:8:1", "17:8", "17:8:1:9"]) {
    const hash = `scrypt:2:${bad}:${salt}:${salt}`;
    const work = await workOf(async () => assert.equal(await verifyPassword("pw", hash), false, bad));
    assert.equal(work, 0, `${bad}: refused without deriving`);
  }
});

test("every verify does the SAME scrypt work: current, legacy and the unknown-account dummy", async () => {
  // A legacy hash costs a quarter of a current one; unpadded, its verify would
  // finish 4× sooner than dummyVerify and the timing alone would reveal which
  // emails have an account. Padding at the stored parameters closes that.
  const current = await hashPassword("pw");
  const legacy = await rawHash("pw", LEGACY_V1_PARAMS, "v1");
  await dummyVerify(); // the dummy hash is warmed at load; make sure it is cached
  assert.equal(await workOf(() => verifyPassword("pw", current)), CURRENT_WORK);
  assert.equal(await workOf(() => verifyPassword("nope", current)), CURRENT_WORK);
  assert.equal(await workOf(() => verifyPassword("pw", legacy)), CURRENT_WORK);
  assert.equal(await workOf(() => verifyPassword("nope", legacy)), CURRENT_WORK);
  assert.equal(await workOf(() => dummyVerify()), CURRENT_WORK);
  assert.equal(await workOf(() => hashPassword("pw")), CURRENT_WORK);
});

test(`at most MAX_CONCURRENT_HASHES (${MAX_CONCURRENT_HASHES}) derivations run at once; the rest queue and all complete`, async () => {
  assert.equal(MAX_CONCURRENT_HASHES, 2);
  const hash = await hashPassword("pw");
  assert.deepEqual(hashSlotStats(), { active: 0, queued: 0 });
  const runs = [
    hashPassword("a"),
    verifyPassword("pw", hash),
    verifyPassword("wrong", hash),
    dummyVerify(),
    hashPassword("b"),
  ];
  // dummyVerify awaits its cached hash first, so it queues one tick later; a
  // derivation takes ~180 ms, so nothing has finished by then.
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(hashSlotStats(), { active: 2, queued: 3 });
  let peak = 0;
  const sampler = setInterval(() => { peak = Math.max(peak, hashSlotStats().active); }, 5);
  const results = await Promise.all(runs);
  clearInterval(sampler);
  assert.ok(peak <= MAX_CONCURRENT_HASHES, `peak ${peak}`);
  assert.equal(results[1], true);
  assert.equal(results[2], false);
  assert.deepEqual(hashSlotStats(), { active: 0, queued: 0 });
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
  assert.equal(await verifyPassword("pw", "scrypt:3:17:8:1:AAAA:AAAA"), false); // unknown version
  assert.equal(await verifyPassword("pw", "scrypt:1:onlyonepart"), false);
  assert.equal(await verifyPassword("pw", "scrypt:1::"), false); // empty salt + key
  assert.equal(await verifyPassword("pw", "scrypt:2:17:8:1:onlyonepart"), false);
  assert.equal(await verifyPassword("pw", "scrypt:2:17:8:1::"), false);
});

test("tampered stored key no longer verifies", async () => {
  const hash = await hashPassword("pw");
  const parts = hash.split(":");
  const key = Buffer.from(parts[6], "base64");
  key[0] ^= 0xff;
  parts[6] = key.toString("base64");
  assert.equal(await verifyPassword("pw", parts.join(":")), false);
});

test("tampered stored PARAMETERS no longer verify (they are part of what the key was derived with)", async () => {
  const hash = await hashPassword("pw");
  const parts = hash.split(":");
  parts[2] = "16";
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
  for (const prefix of ["scrypt:1:", "scrypt:2:17:8:1:"]) {
    assert.equal(await verifyPassword("pw", `${prefix}!!!!:!!!!`), false);
    assert.equal(await verifyPassword("pw", `${prefix}!!!!:AAAA`), false); // empty salt, valid key
    assert.equal(await verifyPassword("pw", `${prefix}AAAA:!!!!`), false); // valid salt, empty key
  }
});

test("too many colon-separated parts fails closed", async () => {
  // Complements the one-part case above: the part count is exact, both formats.
  assert.equal(await verifyPassword("pw", "scrypt:1:a:b:c"), false);
  assert.equal(await verifyPassword("pw", "scrypt:2:17:8:1:a:b:c"), false);
});

test("current behavior: verify honors the STORED key's length", async () => {
  // keylen is derived from the stored key's length, and scrypt's PBKDF2-SHA256
  // finalization has an output-prefix property: a hash whose stored key was
  // truncated (here to 16 bytes) STILL verifies for the correct password —
  // the comparison strength silently degrades to the stored length. Pinned as
  // current behavior: hash-row integrity is an assumption of the scheme, not
  // something verifyPassword checks. (needsRehash flags it, so the next
  // sign-in restores a full-length key.)
  const hash = await hashPassword("pw");
  const parts = hash.split(":");
  const truncated = Buffer.from(parts[6], "base64").subarray(0, 16);
  parts[6] = truncated.toString("base64");
  const shortHash = parts.join(":");
  assert.equal(await verifyPassword("pw", shortHash), true);
  assert.equal(await verifyPassword("wrong", shortHash), false);
  assert.equal(needsRehash(shortHash), true);
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

// ── the CLI scripts' copies ─────────────────────────────────────────────────
//
// The operator scripts ship standalone into the image (no app imports), so each
// keeps its own hashPassword between `>>> password-hash` and `<<< password-hash`
// markers. Run that exact block and judge its output with the APP's verifier: a
// copy left on old parameters or the old format would otherwise keep writing
// hashes that are rehashed on every first sign-in — or, worse, ones sign-in
// rejects, locking the operator out with the break-glass tool itself.
const SCRIPT_COPIES = ["scripts/reset-password.mjs", "scripts/create-user.mjs", "scripts/e2e-seed.mts"];

// stripTypeScriptTypes works but is still flagged experimental; keep its one-off
// warning out of the suite's output.
function stripTypes(code: string): string {
  const emit = process.emitWarning;
  process.emitWarning = ((warning: string | Error, ...rest: unknown[]) => {
    if (String(typeof warning === "string" ? warning : warning.message).includes("stripTypeScriptTypes")) return;
    (emit as (...args: unknown[]) => void).call(process, warning, ...rest);
  }) as typeof process.emitWarning;
  try {
    return stripTypeScriptTypes(code);
  } finally {
    process.emitWarning = emit;
  }
}

async function loadScriptHasher(path: string): Promise<(pw: string) => Promise<string>> {
  const source = readFileSync(new URL(`../${path}`, import.meta.url), "utf8");
  const start = source.indexOf("// >>> password-hash");
  const end = source.indexOf("// <<< password-hash");
  assert.ok(start >= 0 && end > start, `${path}: the password-hash markers are missing`);
  let block = source.slice(start, end);
  if (path.endsWith(".mts")) block = stripTypes(block);
  const factory = new Function("scrypt", "randomBytes", `${block}\nreturn hashPassword;`) as (
    s: typeof scrypt,
    r: typeof randomBytes,
  ) => (pw: string) => Promise<string>;
  return factory(scrypt, randomBytes);
}

for (const path of SCRIPT_COPIES) {
  test(`${path} hashes exactly like the app: verifies, current format, no rehash needed`, async () => {
    const hash = await (await loadScriptHasher(path))("operator-chosen-password");
    assert.match(hash, /^scrypt:2:17:8:1:/);
    assert.equal(await verifyPassword("operator-chosen-password", hash), true);
    assert.equal(await verifyPassword("something-else", hash), false);
    assert.equal(needsRehash(hash), false);
  });
}
