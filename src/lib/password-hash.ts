import { scrypt as scryptCb, randomBytes, timingSafeEqual } from "node:crypto";
import { promisify } from "node:util";
import { processSingleton } from "@/lib/process-singleton";

const scrypt = promisify(scryptCb) as (
  pw: string,
  salt: Buffer,
  keylen: number,
  opts: { N: number; r: number; p: number; maxmem: number },
) => Promise<Buffer>;

// Password hashing (guardrail 6i).
//
// Stored formats:
//   scrypt:2:<ln>:<r>:<p>:<salt>:<key>   N = 2^ln. What hashPassword writes.
//   scrypt:1:<salt>:<key>                legacy, parameters implied (2^15, 8, 1).
//
// v1 recorded no parameters, so its cost could never be raised: every stored
// hash had to verify with whatever the code said. v2 carries its own N/r/p, so a
// stored hash keeps verifying after the default moves, and needsRehash() tells a
// caller holding the plaintext (a successful sign-in) to upgrade it.

export interface ScryptParams {
  // log2(N): N must be a power of two, so the exponent is what's stored.
  ln: number;
  r: number;
  p: number;
}

// OWASP Password Storage Cheat Sheet's scrypt baseline: N=2^17, r=8, p=1 — 128
// MiB and ~180 ms per derivation on a current desktop CPU, longer on a NAS.
export const SCRYPT_PARAMS: Readonly<ScryptParams> = Object.freeze({ ln: 17, r: 8, p: 1 });
// What every scrypt:1 hash was written with.
export const LEGACY_V1_PARAMS: Readonly<ScryptParams> = Object.freeze({ ln: 15, r: 8, p: 1 });

const SCRYPT_KEYLEN = 64;
const SCRYPT_SALT_BYTES = 16;

const PREFIX_V1 = "scrypt:1:";
const PREFIX_V2 = "scrypt:2:";

// Bounds on parameters READ from a stored hash. A corrupted or restored row
// must not be able to make one sign-in allocate gigabytes or run for minutes.
const MIN_LN = 14;
const MAX_LN = 20;
const MAX_R = 16;
const MAX_P = 4;
const MAX_MEMORY_BYTES = 256 * 1024 * 1024;

// Shared upper bound for user-supplied passwords. Enforced identically on every
// write (register, password change) AND on credential sign-in, so a password that
// is accepted can always authenticate — a write cap above the sign-in cap would
// silently lock out anyone whose password landed in the gap. scrypt has no length
// limit of its own; this just bounds the work an unauthenticated caller can demand.
export const MAX_PASSWORD_LENGTH = 1024;

// ─── the hash slot ──────────────────────────────────────────────────────────
//
// At most MAX_CONCURRENT_HASHES derivations run at once, process-wide; the rest
// wait in FIFO order. Why bound it:
//   - scrypt runs on libuv's thread pool, 4 threads by default, which the whole
//     server shares with file reads, dns.lookup and zlib. A burst of sign-ins
//     (or a credential-stuffing flood, each attempt paying a full verify)
//     would otherwise hold every thread and stall unrelated requests.
//   - each derivation at the current cost allocates 128 MiB; four at once is
//     half a gigabyte on top of the app, enough to OOM a small container.
// Two keeps half the pool free and caps the hashing memory at 256 MiB. The
// queue itself is unbounded on purpose: the sign-in rate limits bound each
// source, and refusing a verify when it is full would turn a flood into a
// lockout of real users. Every derivation — real verify, dummy verify, hash —
// takes the same slot, so queueing adds the same delay to every path and can't
// tell an unknown account from a real one.
export const MAX_CONCURRENT_HASHES = 2;

interface HashGate {
  active: number;
  queue: Array<() => void>;
  // Total scrypt work (N·r·p) done by this process, for the cost pins.
  work: number;
}

// Process-wide, not per module copy (guardrail 27a): a Turbopack chunk that
// carried its own gate would get its own two slots.
const gate = processSingleton("password-hash:gate", (): HashGate => ({ active: 0, queue: [], work: 0 }));

async function withHashSlot<T>(fn: () => Promise<T>): Promise<T> {
  if (gate.active < MAX_CONCURRENT_HASHES) gate.active++;
  else await new Promise<void>((resolve) => gate.queue.push(resolve));
  try {
    return await fn();
  } finally {
    // Hand the slot straight to the next waiter (active stays the same), or free it.
    const next = gate.queue.shift();
    if (next) next();
    else gate.active--;
  }
}

/** Test seam: the hash slot's current occupancy. */
export function hashSlotStats(): { active: number; queued: number } {
  return { active: gate.active, queued: gate.queue.length };
}

/** Test seam: total scrypt work (N·r·p summed) this process has done. */
export function scryptWorkDone(): number {
  return gate.work;
}

function work(params: ScryptParams): number {
  return 2 ** params.ln * params.r * params.p;
}

// Node refuses a derivation whose memory (≈128·N·r, plus a little) reaches
// maxmem, so give it twice the nominal figure.
function maxmemFor(params: ScryptParams): number {
  return 2 * 128 * 2 ** params.ln * params.r;
}

async function derive(password: string, salt: Buffer, keylen: number, params: ScryptParams): Promise<Buffer> {
  const key = await scrypt(password, salt, keylen, {
    N: 2 ** params.ln,
    r: params.r,
    p: params.p,
    maxmem: maxmemFor(params),
  });
  gate.work += work(params);
  return key;
}

function encode(params: ScryptParams, salt: Buffer, key: Buffer): string {
  return `${PREFIX_V2}${params.ln}:${params.r}:${params.p}:${salt.toString("base64")}:${key.toString("base64")}`;
}

