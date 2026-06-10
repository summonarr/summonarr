

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

import { isIP } from "node:net";
import { createHash } from "node:crypto";

function isValidIp(addr: string): boolean {
  return isIP(addr) !== 0;
}

// Number of trusted reverse proxies in front of the app. Used to pick the
// correct X-Forwarded-For entry. Defaults to 1.
function parseTrustedHops(value: string | undefined): number {
  const n = parseInt(value ?? "", 10);
  return Number.isNaN(n) || n < 1 ? 1 : n;
}

export function getClientIp(headers: Headers): string {
  if (process.env.TRUST_PROXY !== "true") return "unknown";

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

  // Fall back to a UA fingerprint so unauthenticated clients without a forwarded IP still share a bucket
  const ua = headers.get("user-agent") ?? "";
  return "unknown:" + createHash("sha256").update(ua).digest("hex").slice(0, 12);
}

export function parseRateLimit(value: string | null | undefined, defaultLimit: number): number {
  if (value === undefined || value === null || value.trim() === "") return defaultLimit;
  const n = parseInt(value, 10);
  return isNaN(n) || n < 0 ? defaultLimit : n;
}
