"use client";

import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { AlertTriangle, Loader2 } from "@/components/icons";
import { buttonVariants } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { withBasePath } from "@/lib/base-path";
import { useT } from "@/components/i18n/i18n-provider";
import type { Translator } from "@/lib/i18n/translate";
import {
  PIN_POLL_INTERVAL_MS,
  PIN_POLL_REQUEST_TIMEOUT_MS,
  PIN_POLL_WINDOW_MS,
  SETTINGS_POLL_REQUEST_TIMEOUT_MS,
  parsePlexRedirectAuth,
  pollDeadline,
  plexPinPollStep,
  requestTimeoutSignal,
  type LoginAuth,
} from "@/lib/client/plex-redirect-auth";
import {
  abortableSleep,
  anySignal,
  isConnectedBody,
  plexSignInDestination,
  settingsPollStep,
} from "@/lib/client/plex-done-flow";
import { plexClientHeaders } from "@/lib/plex-client-headers";

// Turn a failed POST /api/auth/sign-in/plex into a message that reflects the
// ACTUAL failure class, instead of a blanket "you don't have access". The route
// returns { error } with a meaningful status:
//   400 → the sign-in flow expired or didn't match — per-user and retry-able.
//   401 → the membership/credential gate rejected it: EITHER this Plex account
//         isn't shared on the server, OR the server's Plex connection (admin
//         token / server URL) is broken — which locks out every Plex user at
//         once. Point at the server owner, not the individual.
//   5xx → the server errored while completing sign-in.
async function describePlexSignInFailure(res: Response, t: Translator): Promise<string> {
  let detail = "";
  try {
    const data: { error?: unknown } = await res.json();
    if (typeof data.error === "string") detail = data.error;
  } catch {
    // Non-JSON body (e.g. a reverse-proxy 502 HTML page) — use the status alone.
  }
  if (res.status === 400) {
    return t("auth.plexDone.error.expired");
  }
  if (res.status === 401) {
    return t("auth.plexDone.error.rejected");
  }
  if (res.status >= 500) {
    return t("auth.plexDone.error.server");
  }
  return detail
    ? t("auth.plexDone.error.statusDetail", { status: res.status, detail })
    : t("auth.plexDone.error.status", { status: res.status });
}

// The final sign-in POST is bounded like the polls: a server that accepts the
// connection and never answers must end in the retry link, not a lasting spinner.
const SIGN_IN_REQUEST_TIMEOUT_MS = 30_000;

// What one poll attempt decided: stop the loop, or wait `delayMs` and go again
// (undefined keeps the default interval).
type PollAttempt = { stop: true } | { delayMs?: number };

// The wall-clock polling window shared by both flows. A thrown attempt (a
// network error or a per-request timeout) just polls again. Resolves true when
// an attempt asked to stop, false when the window ended or the page went away.
async function pollWindow(signal: AbortSignal, attempt: () => Promise<PollAttempt>): Promise<boolean> {
  const deadline = pollDeadline(PIN_POLL_WINDOW_MS);
  while (deadline.remaining() > 0 && !signal.aborted) {
    let delayMs = PIN_POLL_INTERVAL_MS;
    try {
      const next = await attempt();
      if ("stop" in next) return true;
      if (next.delayMs !== undefined) delayMs = next.delayMs;
    } catch {
      // A network error or a per-request timeout: poll again.
    }
    await abortableSleep(Math.min(delayMs, deadline.remaining()), signal);
  }
  return false;
}

