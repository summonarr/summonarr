import { isIP } from "node:net";
import { createHash } from "node:crypto";
import { processSingleton } from "./process-singleton";
import { warnOnChange } from "./log-dedup";
import { ipv6Groups } from "./ipv6-parse";

// Local-only mode (no TRUST_PROXY) is reported once at boot, by
// evaluateLocalOnlyStartup (local-only.ts). A warning at import here fired once
// per server chunk that bundled this module.

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
// code, a step-up password. They live OUTSIDE the shared map, in maps that never
// evict a bucket with live hits.
//
// Why: the shared map is LRU-bounded, and a bucket that is already FULL is
// never touched again (a refused attempt records nothing), so it drifts to the
// front of the eviction order. An attacker who spent a victim's `login-email:`
// budget only had to mint ~100k cheap new keys (any anonymous endpoint's per-IP
// or per-secret bucket) to evict it and get a fresh 50 guesses — repeatably.
//
// When a protected map is full of live buckets, a NEW key is refused (fail
// closed) rather than evicting a live one: an availability cost, against a
// security one (unbounded guessing) the other way round. So the protected maps
// are split by KEY CLASS, one map per class, and a flood can only ever fill and
// refuse its own class:
// - `login-email:` and `jellyfin-user:` are keyed on whatever email or username
//   was TYPED, account or not, so an anonymous caller mints one per attempt,
//   behind only the per-IP limit (a User-Agent bucket in local-only mode). Each
//   gets its own map: a username flood can't refuse password sign-in, and the
//   reverse.
// - Every other prefix is keyed on a user id that only a signed-in session or a
//   password-proven 2FA challenge supplies. Nobody mints those anonymously, so
//   that key space is bounded by the user table. They share one map, and a
//   sign-in flood can't stop a signed-in user revoking a session, stepping up,
//   enabling 2FA or changing their password.
// A new prefix names its class here; an anonymously mintable one gets its own.
type ProtectedClass = "login-email" | "jellyfin-user" | "user-id";

const PROTECTED_PREFIXES: ReadonlyArray<readonly [prefix: string, cls: ProtectedClass]> = [
  ["login-email:", "login-email"],
  ["jellyfin-user:", "jellyfin-user"],
  ["mfa-user:", "user-id"],
  ["profile-password:", "user-id"],
  ["profile-delete:", "user-id"],
  ["sessions-delete:", "user-id"],
  ["mfa-stepup:", "user-id"],
  ["mfa-totp-enable:", "user-id"],
  ["step-up-pw:", "user-id"],
];

interface ProtectedStore {
  cls: ProtectedClass;
  windows: Map<string, RateLimitEntry>;
  // When this store's full map was last re-swept (see PROTECTED_SWEEP_INTERVAL_MS).
  lastSweep: { at: number };
  // What a full store refuses, for the operator warning.
  refuses: string;
}

function protectedStore(cls: ProtectedClass, refuses: string): ProtectedStore {
  return {
    cls,
    windows: sweptMap(`rate-limit:protected-windows:${cls}`),
    lastSweep: processSingleton(`rate-limit:protected-last-sweep:${cls}`, () => ({ at: 0 })),
    refuses,
  };
}

const PROTECTED_STORES: Readonly<Record<ProtectedClass, ProtectedStore>> = {
  "login-email": protectedStore(
    "login-email",
    "local-password sign-in attempts for accounts not already in it are refused until buckets expire. This usually means a credential-stuffing flood.",
  ),
  "jellyfin-user": protectedStore(
    "jellyfin-user",
    "Jellyfin sign-in attempts for usernames not already in it are refused until buckets expire. This usually means a credential-stuffing flood.",
  ),
  "user-id": protectedStore(
    "user-id",
    "2FA, step-up, password-change and session-revocation attempts by users not already in it are refused until buckets expire.",
  ),
};

const MAX_KEYS = 100_000;
// Per protected class.
const MAX_PROTECTED_KEYS = 100_000;
// A full protected map is re-swept at most this often, so a flood of new keys
// against a full map costs one O(n) sweep per interval, not one per request.
const PROTECTED_SWEEP_INTERVAL_MS = 1_000;

function protectedStoreFor(key: string): ProtectedStore | null {
  for (const [prefix, cls] of PROTECTED_PREFIXES) {
    if (key.startsWith(prefix)) return PROTECTED_STORES[cls];
  }
  return null;
}

export function isProtectedRateLimitKey(key: string): boolean {
  return protectedStoreFor(key) !== null;
}

function mapFor(key: string): Map<string, RateLimitEntry> {
  return protectedStoreFor(key)?.windows ?? windows;
}

