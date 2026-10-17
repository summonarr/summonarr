import { processSingleton } from "./process-singleton";
import { warnOnChange } from "./log-dedup";

if (process.env.TRUST_PROXY !== "true") {
  console.warn(
    "[rate-limit] TRUST_PROXY is not set to 'true' — clients are rate-limited by User-Agent " +
    "instead of IP address. Set TRUST_PROXY=true when running behind a trusted reverse proxy (Nginx, Traefik, etc.) " +
    "that reliably sets X-Forwarded-For. Without it, per-IP limiting is disabled."
  );
}

interface RateLimitEntry {
  hits: number[];
  expiresAt: number;
}

// One map for the whole process (see process-singleton.ts). Next.js copies this
// module into every server bundle ("chunk") that imports it. A plain
// module-level Map would give each chunk its own counters, so a key used by two
// routes would get twice the intended limit.
function sweptMap(name: string): Map<string, RateLimitEntry> {
  return processSingleton(name, () => {
    const map = new Map<string, RateLimitEntry>();
    // One cleanup timer per process, created with the map. .unref() lets Node
    // exit (tests, shutdown) without waiting for this timer.
    setInterval(() => sweepExpired(map, Date.now()), 60_000).unref();
    return map;
  });
}

function sweepExpired(map: Map<string, RateLimitEntry>, now: number): void {
  for (const [key, entry] of map) {
    if (entry.expiresAt < now) map.delete(key);
  }
}

const windows = sweptMap("rate-limit:windows");

// Buckets that bound guessing ONE account's secret: a password, a second-factor
// code, a step-up password. They live in their OWN map that never evicts a
// bucket with live hits.
//
// Why: the shared map is LRU-bounded, and a bucket that is already FULL is
// never touched again (a refused attempt records nothing), so it drifts to the
// front of the eviction order. An attacker who spent a victim's `login-email:`
// budget only had to mint ~100k cheap new keys (any anonymous endpoint's per-IP
// or per-secret bucket) to evict it and get a fresh 50 guesses — repeatably.
// Flooding THIS map instead takes one real attempt per distinct account per
// window, each behind its own per-IP limit and (for passwords) a full scrypt.
//
// When this map is full of live buckets, a NEW account's attempt is refused
// (fail closed) rather than evicting a live one — an availability cost only
// under a flood that already saturates the password hasher, against a security
// one (unbounded guessing) the other way round.
const PROTECTED_PREFIXES = [
  "login-email:",
  "mfa-user:",
  "jellyfin-user:",
  "profile-password:",
  "profile-delete:",
  "sessions-delete:",
  "mfa-stepup:",
  "mfa-totp-enable:",
  "step-up-pw:",
] as const;

const protectedWindows = sweptMap("rate-limit:protected-windows");

const MAX_KEYS = 100_000;
const MAX_PROTECTED_KEYS = 100_000;
// A full protected map is re-swept at most this often, so a flood of new keys
// against a full map costs one O(n) sweep per interval, not one per request.
const PROTECTED_SWEEP_INTERVAL_MS = 1_000;
const lastProtectedSweep = processSingleton("rate-limit:protected-last-sweep", () => ({ at: 0 }));

export function isProtectedRateLimitKey(key: string): boolean {
  return PROTECTED_PREFIXES.some((p) => key.startsWith(p));
}

function mapFor(key: string): Map<string, RateLimitEntry> {
  return isProtectedRateLimitKey(key) ? protectedWindows : windows;
}

// Makes room for one NEW key in `map`. Returns false when it can't — only the
// protected map ever answers false.
function makeRoom(map: Map<string, RateLimitEntry>, now: number): boolean {
  if (map === protectedWindows) {
    if (map.size < MAX_PROTECTED_KEYS) return true;
    if (now - lastProtectedSweep.at >= PROTECTED_SWEEP_INTERVAL_MS) {
      lastProtectedSweep.at = now;
      sweepExpired(map, now);
    }
    if (map.size < MAX_PROTECTED_KEYS) return true;
    warnOnChange(
      "rate-limit:protected-full",
      "full",
      `[rate-limit] the per-account limiter is full (${MAX_PROTECTED_KEYS} live buckets) — new accounts' sign-in attempts are refused until buckets expire. This usually means a credential-stuffing flood.`,
    );
    return false;
  }
  if (map.size >= MAX_KEYS) {
    const oldestKey = map.keys().next().value;
    if (oldestKey !== undefined) map.delete(oldestKey);
  }
  return true;
}

// Sliding-window rate limiter: records a hit for `key` and returns true, or
// returns false (recording nothing) once `limit` hits already fall within the
// last `windowMs`. The shared map keeps at most MAX_KEYS keys, dropping the
// least recently used first; per-account buckets (PROTECTED_PREFIXES) are never
// dropped while live.
export function checkRateLimit(key: string, limit: number, windowMs: number): boolean {
  return reserveRateLimit(key, limit, windowMs) !== null;
}

