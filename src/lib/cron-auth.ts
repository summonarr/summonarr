import { NextRequest } from "next/server";
import { createHash, timingSafeEqual } from "node:crypto";
import { readActiveSummonarrSessionFromRequest } from "@/lib/session-server";
import { matchesStoredFingerprint } from "@/lib/ua-fingerprint";
import { checkRateLimit, getClientIp } from "@/lib/rate-limit";
import { prisma } from "@/lib/prisma";

// Hash both sides first so timingSafeEqual compares equal-length buffers regardless of input length
function safeCompareStrings(a: string, b: string): boolean {
  const ha = createHash("sha256").update(a).digest();
  const hb = createHash("sha256").update(b).digest();
  return timingSafeEqual(ha, hb);
}

// Cron/sync routes are excluded from the proxy.ts CSRF guard (cron containers POST
// without an Origin header). The Bearer-token path is unconditional because callers
// hold a strong server-side secret; the admin-session path must enforce its own
// same-origin check, otherwise a malicious site can drive a logged-in admin's
// browser to POST /api/sync via cookie auth.
const sessionOriginCache = new Map<string, ReadonlySet<string>>();

function buildSessionTrustedOrigins(selfOrigin: string): ReadonlySet<string> {
  const cached = sessionOriginCache.get(selfOrigin);
  if (cached) return cached;
  const trusted = new Set<string>();
  for (const raw of [
    process.env.AUTH_URL,
    ...(process.env.AUTH_TRUSTED_ORIGIN ?? "").split(","),
  ]) {
    const trimmed = raw?.trim();
    if (!trimmed) continue;
    try { trusted.add(new URL(trimmed).origin); } catch { }
  }
  if (trusted.size === 0) trusted.add(selfOrigin);
  const frozen: ReadonlySet<string> = trusted;
  sessionOriginCache.set(selfOrigin, frozen);
  return frozen;
}

function isSameOriginRequest(request: NextRequest): boolean {
  const origin = request.headers.get("origin");
  let effectiveOrigin = origin;
  if (!effectiveOrigin) {
    const referer = request.headers.get("referer");
    if (referer) {
      try { effectiveOrigin = new URL(referer).origin; } catch { }
    }
  }
  if (!effectiveOrigin) return false;
  const trusted = buildSessionTrustedOrigins(request.nextUrl.origin);
  return trusted.has(effectiveOrigin);
}

// Every cron/sync route funnels through this — accepts an active admin session OR a Bearer CRON_SECRET.
// These routes are in proxy.ts's isPublicPath(), so the proxy does NOT DB-validate the session;
// readActiveSummonarrSessionFromRequest() does (bearer-first then cookie, revocation/cutoff/role-demotion
// honored immediately), not auth() which would trust a revoked admin's JWT until its exp (up to the 7d
// admin ceiling). A presented-but-wrong Bearer is throttled per IP to bound CRON_SECRET guessing.
export async function isCronAuthorized(request: NextRequest): Promise<boolean> {
  // Request-aware read: resolves a bearer JWT (native admin) FIRST, then the
  // cookie, so a native admin holding only a bearer token can use the session
  // path. readActiveSummonarrSession() read the cookie only.
  const claims = await readActiveSummonarrSessionFromRequest(request);
  if (claims?.role === "ADMIN") {
    if (!isSameOriginRequest(request)) return false;
    // Same UA-fingerprint replay defense the withAuth wrappers enforce: a stolen
    // admin cookie replayed from another device (with a forged trusted Origin) must
    // not drive /api/sync or /api/cron/*. machine:/no-fingerprint claims pass through.
    if (!matchesStoredFingerprint(claims.uaFingerprint, request.headers.get("user-agent"))) return false;
    return true;
  }

  const cronSecret = process.env.CRON_SECRET;
  if (cronSecret) {
    const authHeader = request.headers.get("authorization") ?? "";
    if (authHeader.startsWith("Bearer ")) {
      if (safeCompareStrings(authHeader.slice(7), cronSecret)) return true;
      // Throttle failed CRON_SECRET guessing per source IP. A presented-but-wrong
      // Bearer is a guess; bound it to 20 failures / 60s. When the bucket is
      // exhausted, deny (return false) so brute-forcing the secret is bounded.
      // The happy path above already returned, so this never touches a valid call.
      if (!checkRateLimit(`cron-auth-fail:${getClientIp(request.headers)}`, 20, 60_000)) {
        return false;
      }
    }
  }

  return false;
}

// Always pass BATCH_TX_TIMEOUT to $transaction for library-sized writes to avoid Prisma's default 5s timeout
export const BATCH_TX_TIMEOUT = 30_000;
// Raw createMany on library-sized datasets blows transaction timeouts; this chunk size keeps each batch safe
const CREATE_MANY_BATCH = 5_000;

export async function batchCreateMany<T extends Record<string, unknown>>(
  tx: { createMany: (args: { data: T[]; skipDuplicates?: boolean }) => Promise<unknown> },
  rows: T[],
): Promise<void> {
  for (let i = 0; i < rows.length; i += CREATE_MANY_BATCH) {
    await tx.createMany({ data: rows.slice(i, i + CREATE_MANY_BATCH), skipDuplicates: true });
  }
}

// Records the last time a cron/sync job ran. Stored in the `Setting` table
// (key: `cron:lastRun:<target>`, value: JSON `{ at, durationMs, ok }`) so that
// admin observability surfaces (settings page) don't depend on whether the
// route also writes a `LIBRARY_SYNC` / `CACHE_WARM` audit row — several warm
// jobs deliberately skip audit on cron triggers to avoid flooding the table.
//
// Single writer per `target`, so no coordination required (per CLAUDE.md
// guardrail 14 on shared state).
export async function recordCronRun(
  target: string,
  durationMs: number,
  ok: boolean = true,
): Promise<void> {
  const key = `cron:lastRun:${target}`;
  const value = JSON.stringify({ at: new Date().toISOString(), durationMs, ok });
  await prisma.setting.upsert({
    where: { key },
    create: { key, value },
    update: { value },
  }).catch(() => { /* observability write — never fail the caller */ });
}

// Wraps a cron/sync route body so a single recordCronRun call always fires on
// completion — including thrown errors and 4xx/5xx responses — instead of every
// route having to remember its own try/finally. Caller is still responsible for
// the inner work; the wrapper just guarantees observability.
//
// ok is derived from: (a) whether the body threw → false, (b) response status
// >= 400 → false, otherwise true. A status of 200 with a body indicating partial
// failure (e.g. Promise.allSettled with rejections) should be handled by the
// caller throwing or returning >=500, since the wrapper has no domain knowledge
// of "skipped" vs "failed".
export async function withCronRunRecording<T extends Response>(
  target: string,
  fn: () => Promise<T>,
): Promise<T> {
  const start = Date.now();
  let ok = true;
  try {
    const res = await fn();
    if (res.status >= 400) ok = false;
    return res;
  } catch (err) {
    ok = false;
    throw err;
  } finally {
    await recordCronRun(target, Date.now() - start, ok);
  }
}

export interface CronLastRun {
  at: string;
  durationMs: number;
  ok: boolean;
}

export function parseCronLastRun(raw: string | null | undefined): CronLastRun | null {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as Partial<CronLastRun>;
    if (typeof parsed.at !== "string") return null;
    return {
      at: parsed.at,
      durationMs: typeof parsed.durationMs === "number" ? parsed.durationMs : 0,
      ok: parsed.ok !== false,
    };
  } catch {
    return null;
  }
}
