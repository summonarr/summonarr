// The /auth/plex/done page's settings-connect poll and its cancellation, pure
// so the rules are unit-tested (the page is a client component the test loader
// cannot import). The login poll's rules are in plex-redirect-auth.ts.
import { plexPinPollStep, type LoginAuth } from "./plex-redirect-auth";
import { withBasePath } from "../base-path";

// Consecutive 5xx answers from the app's own PATCH before the page stops
// waiting and says the server failed, instead of a timeout two minutes later.
// The route answers 502 while plex.tv itself is failing, so a short run of
// them is retried.
export const SETTINGS_POLL_MAX_SERVER_ERRORS = 10;

export type SettingsPollStep =
  | { kind: "read" }
  | { kind: "fail" }
  | { kind: "serverError" }
  | { kind: "wait"; delayMs: number };

/**
 * What one PATCH /api/auth/plex/pin answer means. 400/401/403/422: no connect
 * in progress for this session (expired / another admin) or plex.tv refused
 * the token it issued — retrying can't help. 429 backs off on Retry-After. A
 * 5xx is retried until `serverErrors` (this one included) reaches the cap.
 * Only a 2xx JSON body is read.
 */
export function settingsPollStep(
  status: number,
  retryAfter: string | null,
  contentType: string | null,
  serverErrors: number,
): SettingsPollStep {
  if (status === 400 || status === 401 || status === 403 || status === 422) return { kind: "fail" };
  if (status >= 500) {
    return serverErrors >= SETTINGS_POLL_MAX_SERVER_ERRORS ? { kind: "serverError" } : { kind: "wait", delayMs: 1_000 };
  }
  if (status >= 200 && status < 300) {
    // A proxy's HTML page on a 2xx is not an answer: poll again.
    return contentType?.toLowerCase().includes("application/json") ? { kind: "read" } : { kind: "wait", delayMs: 1_000 };
  }
  const step = plexPinPollStep(status, retryAfter);
  return step.kind === "wait" ? step : { kind: "wait", delayMs: 1_000 };
}

/** Whether a PATCH body says the connection was saved. */
export function isConnectedBody(body: unknown): boolean {
  return typeof body === "object" && body !== null && (body as { status?: unknown }).status === "connected";
}

/** A signal that aborts when ANY of `signals` does (AbortSignal.any where the browser has it). */
export function anySignal(...signals: AbortSignal[]): AbortSignal {
  const native = (AbortSignal as { any?: (s: AbortSignal[]) => AbortSignal }).any;
  if (typeof native === "function") return native(signals);
  const ctrl = new AbortController();
  const listeners: Array<[AbortSignal, () => void]> = [];
  const cleanup = () => {
    for (const [sig, fn] of listeners) sig.removeEventListener("abort", fn);
    listeners.length = 0;
  };
  for (const s of signals) {
    if (s.aborted) {
      cleanup();
      ctrl.abort(s.reason);
      return ctrl.signal;
    }
    const onAbort = () => {
      cleanup();
      ctrl.abort(s.reason);
    };
    s.addEventListener("abort", onAbort, { once: true });
    listeners.push([s, onAbort]);
  }
  return ctrl.signal;
}

export { abortableSleep } from "../abortable-sleep";

/** `candidate` as an absolute URL when it is http(s) on `origin`, else null. */
export function sameOriginHref(candidate: string | null | undefined, origin: string): string | null {
  if (!candidate) return null;
  try {
    const u = new URL(candidate, origin);
    if (u.protocol !== "http:" && u.protocol !== "https:") return null;
    if (u.origin !== origin) return null;
    return u.href;
  } catch {
    return null;
  }
}

/**
 * Where a completed Plex sign-in lands. callbackUrl is the base-path-STRIPPED
 * in-app path (proxy.ts writes req.nextUrl.pathname; login-form re-validates it
 * with safeInternalPath), and window.location does NOT apply Next's basePath
 * the way router.push does — so it goes through withBasePath or a subpath
 * deployment lands at the origin root. siteUrl is admin-configured and already
 * absolute; withBasePath passes absolute URLs through untouched.
 *
 * A real deep link wins over siteUrl: sameOriginHref rejects any candidate
 * whose origin differs from this one, so siteUrl can only ever resolve to the
 * app root — trying it first silently dropped the callbackUrl on every Plex
 * sign-in, while credentials/QuickConnect router.push(callbackUrl) honoured it.
 * Both candidates are same-origin only.
 */
export function plexSignInDestination(auth: Pick<LoginAuth, "callbackUrl" | "siteUrl">, origin: string): string {
  const deepLink =
    auth.callbackUrl && auth.callbackUrl !== "/" ? sameOriginHref(withBasePath(auth.callbackUrl), origin) : null;
  return deepLink ?? sameOriginHref(auth.siteUrl, origin) ?? withBasePath("/");
}
