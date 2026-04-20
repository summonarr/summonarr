

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

function isValidIp(addr: string): boolean {
  return isIP(addr) !== 0;
}

export function getClientIp(headers: Headers): string {
  if (process.env.TRUST_PROXY !== "true") return "unknown";

  const xff = headers.get("x-forwarded-for")?.split(",")[0]?.trim();
  if (xff && isValidIp(xff)) return xff;
  const realIp = headers.get("x-real-ip")?.trim();
  if (realIp && isValidIp(realIp)) return realIp;

  // Fall back to a UA fingerprint so unauthenticated clients without a forwarded IP still share a bucket
  const ua = headers.get("user-agent") ?? "";
  const { createHash } = require("node:crypto") as typeof import("node:crypto");
  return "unknown:" + createHash("sha256").update(ua).digest("hex").slice(0, 12);
}

export function parseRateLimit(value: string | null | undefined, defaultLimit: number): number {
  if (value === undefined || value === null || value.trim() === "") return defaultLimit;
  const n = parseInt(value, 10);
  return isNaN(n) || n < 0 ? defaultLimit : n;
}