// Landing page after the Plex PIN sign-in redirect. It polls until the user has
// approved the PIN, then finishes either a login or the admin Settings connect.
export default function PlexDonePage() {
  const t = useT();
  const [message, setMessage] = useState(() => t("auth.plexDone.completing"));
  // Every failure branch below used to swap the message and leave the spinner
  // running with no way out but the browser's Back button. `failed` stops the
  // spinner and surfaces a link back to /login; the success path is untouched.
  const [failed, setFailed] = useState(false);
  // Which flow failed decides the way out: a login failure goes back to
  // /login, but the settings flow is a signed-in admin connecting Plex, so
  // sending them to the login page would strand them away from the retry.
  const [failedFlow, setFailedFlow] = useState<"login" | "settings">("login");
  const searchParams = useSearchParams();

  function fail(text: string, flow: "login" | "settings" = "login") {
    setMessage(text);
    setFailedFlow(flow);
    setFailed(true);
  }

  async function completeLogin(auth: LoginAuth, signal: AbortSignal) {
    // Poll plex.tv directly until the user approves the PIN in the Plex UI. The
    // window is wall-clock (each request is bounded too), so a stalled
    // connection can't hold the spinner past it.
    // Assigned inside the poll closure, so typed wide for the reads after it.
    let authToken = null as string | null;
    let expired = false as boolean;
    await pollWindow(signal, async () => {
      const r = await fetch(`https://plex.tv/api/v2/pins/${auth.pinId}`, {
        headers: plexClientHeaders(auth.clientId),
        signal: anySignal(signal, requestTimeoutSignal(PIN_POLL_REQUEST_TIMEOUT_MS)),
      }).catch(() => null);
      // A network error or a per-request timeout: poll again.
      if (!r) return {};
      const step = plexPinPollStep(r.status, r.headers.get("retry-after"));
      if (step.kind === "expired") {
        // An unknown or expired PIN can never be approved: say so now
        // rather than after the whole window.
        expired = true;
        return { stop: true };
      }
      if (step.kind !== "read") return { delayMs: step.delayMs };
      const d: unknown = await r.json().catch(() => null);
      const token = typeof d === "object" && d !== null ? (d as { authToken?: unknown }).authToken : undefined;
      if (typeof token === "string" && token) {
        authToken = token;
        return { stop: true };
      }
      return {};
    });
    if (expired) {
      fail(t("auth.plexDone.error.expired"));
      return;
    }
    if (signal.aborted) return;

    if (!authToken) {
      fail(t("auth.plexDone.error.timeout"));
      return;
    }

    setMessage(t("auth.plexDone.signingIn"));
    let result: Response;
    try {
      result = await fetch(withBasePath("/api/auth/sign-in/plex"), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        signal: anySignal(signal, requestTimeoutSignal(SIGN_IN_REQUEST_TIMEOUT_MS)),
        body: JSON.stringify({
          plexToken: authToken,
          plexClientId: auth.clientId,
          pinId: auth.pinId,
          rememberMe: String(auth.rememberMe),
        }),
      });
    } catch {
      // The request never reached the server (offline, DNS/TLS, proxy down).
      // Without this the thrown fetch would leave the user on the spinner forever.
      fail(t("auth.plexDone.error.unreachable"));
      return;
    }

    if (!result.ok) {
      fail(await describePlexSignInFailure(result, t));
      return;
    }
    // The session cookie is set; only the navigation is skipped once the page
    // has gone (the user navigated elsewhere meanwhile).
    if (signal.aborted) return;
    window.location.href = plexSignInDestination(auth, window.location.origin);
  }

  async function completeSettings(signal: AbortSignal) {
    // The server polls the PIN it bound to this admin (pin id + a per-attempt
    // client identifier in an HttpOnly cookie) and stores the owner token itself
    // once Plex approves it — the token never reaches the browser. Plex only
    // forwards here after approval, so the first poll normally saves it.
    setMessage(t("auth.plexDone.saving"));
    let connected = false as boolean;
    let failure = null as "fail" | "serverError" | null;
    let serverErrors = 0;
    await pollWindow(signal, async () => {
      // Above the route's own 15s plex.tv timeout, so a slow plex.tv answer
      // still arrives.
      const r = await fetch(withBasePath("/api/auth/plex/pin"), {
        method: "PATCH",
        signal: anySignal(signal, requestTimeoutSignal(SETTINGS_POLL_REQUEST_TIMEOUT_MS)),
      }).catch(() => null);
      // No answer (network error or timeout): poll again, not counted as a server error.
      if (!r) return {};
      serverErrors = r.status >= 500 ? serverErrors + 1 : 0;
      const step = settingsPollStep(r.status, r.headers.get("retry-after"), r.headers.get("content-type"), serverErrors);
      if (step.kind === "fail" || step.kind === "serverError") {
        failure = step.kind;
        return { stop: true };
      }
      if (step.kind !== "read") return { delayMs: step.delayMs };
      if (isConnectedBody(await r.json().catch(() => null))) {
        connected = true;
        return { stop: true };
      }
      return {};
    });
    if (failure === "fail") {
      fail(t("auth.plexDone.error.saveFailed"), "settings");
      return;
    }
    if (failure === "serverError") {
      fail(t("auth.plexDone.error.saveServer"), "settings");
      return;
    }
    if (signal.aborted) return;

    if (!connected) {
      fail(t("auth.plexDone.error.connectionTimeout"), "settings");
      return;
    }

    window.location.href = withBasePath("/settings");
  }

  // One-shot guard. The effect below CONSUMES the stashed flow state (removeItem)
  // and starts a 120s poll, so it must not run twice — and under React Strict Mode
  // (on by default for the App Router in `next dev`) every effect is set up, torn
  // down and set up again on mount. The second pass found the key already removed
  // and bounced to /login while the first pass's poll was still running, so Plex
  // sign-in could never complete in development. The ref survives that remount.
  const startedRef = useRef(false);
  // The running flow's cancel. A real unmount (a client-side Back) aborts the
  // poll so it stops calling plex.tv and never navigates the user away from
  // where they went. The abort is deferred one task: Strict Mode's simulated
  // unmount re-runs the setup at once, which cancels it and keeps the flow.
  const flowRef = useRef<{ ctrl: AbortController; abortTimer?: ReturnType<typeof setTimeout> } | null>(null);

  useEffect(() => {
    const cleanup = () => {
      const flow = flowRef.current;
      if (flow) flow.abortTimer = setTimeout(() => flow.ctrl.abort(), 0);
    };
    if (startedRef.current) {
      if (flowRef.current) clearTimeout(flowRef.current.abortTimer);
      return cleanup;
    }
    startedRef.current = true;
    const stored = sessionStorage.getItem("plex-redirect-auth");

    if (!stored) {
      // Nothing was stashed on THIS address. Plex always returns to the
      // configured site URL, and the stash lives on the address the sign-in
      // was started from, so a sign-in begun on another address (a LAN host,
      // a second domain) lands here with nothing to finish. Say so, with the
      // link back to sign in from here, instead of a silent bounce to /login.
      fail(t("auth.plexDone.error.noFlow"));
      return;
    }

    sessionStorage.removeItem("plex-redirect-auth");
    // A corrupted or tampered value (unparseable, `null`, a wrong shape) would
    // otherwise throw below or poll with garbage. Fall back to /login the same
    // way the missing-key branch above does.
    const auth = parsePlexRedirectAuth(stored);
    if (!auth) {
      window.location.replace(withBasePath("/login"));
      return;
    }

    // CSRF: state written to sessionStorage before redirect and compared after return.
    // Reject if state is missing from either side — an absent stored state means the
    // session was tampered with; an absent URL state means the redirect was forged.
    const urlState = searchParams.get("state");
    if (!auth.state || !urlState || urlState !== auth.state) {
      fail(t("auth.plexDone.error.stateMismatch"), auth.flow === "settings" ? "settings" : "login");
      return;
    }

    const ctrl = new AbortController();
    flowRef.current = { ctrl };
    if (auth.flow === "login") {
      void completeLogin(auth, ctrl.signal);
    } else {
      void completeSettings(ctrl.signal);
    }
    return cleanup;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <div
      className="min-h-screen flex flex-col items-center justify-center gap-3 px-6 text-center"
      style={{ background: "var(--ds-bg)", color: "var(--ds-fg)" }}
    >
      {failed ? (
        <AlertTriangle style={{ width: 24, height: 24, color: "var(--ds-danger)" }} aria-hidden />
      ) : (
        <Loader2 className="w-6 h-6 animate-spin" style={{ color: "var(--ds-accent-text)" }} />
      )}
      <p
        role={failed ? "alert" : "status"}
        className="text-sm m-0"
        style={{ color: "var(--ds-fg-muted)", maxWidth: 360, lineHeight: 1.5 }}
      >
        {message}
      </p>
      {failed && (
        <Link
          href={failedFlow === "settings" ? "/settings" : "/login"}
          // The design-system outline button, not a hand-rolled pill: the MFA
          // step renders the same "Back to sign in" label one screen earlier,
          // and borderRadius 10 was off the --ds-r-* scale. min-h-11 keeps the
          // 44px tap target the pill had.
          className={cn(buttonVariants({ variant: "outline" }), "mt-3 min-h-11 px-5")}
        >
          {failedFlow === "settings" ? t("auth.plexDone.backToSettings") : t("auth.mfa.backToSignIn")}
        </Link>
      )}
    </div>
  );
}
