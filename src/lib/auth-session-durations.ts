import { prisma } from "@/lib/prisma";
import { processSingleton } from "@/lib/process-singleton";
import { MAX_CONFIGURABLE_SESSION_SECONDS, NEVER_EXPIRES_AT_SEC } from "@/lib/session-lifetime";

// How long a session minted at sign-in lives (guardrail 6c): the admin-set
// desktop / mobile / remember-me durations for a browser, no deadline at all
// for a native client.

const DEFAULT_SESSION_SECONDS        = 3_600;
const DEFAULT_MOBILE_SESSION_SECONDS = 604_800;
const DEFAULT_MAX_SESSION_SECONDS    = 2_592_000;

// Native-app (bearer) sessions never expire by time — the deadline is the
// never-reached NEVER_EXPIRES_AT_SEC sentinel (see session-lifetime.ts for why a
// sentinel and not an absent claim). The token lives in the iOS Keychain
// (hardware-backed, not an ambient cookie) and bearer clients have no refresh
// channel (guardrail 6b), so "never expires" is the mechanism that keeps the app
// signed in. NOT a security hole: DB revocation — sign-out, a per-device revoke,
// sign-out-everywhere, a password change, the sessionsRevokedAt/passwordChangedAt
// cutoffs, account deactivation — still invalidates it on the next request,
// independent of the deadline. Granted ONLY to a caller presenting the
// X-Summonarr-Client header (a custom header a cross-origin page cannot attach to
// a credentialed request), so web "remember me" is unaffected.

// Hard ceiling for ADMIN-CONFIGURABLE durations (the sessionDefault/Mobile/Max settings)
// — prevents an admin from configuring an unbounded JWT lifetime. The native sentinel
// above is a deliberate code-level constant and is intentionally not bound by this.
// Shared with session-jwt.ts, which tells a legacy native token from a browser one
// by a deadline past this horizon (guardrail 6h), so the value lives in
// session-lifetime.ts.
const MAX_ALLOWED_SESSION_SECONDS = MAX_CONFIGURABLE_SESSION_SECONDS;

export type SessionDurations = { desktopDuration: number; mobileDuration: number; maxDuration: number };

const SESSION_DURATIONS_TTL_MS = 5 * 60 * 1000;
// Process-wide (guardrail 27a): /api/settings and a database restore invalidate
// it from their own chunks, and every sign-in route must see that. `gen` stops a
// read in flight across an invalidation from caching the old lengths, which
// sessions minted meanwhile would carry for life (guardrail 6c).
const sessionDurationsState = processSingleton("auth:sessionDurations", () => ({
  cache: null as { value: SessionDurations; expiresAt: number } | null,
  gen: 0,
}));

export function invalidateSessionDurationsCache(): void {
  sessionDurationsState.gen++;
  sessionDurationsState.cache = null;
}

// Reads the admin-configurable desktop/mobile/max session TTLs (5-min cached),
// each capped at MAX_ALLOWED_SESSION_SECONDS, falling back to the DEFAULT_* consts.
export async function getSessionDurations(): Promise<SessionDurations> {
  const now = Date.now();
  const cached = sessionDurationsState.cache;
  if (cached && cached.expiresAt > now) {
    return cached.value;
  }
  const gen = sessionDurationsState.gen;
  const rows = await prisma.setting.findMany({
    where: { key: { in: ["sessionDefaultDuration", "sessionMobileDuration", "sessionMaxDuration"] } },
  });
  const map = Object.fromEntries(rows.map((r) => [r.key, r.value]));
  // Symmetric clamp: the settings route enforces [60, MAX] at write time, but a
  // hand-edited row or a restored pre-clamp backup can carry 0/negative — which
  // would mint a session already past its deadline and present as an
  // instant-logout loop on every sign-in. Clamp reads the same way as writes.
  const cap = (n: number) => Math.min(Math.max(n, 60), MAX_ALLOWED_SESSION_SECONDS);
  const desktopDuration = cap(parseInt(map.sessionDefaultDuration ?? "") || DEFAULT_SESSION_SECONDS);
  const mobileDuration = cap(parseInt(map.sessionMobileDuration ?? "") || DEFAULT_MOBILE_SESSION_SECONDS);
  const value: SessionDurations = {
    desktopDuration,
    mobileDuration,
    // "Remember me" must never be shorter than not ticking it.
    maxDuration: Math.max(cap(parseInt(map.sessionMaxDuration ?? "") || DEFAULT_MAX_SESSION_SECONDS), desktopDuration, mobileDuration),
  };
  if (gen === sessionDurationsState.gen) {
    sessionDurationsState.cache = { value, expiresAt: now + SESSION_DURATIONS_TTL_MS };
  }
  return value;
}

// The session deadline (unix seconds), captured once at sign-in.
// verifyAndRefreshSession enforces it on every DB-checked verify and re-signs
// the JWT / cookie out to exactly this instant — there is no inactivity window
// on top of it (guardrail 6c), and it can never move, so a session can't outlive
// the configured duration (itself capped in getSessionDurations()).
//
// A native client — identified by the header, never the User-Agent — gets the
// never-expiring sentinel whatever rememberMe or its device class say. A browser
// gets remember-me's maxDuration, else the mobile or desktop window by its
// UA-derived device class.
export function sessionDeadline(opts: {
  native: boolean;
  rememberMe: boolean;
  isMobile: boolean;
  durations: SessionDurations;
  nowSec: number;
}): number {
  if (opts.native) return NEVER_EXPIRES_AT_SEC;
  const { desktopDuration, mobileDuration, maxDuration } = opts.durations;
  const ttl = opts.rememberMe ? maxDuration : opts.isMobile ? mobileDuration : desktopDuration;
  return opts.nowSec + ttl;
}
