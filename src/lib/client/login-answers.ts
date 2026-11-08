// How the login page reads the sign-in routes' answers. Pure (type-only
// imports), so the rules are unit-tested (tests/login-answers.test.mts); the
// login form is a client component the test loader cannot import.
//
// Every key below is in the `auth` or `shared` area, which every client is
// sent (guardrail 40b): the login page is shown before anyone signs in.
import { check, v } from "../validate";
import type { RequestOptionsJSON } from "./webauthn";
import { parseRetryAfterSeconds, rateLimitMessage } from "./rate-limit";

type Translate = (key: string, vars?: Record<string, string | number>) => string;

// ── Two-factor challenge ────────────────────────────────────────────────────

// The password step's answer for an account with two-factor enabled (see
// src/lib/mfa/signin-challenge.ts for the wire contract). Guardrail 6d: that
// step never mints a session for such an account, only this challenge.
export type MfaMethod = "totp" | "webauthn" | "recovery";
export interface MfaChallenge {
  mfaToken: string;
  methods: MfaMethod[];
  webauthn?: RequestOptionsJSON;
}

export function parseMfaChallenge(body: unknown): MfaChallenge | null {
  if (!body || typeof body !== "object") return null;
  const b = body as Record<string, unknown>;
  if (b.mfaRequired !== true || typeof b.mfaToken !== "string" || !Array.isArray(b.methods)) return null;
  const methods = b.methods.filter((m): m is MfaMethod => m === "totp" || m === "webauthn" || m === "recovery");
  const webauthn = b.webauthn && typeof b.webauthn === "object" ? (b.webauthn as RequestOptionsJSON) : undefined;
  return { mfaToken: b.mfaToken, methods, webauthn };
}

/** The method the second-factor step opens on: an authenticator code, else a passkey, else a recovery code. */
export function initialMfaMethod(methods: readonly MfaMethod[]): MfaMethod {
  if (methods.includes("totp")) return "totp";
  if (methods.includes("webauthn")) return "webauthn";
  return "recovery";
}

// Literal keys, never built from the method (the i18n scans can't see a built key).
export const MFA_HINT_KEYS: Record<MfaMethod, string> = {
  totp: "auth.mfa.totpHint",
  webauthn: "auth.mfa.passkeyHint",
  recovery: "auth.mfa.recoveryHint",
};

export const MFA_SWITCH_KEYS: Record<MfaMethod, string> = {
  totp: "auth.mfa.switch.totp",
  webauthn: "auth.mfa.switch.passkey",
  recovery: "auth.mfa.switch.recovery",
};

// ── Password / QuickConnect sign-in ─────────────────────────────────────────

/** How one POST to /api/auth/sign-in/<provider> ended. */
export interface SignInResult {
  ok: boolean;
  /** The HTTP status; absent when no answer came. */
  status?: number;
  /** The route's own (translated) reason, when it sent one. */
  error?: string;
  /** No answer at all: offline, DNS, aborted. */
  offline?: boolean;
  /** 403: the disabled-account answer (disabledAccountResponse). */
  disabled?: boolean;
  /** The password was right and a second factor is owed. */
  mfa?: MfaChallenge;
  /** The 429 itself, for its Retry-After. */
  rateLimited?: { status: number; headers: { get(name: string): string | null } };
}

/** A failed answer's body, read into a SignInResult. */
export function signInFailureFrom(status: number, body: unknown): SignInResult {
  // Correct password, second factor still owed — not a failure to report.
  const mfa = parseMfaChallenge(body);
  if (mfa) return { ok: false, status, mfa };
  const error =
    body && typeof body === "object" && typeof (body as { error?: unknown }).error === "string" && (body as { error: string }).error
      ? (body as { error: string }).error
      : undefined;
  return { ok: false, status, error, disabled: status === 403 };
}

// The message for a failed sign-in. `fallback` is the provider's own wording
// for a plain refusal (a 401). Any other refusal shows the route's own reason
// when it gave one — a 400 "this server isn't configured" is not a wrong
// password — and an error with no reason (a 500, a proxy's 502 page) says the
// server failed, so nobody retypes a correct password into an outage.
export function signInFailureMessage(res: SignInResult, fallback: string, t: Translate): string {
  if (res.offline) return t("auth.login.error.network");
  if (res.rateLimited) return rateLimitMessage(res.rateLimited, t) ?? t("auth.login.error.signInFailed");
  if (res.disabled) return res.error ?? t("auth.login.error.signInFailed");
  if (res.status === 401) return fallback;
  if (res.error) return res.error;
  if (res.status !== undefined && res.status >= 500) return t("auth.login.error.serverUnavailable");
  return fallback;
}

