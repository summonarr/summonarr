

if (process.env.TRUST_PROXY !== "true") {
  console.warn(
    "[rate-limit] TRUST_PROXY is not set to 'true' — all requests share a single rate-limit " +
    "bucket. Set TRUST_PROXY=true when running behind a trusted reverse proxy (Nginx, Traefik, etc.) " +
    "that reliably sets X-Forwarded-For. Without it, per-IP limiting is disabled."
  );
}

interface RateLimitEntry {
  hits: number[];
  expiresAt: number;
}

const windows = new Map<string, RateLimitEntry>();

const MAX_KEYS = 100_000;

// .unref() so this timer doesn't prevent Node from exiting during tests or graceful shutdown
setInterval(() => {
  const now = Date.now();
  for (const [key, entry] of windows) {
    if (entry.expiresAt < now) windows.delete(key);
  }
}, 60_000).unref();

// Sliding-window rate limiter: records a hit for `key` and returns false once
// `limit` hits fall within `windowMs`. Bounded by MAX_KEYS via LRU eviction.
export function checkRateLimit(key: string, limit: number, windowMs: number): boolean {
  if (limit <= 0) return true;
  const now = Date.now();
  const cutoff = now - windowMs;
  const entry = windows.get(key);
  const hits = (entry?.hits ?? []).filter((t) => t > cutoff);
  if (hits.length === 0) windows.delete(key);
  if (hits.length >= limit) return false;

  if (hits.length === 0 && windows.size >= MAX_KEYS) {
    const oldestKey = windows.keys().next().value;
    if (oldestKey !== undefined) windows.delete(oldestKey);
  }
  hits.push(now);
  // Delete then re-insert to move the key to the end of Map insertion order (used by LRU eviction above)
  windows.delete(key);
  windows.set(key, { hits, expiresAt: now + windowMs });
  return true;
}

// Read-only counterpart of checkRateLimit: returns whether the key is still
// under `limit` within the window WITHOUT pushing a hit. Use to GATE entry to a
// flow when the hit should only be recorded on a real failure (e.g. the
// account-level login bucket records a hit only on an actual failed password
// verify — see authorizeWithCredentials). Pairs with recordFailure.
export function peekRateLimit(key: string, limit: number, windowMs: number): boolean {
  if (limit <= 0) return true;
  const now = Date.now();
  const cutoff = now - windowMs;
  const entry = windows.get(key);
  const hits = (entry?.hits ?? []).filter((t) => t > cutoff);
  if (hits.length === 0) windows.delete(key);
  return hits.length < limit;
}

// Pushes a single hit for `key` (the "record a failure" half of the
// peek/record split). Same Map/window/LRU bookkeeping as checkRateLimit's
// recording path, minus the over-limit short-circuit — callers gate with
// peekRateLimit first. No-op when limit semantics are disabled at the callsite.
// Removes the most recent hit for `key` — the "this attempt turned out to be
// legitimate" half of an atomic reserve-then-refund. Exists because peek-then-record is
// NOT atomic across concurrent requests: peekRateLimit is synchronous, but the password
// verify between it and recordFailure is awaited, so N concurrent attempts all observe
// an under-limit bucket and all proceed. Reserving with checkRateLimit (which checks and
// pushes in one synchronous step) and refunding on success closes that window while
// keeping the original intent — a SUCCESSFUL login must not consume the account bucket.
export function refundHit(key: string): void {
  const entry = windows.get(key);
  if (!entry || entry.hits.length === 0) return;
  entry.hits.pop();
  if (entry.hits.length === 0) windows.delete(key);
}

export function recordFailure(key: string, windowMs: number): void {
  const now = Date.now();
  const cutoff = now - windowMs;
  const entry = windows.get(key);
  const hits = (entry?.hits ?? []).filter((t) => t > cutoff);

  if (hits.length === 0 && windows.size >= MAX_KEYS) {
    const oldestKey = windows.keys().next().value;
    if (oldestKey !== undefined) windows.delete(oldestKey);
  }
  hits.push(now);
  // Delete then re-insert to move the key to the end of Map insertion order (used by LRU eviction above)
  windows.delete(key);
  windows.set(key, { hits, expiresAt: now + windowMs });
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

// Canonical /64 prefix ("xxxx:xxxx:xxxx:xxxx") of a syntactically valid IPv6
// address; null when the shape defeats expansion (callers then fall back to the
// full address, which only ever under-shares a bucket, never over-shares one).
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