interface ParsedHash {
  version: 1 | 2;
  params: ScryptParams;
  salt: Buffer;
  key: Buffer;
}

const SMALL_INT = /^[1-9]\d?$/;

function parseParams(ln: string, r: string, p: string): ScryptParams | null {
  if (!SMALL_INT.test(ln) || !SMALL_INT.test(r) || !SMALL_INT.test(p)) return null;
  const params = { ln: Number(ln), r: Number(r), p: Number(p) };
  if (params.ln < MIN_LN || params.ln > MAX_LN) return null;
  if (params.r > MAX_R || params.p > MAX_P) return null;
  if (128 * 2 ** params.ln * params.r > MAX_MEMORY_BYTES) return null;
  return params;
}

function parseHash(hash: string): ParsedHash | null {
  let version: 1 | 2;
  let params: ScryptParams | null;
  let rest: string[];
  if (hash.startsWith(PREFIX_V2)) {
    const parts = hash.slice(PREFIX_V2.length).split(":");
    if (parts.length !== 5) return null;
    version = 2;
    params = parseParams(parts[0], parts[1], parts[2]);
    rest = parts.slice(3);
  } else if (hash.startsWith(PREFIX_V1)) {
    rest = hash.slice(PREFIX_V1.length).split(":");
    if (rest.length !== 2) return null;
    version = 1;
    params = LEGACY_V1_PARAMS;
  } else {
    return null;
  }
  if (!params) return null;
  // Buffer.from(s, "base64") silently drops invalid characters, so garbage
  // decodes to an EMPTY buffer rather than throwing — caught here.
  const salt = Buffer.from(rest[0], "base64");
  const key = Buffer.from(rest[1], "base64");
  if (salt.length === 0 || key.length === 0) return null;
  return { version, params, salt, key };
}

// Extra derivations that bring a verify against a CHEAPER hash up to the cost of
// one at SCRYPT_PARAMS. Without them a legacy scrypt:1 account verifies 4× faster
// than the unknown-account dummy, and the response time alone would tell an
// attacker which emails have an account (until each one signs in and is
// rehashed). Four 2^15 derivations take the same time as one 2^17 (measured:
// both ~178 ms), so padding at the stored parameters matches it closely.
const MAX_PADDING_ROUNDS = 15;
const PADDING_SALT = Buffer.alloc(SCRYPT_SALT_BYTES, 0);

function paddingRounds(params: ScryptParams): number {
  const rounds = Math.floor(work(SCRYPT_PARAMS) / work(params)) - 1;
  return Math.max(0, Math.min(MAX_PADDING_ROUNDS, rounds));
}

// Dummy used in failure paths so the response time is independent of whether
// the user exists. Computed once from a fixed salt at the CURRENT parameters,
// so a dummy verify costs exactly what a real one does.
let dummyHashPromise: Promise<string> | null = null;
function getDummyHash(): Promise<string> {
  if (!dummyHashPromise) {
    const salt = Buffer.alloc(SCRYPT_SALT_BYTES, 0);
    dummyHashPromise = withHashSlot(() => derive("dummy", salt, SCRYPT_KEYLEN, SCRYPT_PARAMS)).then((key) =>
      encode(SCRYPT_PARAMS, salt, key),
    );
    // A failed warm-up must not poison every later dummy verify.
    dummyHashPromise.catch(() => {
      dummyHashPromise = null;
    });
  }
  return dummyHashPromise;
}

// Warm the dummy hash at module load so the FIRST failure-path call doesn't pay
// an extra scrypt (getDummyHash + verify ≈ 2x) before the cache fills — that
// one-time doubling is the only timing divergence between the real-verify and
// dummy-verify paths. Errors are irrelevant here; the lazy path recomputes.
void getDummyHash().catch(() => {});

export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(SCRYPT_SALT_BYTES);
  const key = await withHashSlot(() => derive(password, salt, SCRYPT_KEYLEN, SCRYPT_PARAMS));
  return encode(SCRYPT_PARAMS, salt, key);
}

export async function verifyPassword(password: string, hash: string): Promise<boolean> {
  const parsed = parseHash(hash);
  if (!parsed) return false;
  return withHashSlot(async () => {
    const actual = await derive(password, parsed.salt, parsed.key.length, parsed.params);
    const ok = actual.length === parsed.key.length && timingSafeEqual(actual, parsed.key);
    // Run regardless of the outcome, inside the same slot.
    for (let i = paddingRounds(parsed.params); i > 0; i--) {
      await derive(password, PADDING_SALT, SCRYPT_KEYLEN, parsed.params);
    }
    return ok;
  });
}

// True when a stored hash should be replaced by hashPassword(<the plaintext>):
// a legacy format, other parameters than SCRYPT_PARAMS, or a salt/key of the
// wrong length. Only meaningful right after verifyPassword returned true.
export function needsRehash(hash: string): boolean {
  const parsed = parseHash(hash);
  if (!parsed || parsed.version !== 2) return true;
  const { ln, r, p } = parsed.params;
  if (ln !== SCRYPT_PARAMS.ln || r !== SCRYPT_PARAMS.r || p !== SCRYPT_PARAMS.p) return true;
  return parsed.salt.length !== SCRYPT_SALT_BYTES || parsed.key.length !== SCRYPT_KEYLEN;
}

// Constant-time dummy compare — same cost as verifyPassword on a current hash.
// Use in failure paths where the real verify branch wasn't reached, to make the
// overall response time independent of whether the user exists.
export async function dummyVerify(): Promise<void> {
  await verifyPassword("x", await getDummyHash());
}