// ── Plex PIN start ──────────────────────────────────────────────────────────

/** /api/auth/plex/start's answer: the PIN plex.tv created. */
export const PlexStartAnswer = v.object({ pinId: v.int(), code: v.string() });

export type PlexPin = { pinId: number; code: string };

/** The PIN from a 2xx body, or null when the body isn't one (the caller then reports a failed start). */
export function readPlexPin(body: unknown): PlexPin | null {
  const parsed = check(PlexStartAnswer, body);
  return parsed.ok && parsed.value.code ? parsed.value : null;
}

// ── Jellyfin QuickConnect ───────────────────────────────────────────────────

/** POST /api/auth/jellyfin/quickconnect: the secret to poll with and the code to show. */
export const QuickConnectStartAnswer = v.object({ secret: v.string(), code: v.string() });

const QuickConnectPollBody = v.object({ authenticated: v.boolean() });

// The poll route's marker for "QuickConnect is disabled on the server".
export const QC_DISABLED_CODE = "quickconnect_disabled";
// How long one run polls before giving up. The server holds each request up to
// ~25s; this wall-clock budget bounds the total wait.
export const QC_DEADLINE_MS = 2 * 60 * 1000;
// Consecutive non-terminal failures a poll tolerates, and the pause between
// them, before showing the server's error. Without a limit a persistent upstream
// failure polled into the 30/min per-secret limit, and the user saw "too many
// requests" instead of the cause.
export const QC_MAX_CONSECUTIVE_FAILURES = 3;
export const QC_FAILURE_BACKOFF_MS = 3_000;
// The pause after a 429 that names no Retry-After (the poll route sends none).
export const QC_RATE_LIMIT_BACKOFF_MS = 10_000;

/** What one QuickConnect poll answer means for the loop. `message` is the route's own reason, when it sent one. */
export type QuickConnectPoll =
  | { kind: "authenticated" }
  | { kind: "pending" }
  // 410: the server dropped this secret (its poll budget is spent, or it
  // forgot the flow). A new code is needed.
  | { kind: "expired"; message: string | null }
  // Retrying only burns the rate-limit budget: a bad request, the route not
  // configured or busy, QuickConnect disabled on the server.
  | { kind: "terminal"; message: string | null }
  // The route is busy for a moment (its poll budget or long-poll slots are
  // full; the 503 says `retry: true`): wait, then poll again. Not a failure.
  | { kind: "busy"; waitMs: number }
  // Too many polls: wait, then poll again. The code the user may already have
  // typed into Jellyfin stays valid, so the run must not end here.
  | { kind: "rateLimited"; waitMs: number }
  // Anything else (a 502 from Jellyfin, a proxy's 5xx, a 200 that isn't the
  // route's answer): retried a few times, more slowly, before it is shown.
  | { kind: "retry"; message: string | null };

function reasonOf(body: unknown): string | null {
  if (!body || typeof body !== "object") return null;
  const error = (body as { error?: unknown }).error;
  return typeof error === "string" && error ? error : null;
}

export function readQuickConnectPoll(status: number, body: unknown, retryAfter: string | null): QuickConnectPoll {
  if (status >= 200 && status <= 299) {
    const parsed = check(QuickConnectPollBody, body);
    if (!parsed.ok) return { kind: "retry", message: null };
    return parsed.value.authenticated ? { kind: "authenticated" } : { kind: "pending" };
  }
  if (status === 410) return { kind: "expired", message: reasonOf(body) };
  if (status === 429) {
    const seconds = parseRetryAfterSeconds(retryAfter);
    return { kind: "rateLimited", waitMs: seconds === null ? QC_RATE_LIMIT_BACKOFF_MS : seconds * 1000 };
  }
  if (status === 503 && body && typeof body === "object" && (body as { retry?: unknown }).retry === true) {
    return { kind: "busy", waitMs: QC_FAILURE_BACKOFF_MS };
  }
  if (status === 400 || status === 503) return { kind: "terminal", message: reasonOf(body) };
  const code = body && typeof body === "object" ? (body as { code?: unknown }).code : undefined;
  if (code === QC_DISABLED_CODE) return { kind: "terminal", message: reasonOf(body) };
  return { kind: "retry", message: reasonOf(body) };
}