// checkRateLimit that also hands back the timestamp of the hit it recorded
// (null = refused), so a caller that later refunds can give back ITS OWN hit.
// A limit <= 0 means unlimited: nothing is recorded and the timestamp is 0, which
// refundHit treats as "nothing to remove".
export function reserveRateLimit(key: string, limit: number, windowMs: number): number | null {
  if (limit <= 0) return 0;
  const map = mapFor(key);
  const now = Date.now();
  const cutoff = now - windowMs;
  const entry = map.get(key);
  const hits = (entry?.hits ?? []).filter((t) => t > cutoff);
  if (hits.length === 0) map.delete(key);
  if (hits.length >= limit) return null;

  if (hits.length === 0 && !makeRoom(map, now)) return null;
  hits.push(now);
  // Delete then re-insert to move the key to the end of the Map's order; the
  // eviction above drops keys from the front, so this marks it recently used.
  map.delete(key);
  map.set(key, { hits, expiresAt: now + windowMs });
  return now;
}

// Read-only counterpart of checkRateLimit: returns whether the key is still
// under `limit` within the window WITHOUT pushing a hit. Use to GATE entry to a
// flow when the hit should only be recorded on a real failure (e.g. the
// account-level login bucket records a hit only on an actual failed password
// verify — see authorizeWithCredentials). Pairs with recordFailure.
export function peekRateLimit(key: string, limit: number, windowMs: number): boolean {
  if (limit <= 0) return true;
  const map = mapFor(key);
  const now = Date.now();
  const cutoff = now - windowMs;
  const entry = map.get(key);
  const hits = (entry?.hits ?? []).filter((t) => t > cutoff);
  if (hits.length === 0) {
    map.delete(key);
    // A new per-account key that a full protected map could not take must not
    // read as "room left" — the gate fails closed exactly as reserve does.
    // (Only the protected map: makeRoom on the shared map would evict a key
    // without inserting one.)
    return map === protectedWindows ? makeRoom(map, now) : true;
  }
  return hits.length < limit;
}

// Removes the most recent hit for `key`: "this attempt was fine after all".
// Why not just peek first and record later? The password check in between is
// async, so many concurrent attempts could all peek, all see room, and all get
// through. Instead the caller reserves a hit with checkRateLimit (check and
// record in one step) and refunds it here on success, so a SUCCESSFUL login
// still doesn't use up the account's budget.
//
// Pass `hitAt` (the value reserveRateLimit returned) to remove THAT hit. Without
// it the newest hit is popped, which under concurrency can be ANOTHER caller's
// failed attempt: a victim's successful sign-in would then erase an attacker's
// later failure and leave its own older timestamp, which expires sooner — the
// attacker's guess budget refills early. A hit that already aged out of the
// window is simply not found, so nothing else is removed.
export function refundHit(key: string, hitAt?: number): void {
  const map = mapFor(key);
  const entry = map.get(key);
  if (!entry || entry.hits.length === 0) return;
  if (hitAt !== undefined) {
    if (hitAt === 0) return;
    const i = entry.hits.indexOf(hitAt);
    if (i === -1) return;
    entry.hits.splice(i, 1);
  } else {
    entry.hits.pop();
  }
  if (entry.hits.length === 0) map.delete(key);
}

// Records one hit for `key` (the "record" half of peek-then-record). Same
// bookkeeping as checkRateLimit, but with no limit check: callers check with
// peekRateLimit first.
export function recordFailure(key: string, windowMs: number): void {
  const map = mapFor(key);
  const now = Date.now();
  const cutoff = now - windowMs;
  const entry = map.get(key);
  const hits = (entry?.hits ?? []).filter((t) => t > cutoff);

  // A full protected map can't take a new key; the failure has nowhere to go,
  // and the next gate (peek/reserve) for that key refuses anyway (makeRoom).
  if (hits.length === 0 && !makeRoom(map, now)) return;
  hits.push(now);
  // Move the key to the end of the Map's order (see checkRateLimit).
  map.delete(key);
  map.set(key, { hits, expiresAt: now + windowMs });
}

import { isIP } from "node:net";
import { createHash } from "node:crypto";

function isValidIp(addr: string): boolean {
  return isIP(addr) !== 0;
}

// Number of trusted reverse proxies in front of the app. Used to pick the
// correct X-Forwarded-For entry. Defaults to 1. Capped at MAX_TRUSTED_HOPS: a
// hop count larger than the real proxy chain selects an entry FURTHER LEFT in
// X-Forwarded-For — i.e. a client-forgeable address — re-opening the IP-spoof
// hole getClientIp exists to close. No realistic deployment fronts the app with
// more than a handful of trusted proxies, so we clamp rather than trust an
// oversized configured value.
const MAX_TRUSTED_HOPS = 5;
function parseTrustedHops(value: string | undefined): number {
  const n = parseInt(value ?? "", 10);
  if (Number.isNaN(n) || n < 1) return 1;
  return Math.min(n, MAX_TRUSTED_HOPS);
}

