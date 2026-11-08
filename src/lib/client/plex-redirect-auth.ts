// The Plex PIN redirect state, and the polling rules /auth/plex/done follows
// once Plex sends the browser back. Pure, so the rules are unit-tested; the page
// is a client component the test loader cannot import.
import { retryAfterDeltaSeconds } from "./rate-limit";

// Written to sessionStorage before the redirect: by the login form (flow
// "login") and by the admin Plex connect form (flow "settings").
export interface LoginAuth {
  flow: "login";
  pinId: number;
  clientId: string;
  rememberMe: boolean;
  callbackUrl: string;
  siteUrl: string;
  state?: string;
}

export interface SettingsAuth {
  flow: "settings";
  pinId: number;
  state?: string;
}

export type RedirectAuth = LoginAuth | SettingsAuth;

// The stashed value, checked rather than cast: a tampered or stale value (a
// JSON `null`, a wrong flow, a non-integer pin) is null, and the page falls back
// to /login exactly as for a value that doesn't parse. Extra fields (the login
// form also stores deviceMeta) are ignored.
export function parsePlexRedirectAuth(raw: string): RedirectAuth | null {
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return null;
  }
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  const v = value as Record<string, unknown>;
  if (typeof v.pinId !== "number" || !Number.isInteger(v.pinId)) return null;
  if (v.state !== undefined && typeof v.state !== "string") return null;
  const state = v.state as string | undefined;
  if (v.flow === "settings") return { flow: "settings", pinId: v.pinId, state };
  if (
    v.flow === "login" &&
    typeof v.clientId === "string" &&
    typeof v.callbackUrl === "string" &&
    typeof v.siteUrl === "string" &&
    typeof v.rememberMe === "boolean"
  ) {
    return {
      flow: "login",
      pinId: v.pinId,
      clientId: v.clientId,
      rememberMe: v.rememberMe,
      callbackUrl: v.callbackUrl,
      siteUrl: v.siteUrl,
      state,
    };
  }
  return null;
}

// The whole wait for the user to approve the PIN, however slow each poll is.
export const PIN_POLL_WINDOW_MS = 120_000;
// One plex.tv poll from the browser.
export const PIN_POLL_REQUEST_TIMEOUT_MS = 5_000;
// One poll of the app's own PATCH, which itself waits up to 15s on plex.tv.
export const SETTINGS_POLL_REQUEST_TIMEOUT_MS = 20_000;
export const PIN_POLL_INTERVAL_MS = 1_000;
const RATE_LIMITED_DEFAULT_MS = 5_000;
const RATE_LIMITED_MAX_MS = 30_000;

export type PinPollStep =
  | { kind: "read" }
  | { kind: "expired" }
  | { kind: "wait"; delayMs: number };

// What a plex.tv PIN poll's status means. 404/410: the PIN is unknown or has
// expired, so no amount of polling will approve it. 429: back off, honouring
// Retry-After (seconds) within bounds. Any other failure is retried at the
// usual pace; only a 2xx body is read.
export function plexPinPollStep(status: number, retryAfter: string | null): PinPollStep {
  if (status >= 200 && status < 300) return { kind: "read" };
  if (status === 404 || status === 410) return { kind: "expired" };
  if (status === 429) {
    const seconds = retryAfterDeltaSeconds(retryAfter);
    const delayMs = seconds !== null && seconds > 0
      ? Math.min(seconds * 1000, RATE_LIMITED_MAX_MS)
      : RATE_LIMITED_DEFAULT_MS;
    return { kind: "wait", delayMs: Math.max(delayMs, PIN_POLL_INTERVAL_MS) };
  }
  return { kind: "wait", delayMs: PIN_POLL_INTERVAL_MS };
}

// A wall-clock deadline for a poll loop: `remaining()` counts down to zero and
// below. The page starts its polls from an effect, never during render
// (guardrail 16); keeping the clock reads here keeps them out of the component.
export function pollDeadline(windowMs: number): { remaining(): number } {
  const end = Date.now() + windowMs;
  return { remaining: () => end - Date.now() };
}

// A signal that aborts after `ms`. AbortSignal.timeout where the browser has it
// (Safari 16+), a timer otherwise, so an older browser still polls.
export function requestTimeoutSignal(ms: number): AbortSignal {
  if (typeof AbortSignal.timeout === "function") return AbortSignal.timeout(ms);
  const ctrl = new AbortController();
  setTimeout(() => ctrl.abort(), ms);
  return ctrl.signal;
}
