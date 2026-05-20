import { scrypt as scryptCb, randomBytes, timingSafeEqual } from "node:crypto";
import { promisify } from "node:util";
import bcrypt from "bcryptjs";

const scrypt = promisify(scryptCb) as (
  pw: string,
  salt: Buffer,
  keylen: number,
  opts: { N: number; r: number; p: number; maxmem: number },
) => Promise<Buffer>;

// scrypt cost ~ matches bcrypt cost 12 (~250ms on a modern CPU)
const SCRYPT_N = 1 << 15;
const SCRYPT_R = 8;
const SCRYPT_P = 1;
const SCRYPT_KEYLEN = 64;
const SCRYPT_SALT_BYTES = 16;
const SCRYPT_MAXMEM = 64 * 1024 * 1024;

const PREFIX = "scrypt:1:";

// Dummy used in failure paths so the response time is independent of whether
// the user exists. Computed once on first call from a fixed salt and the
// production scrypt parameters, so timing matches a real verify exactly.
// Legacy bcrypt verifications during the transition are slightly slower; that
// timing delta closes as users sign in and rehash via verifyAndMaybeRehash.
let dummyHashPromise: Promise<string> | null = null;
function getDummyHash(): Promise<string> {
  if (!dummyHashPromise) {
    const salt = Buffer.alloc(SCRYPT_SALT_BYTES, 0);
    dummyHashPromise = scrypt("dummy", salt, SCRYPT_KEYLEN, {
      N: SCRYPT_N,
      r: SCRYPT_R,
      p: SCRYPT_P,
      maxmem: SCRYPT_MAXMEM,
    }).then((key) => `${PREFIX}${salt.toString("base64")}:${key.toString("base64")}`);
  }
  return dummyHashPromise;
}

export function isLegacyHash(hash: string): boolean {
  return hash.startsWith("$2");
}

export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(SCRYPT_SALT_BYTES);
  const key = await scrypt(password, salt, SCRYPT_KEYLEN, {
    N: SCRYPT_N,
    r: SCRYPT_R,
    p: SCRYPT_P,
    maxmem: SCRYPT_MAXMEM,
  });
  return `${PREFIX}${salt.toString("base64")}:${key.toString("base64")}`;
}

export async function verifyPassword(password: string, hash: string): Promise<boolean> {
  if (hash.startsWith(PREFIX)) {
    const parts = hash.slice(PREFIX.length).split(":");
    if (parts.length !== 2) return false;
    const salt = Buffer.from(parts[0], "base64");
    const expected = Buffer.from(parts[1], "base64");
    if (salt.length === 0 || expected.length === 0) return false;
    const actual = await scrypt(password, salt, expected.length, {
      N: SCRYPT_N,
      r: SCRYPT_R,
      p: SCRYPT_P,
      maxmem: SCRYPT_MAXMEM,
    });
    if (actual.length !== expected.length) return false;
    return timingSafeEqual(actual, expected);
  }
  if (isLegacyHash(hash)) {
    return bcrypt.compare(password, hash);
  }
  return false;
}

// Verify the password against the stored hash and, on success against a legacy
// bcrypt hash, return a fresh scrypt hash the caller should persist back to the
// database. This is the on-login rehash path; non-login flows can use
// verifyPassword directly.
export async function verifyAndMaybeRehash(
  password: string,
  hash: string,
): Promise<{ valid: boolean; rehashed: string | null }> {
  const valid = await verifyPassword(password, hash);
  if (valid && isLegacyHash(hash)) {
    return { valid, rehashed: await hashPassword(password) };
  }
  return { valid, rehashed: null };
}

// Constant-time dummy compare — same cost as verifyPassword on a scrypt hash.
// Use in failure paths where the real verify branch wasn't reached, to make the
// overall response time independent of whether the user exists.
export async function dummyVerify(): Promise<void> {
  await verifyPassword("x", await getDummyHash());
}