// Bucket key for clients whose IP can't be trusted (TRUST_PROXY off, or no
// trustworthy forwarded address). Keyed on a UA hash so distinct clients land in
// distinct buckets instead of every caller sharing one global "unknown" bucket —
// the UA is still spoofable, so this is coarse abuse-isolation, not a real per-IP
// limit, but it stops a single noisy client from exhausting everyone's quota.
function untrustedBucket(headers: Headers): string {
  const ua = headers.get("user-agent") ?? "";
  return "unknown:" + createHash("sha256").update(ua).digest("hex").slice(0, 12);
}

export function getClientIp(headers: Headers): string {
  if (process.env.TRUST_PROXY !== "true") return untrustedBucket(headers);

  // X-Forwarded-For is an APPEND chain: each proxy appends the address of the
  // peer that connected to *it*. Behind N trusted proxies the only trustworthy
  // client IP is the Nth entry FROM THE RIGHT — entries further left are sent by
  // the client and are forgeable. Taking the leftmost (`split(",")[0]`) let any
  // caller spoof an arbitrary IP via `X-Forwarded-For: 1.2.3.4`, which defeats
  // every IP-keyed rate limiter and the machine-session IP allowlist and
  // poisons audit/device-tracking rows. Set TRUSTED_PROXY_HOPS to the number of
  // proxies in front of the app (default 1).
  const hops = parseTrustedHops(process.env.TRUSTED_PROXY_HOPS);
  const xff = headers.get("x-forwarded-for");
  if (xff) {
    const parts = xff.split(",").map((p) => p.trim()).filter(Boolean);
    if (parts.length > 0) {
      // Clamp to the leftmost entry we actually have when the chain is shorter
      // than the configured hop count — never index before the start.
      const candidate = parts[Math.max(0, parts.length - hops)];
      if (candidate && isValidIp(candidate)) return candidate;
    }
  }
  // X-Real-IP is a single value set by the immediate upstream proxy (not a
  // chain); trustworthy only when that proxy overwrites it, same TRUST_PROXY gate.
  const realIp = headers.get("x-real-ip")?.trim();
  if (realIp && isValidIp(realIp)) return realIp;

  // No trustworthy forwarded address — fall back to the UA bucket.
  return untrustedBucket(headers);
}

// Rate-limit BUCKET key for the client address. IPv4 keys on the full address;
// IPv6 keys on the /64 prefix — the standard residential/VPS delegation hands
// one holder 2^64 addresses, so a full-address key lets that holder mint a
// fresh, empty bucket per request and rotate straight past every IP-keyed
// limiter (register, oidc-start, quickconnect, …). Audit rows, device tracking
// and the machine-session IP allowlist keep the exact address via getClientIp;
// ONLY limiter keys collapse to the prefix.
export function getClientIpKey(headers: Headers): string {
  return ipBucketKey(getClientIp(headers));
}

export function ipBucketKey(ip: string): string {
  if (isIP(ip) !== 6) return ip; // IPv4 and the "unknown:" UA bucket pass through
  // A v4-mapped literal is really an IPv4 client — key on the embedded
  // address, or every mapped-v4 client would share one all-zero /64 bucket.
  const mapped = ip.toLowerCase().match(/^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/);
  if (mapped) return mapped[1];
  const prefix = ipv6Prefix64(ip);
  return prefix ? `v6:${prefix}` : ip;
}

// The first four groups (the /64 prefix, "xxxx:xxxx:xxxx:xxxx") of an IPv6
// address, written out in full. Returns null if the address can't be expanded;
// the caller then uses the full address, which can only make buckets narrower,
// never wider.
function ipv6Prefix64(ip: string): string | null {
  const pct = ip.indexOf("%"); // zone index (fe80::1%eth0)
  let s = (pct === -1 ? ip : ip.slice(0, pct)).toLowerCase();
  // Embedded dotted-quad tail (64:ff9b::1.2.3.4) → two hextets
  const v4 = s.match(/(\d{1,3}(?:\.\d{1,3}){3})$/);
  if (v4) {
    const oct = v4[1].split(".").map(Number);
    if (oct.some((o) => o > 255)) return null;
    s =
      s.slice(0, s.length - v4[1].length) +
      ((oct[0] << 8) | oct[1]).toString(16) + ":" + ((oct[2] << 8) | oct[3]).toString(16);
  }
  const halves = s.split("::");
  if (halves.length > 2) return null;
  const head = halves[0] ? halves[0].split(":") : [];
  const tail = halves.length === 2 && halves[1] ? halves[1].split(":") : [];
  const groups =
    halves.length === 2
      ? [...head, ...Array(Math.max(0, 8 - head.length - tail.length)).fill("0"), ...tail]
      : head;
  if (groups.length !== 8 || groups.some((g) => !/^[0-9a-f]{1,4}$/.test(g))) return null;
  return groups.slice(0, 4).map((g) => g.padStart(4, "0")).join(":");
}

export function parseRateLimit(value: string | null | undefined, defaultLimit: number): number {
  if (value === undefined || value === null || value.trim() === "") return defaultLimit;
  const n = parseInt(value, 10);
  return isNaN(n) || n < 0 ? defaultLimit : n;
}