// Room for one NEW key in a protected class's map. A full map is re-swept for
// expired buckets (at most once per PROTECTED_SWEEP_INTERVAL_MS); if it is still
// full of live buckets the new key is refused — never a live bucket evicted to
// make room (guardrail 6e), so a spent guessing budget can't be handed back.
function protectedHasRoom(store: ProtectedStore, now: number): boolean {
  const map = store.windows;
  if (map.size < MAX_PROTECTED_KEYS) return true;
  if (now - store.lastSweep.at >= PROTECTED_SWEEP_INTERVAL_MS) {
    store.lastSweep.at = now;
    sweepExpired(map, now);
  }
  if (map.size < MAX_PROTECTED_KEYS) return true;
  warnOnChange(
    `rate-limit:protected-full:${store.cls}`,
    "full",
    `[rate-limit] the ${store.cls} limiter is full (${MAX_PROTECTED_KEYS} live buckets) — ${store.refuses}`,
  );
  return false;
}

// Room for one NEW key in the shared map: drop the least recently used key once
// it holds MAX_KEYS. Always succeeds — only cheap, re-mintable keys live here.
function evictForSharedKey(): void {
  if (windows.size < MAX_KEYS) return;
  const oldestKey = windows.keys().next().value;
  if (oldestKey !== undefined) windows.delete(oldestKey);
}

// Makes room for one NEW key in `store`'s map (the shared map when null).
// Returns false when it can't — only a protected store ever answers false.
function makeRoom(store: ProtectedStore | null, now: number): boolean {
  if (store) return protectedHasRoom(store, now);
  evictForSharedKey();
  return true;
}

// One key's bucket as of `now`, pruned to the hits still inside the window.
interface OpenBucket {
  store: ProtectedStore | null;
  map: Map<string, RateLimitEntry>;
  hits: number[];
  now: number;
}

// Reads `key`'s bucket. One with no live hits left is dropped from its map right
// here, so a key whose window lapsed starts fresh and its stale entry never
// holds a slot a new key needs.
function openBucket(key: string, windowMs: number): OpenBucket {
  const store = protectedStoreFor(key);
  const map = store?.windows ?? windows;
  const now = Date.now();
  const cutoff = now - windowMs;
  const hits = (map.get(key)?.hits ?? []).filter((t) => t > cutoff);
  if (hits.length === 0) map.delete(key);
  return { store, map, hits, now };
}

// Records one hit at `bucket.now`. A key with no live hits is NEW to its map and
// needs room first; returns false, recording nothing, when its full protected
// class can't take it.
// Most hits kept per key; far above any configured limit.
const MAX_HITS_PER_KEY = 10_000;

function recordHit(key: string, bucket: OpenBucket, windowMs: number): boolean {
  if (bucket.hits.length === 0 && !makeRoom(bucket.store, bucket.now)) return false;
  bucket.hits.push(bucket.now);
  // recordFailure has no limit check, so a key hammered with failures would
  // otherwise grow (and be re-filtered on every open) without bound.
  if (bucket.hits.length > MAX_HITS_PER_KEY) bucket.hits.splice(0, bucket.hits.length - MAX_HITS_PER_KEY);
  // Delete then re-insert to move the key to the end of the Map's order: the
  // shared map evicts from the front, so this marks it recently used.
  bucket.map.delete(key);
  bucket.map.set(key, { hits: bucket.hits, expiresAt: bucket.now + windowMs });
  return true;
}

// Sliding-window rate limiter: records a hit for `key` and returns true, or
// returns false (recording nothing) once `limit` hits already fall within the
// last `windowMs`. The shared map keeps at most MAX_KEYS keys, dropping the
// least recently used first; per-account buckets (PROTECTED_PREFIXES) are never
// dropped while live — a full class refuses new keys instead.
export function checkRateLimit(key: string, limit: number, windowMs: number): boolean {
  return reserveRateLimit(key, limit, windowMs) !== null;
}

// checkRateLimit that also hands back the timestamp of the hit it recorded
// (null = refused), so a caller that later refunds can give back ITS OWN hit.
// A limit <= 0 means unlimited: nothing is recorded and the timestamp is 0, which
// refundHit treats as "nothing to remove".
export function reserveRateLimit(key: string, limit: number, windowMs: number): number | null {
  if (limit <= 0) return 0;
  const bucket = openBucket(key, windowMs);
  if (bucket.hits.length >= limit) return null;
  return recordHit(key, bucket, windowMs) ? bucket.now : null;
}

// Read-only counterpart of checkRateLimit: returns whether the key is still
// under `limit` within the window WITHOUT pushing a hit. Use to GATE entry to a
// flow when the hit should only be recorded on a real failure (e.g. the
// account-level login bucket records a hit only on an actual failed password
// verify — see authorizeWithCredentials). Pairs with recordFailure.
export function peekRateLimit(key: string, limit: number, windowMs: number): boolean {
  if (limit <= 0) return true;
  const bucket = openBucket(key, windowMs);
  if (bucket.hits.length > 0) return bucket.hits.length < limit;
  // A new per-account key that its full protected class could not take must
  // not read as "room left" — the gate fails closed exactly as reserve does.
  // (Only a protected store: making room in the shared map would evict a key
  // without inserting one.)
  return bucket.store ? protectedHasRoom(bucket.store, bucket.now) : true;
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
// peekRateLimit first. A full protected class can't take a new key, so the
// failure has nowhere to go — and the next gate (peek/reserve) for that key
// refuses anyway.
export function recordFailure(key: string, windowMs: number): void {
  recordHit(key, openBucket(key, windowMs), windowMs);
}

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
export const MAX_TRUSTED_HOPS = 5;
export function parseTrustedHops(value: string | undefined): number {
  const n = parseInt(value ?? "", 10);
  if (Number.isNaN(n) || n < 1) return 1;
  return Math.min(n, MAX_TRUSTED_HOPS);
}

/**
 * The boot warning for TRUSTED_PROXY_HOPS (null when there is nothing to say).
 * parseTrustedHops quietly turns a typo ("abc", "0", "-1", "3abc") into 1 hop
 * and an oversized value into MAX_TRUSTED_HOPS, so the operator is told what
 * the app actually uses. Above 3 is unusual: each hop is one more
 * X-Forwarded-For entry trusted for the client IP, and too many lets a client
 * spoof its address. Warn-only; parseTrustedHops is the backstop.
 */
export function trustedProxyHopsWarning(raw: string | undefined): string | null {
  const typed = raw?.trim() ?? "";
  if (!typed) return null;
  const hops = parseTrustedHops(typed);
  const advice = "Set it to the actual number of trusted proxies in front of the app.";
  const spoof =
    "Each hop is an X-Forwarded-For entry trusted for client-IP derivation; an over-generous value lets clients spoof their IP.";
  if (String(hops) !== typed) {
    return parseInt(typed, 10) > MAX_TRUSTED_HOPS
      ? `[startup] TRUSTED_PROXY_HOPS=${JSON.stringify(typed)} is above the maximum of ${MAX_TRUSTED_HOPS}; using ${hops}. ${spoof} ${advice}`
      : `[startup] TRUSTED_PROXY_HOPS=${JSON.stringify(typed)} is not a whole number from 1 to ${MAX_TRUSTED_HOPS}; using ${hops}. ${advice}`;
  }
  if (hops > 3) {
    return `[startup] TRUSTED_PROXY_HOPS=${hops} is unusually high (>3). ${spoof} The maximum is ${MAX_TRUSTED_HOPS}. ${advice}`;
  }
  return null;
}

// Bucket key for clients whose IP can't be trusted (TRUST_PROXY off, or no
// trustworthy forwarded address). Keyed on a UA hash so distinct clients land in
// distinct buckets instead of every caller sharing one global "unknown" bucket —
// the UA is still spoofable, so this is coarse abuse-isolation, not a real per-IP
// limit, but it stops a single noisy client from exhausting everyone's quota.
// A client that rotates its UA gets a fresh bucket each time; what bounds
// guessing then is the per-credential buckets (PROTECTED_PREFIXES, plus the
// token/secret-keyed ones), never this one. Local-only mode is a LAN deployment
// the operator opts into (evaluateLocalOnlyStartup); behind a reverse proxy,
// TRUST_PROXY=true keys these buckets on the real address.
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
  // address, or every mapped-v4 client would share one all-zero /64 bucket
  // (the same /64 as ::1). Dotted `::ffff:a.b.c.d`, hex-pair `::ffff:cb00:7107`,
  // and the expanded `0:0:0:0:0:ffff:…` form are the same address.
  const groups = ipv6Groups(ip);
  if (groups) {
    const embedded = ipv4FromMappedGroups(groups);
    if (embedded) return embedded;
    return `v6:${groups.slice(0, 4).map((g) => g.toString(16).padStart(4, "0")).join(":")}`;
  }
  return ip;
}

// The /64 prefix and the v4-mapped unwrap both read ipv6Groups (the parser
// the SSRF policy and the IP allowlist use), so the spellings of one address
// cannot disagree.
// IPv4-mapped IPv6 (::ffff:a.b.c.d / ::ffff:aabb:ccdd): 80 bits of zero, then
// 0xffff, then the IPv4 address. SIIT (::ffff:0:a.b.c.d) is a different
// prefix and is not folded here — it still gets a /64 key.
function ipv4FromMappedGroups(n: readonly number[]): string | null {
  if (n[0] !== 0 || n[1] !== 0 || n[2] !== 0 || n[3] !== 0 || n[4] !== 0 || n[5] !== 0xffff) return null;
  return `${(n[6] >> 8) & 255}.${n[6] & 255}.${(n[7] >> 8) & 255}.${n[7] & 255}`;
}

export function parseRateLimit(value: string | null | undefined, defaultLimit: number): number {
  if (value === undefined || value === null || value.trim() === "") return defaultLimit;
  const n = parseInt(value, 10);
  return isNaN(n) || n < 0 ? defaultLimit : n;
}
