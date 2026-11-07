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

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, Math.max(0, ms)));
}

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

  async function completeLogin(auth: LoginAuth) {
    // Poll plex.tv directly until the user approves the PIN in the Plex UI. The
    // window is wall-clock (each request is bounded too), so a stalled
    // connection can't hold the spinner past it.
    let authToken: string | null = null;
    const deadline = pollDeadline(PIN_POLL_WINDOW_MS);
    while (deadline.remaining() > 0) {
      let delayMs = PIN_POLL_INTERVAL_MS;
      try {
        const r = await fetch(`https://plex.tv/api/v2/pins/${auth.pinId}`, {
          headers: {
            "X-Plex-Client-Identifier": auth.clientId,
            "X-Plex-Product": "Summonarr",
            "X-Plex-Version": "1.0",
            "X-Plex-Model": "hosted",
            "X-Plex-Device": "Web",
            "X-Plex-Device-Name": "Summonarr",
            "X-Plex-Platform": "Web",
            Accept: "application/json",
          },
          signal: requestTimeoutSignal(PIN_POLL_REQUEST_TIMEOUT_MS),
        });
        const step = plexPinPollStep(r.status, r.headers.get("retry-after"));
        if (step.kind === "expired") {
          // An unknown or expired PIN can never be approved: say so now
          // rather than after the whole window.
          fail(t("auth.plexDone.error.expired"));
          return;
        }
        if (step.kind === "read") {
          const d = (await r.json().catch(() => null)) as { authToken?: unknown } | null;
          if (d && typeof d.authToken === "string" && d.authToken) { authToken = d.authToken; break; }
        } else {
          delayMs = step.delayMs;
        }
      } catch { }
      await sleep(Math.min(delayMs, deadline.remaining()));
    }

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

    const here = window.location.origin;
    const safeRedirect = (candidate: string | undefined | null): string | null => {
      if (!candidate) return null;
      try {
        const u = new URL(candidate, here);

        if (u.protocol !== "http:" && u.protocol !== "https:") return null;
        if (u.origin !== here) return null;
        return u.href;
      } catch {
        return null;
      }
    };

    // callbackUrl is the base-path-STRIPPED in-app path (proxy.ts writes
    // req.nextUrl.pathname; login-form re-validates it with safeInternalPath), and
    // window.location does NOT apply Next's basePath the way router.push does — so
    // it must go through withBasePath or a subpath deployment lands at the origin
    // root. siteUrl is admin-configured and already absolute; withBasePath passes
    // absolute URLs through untouched.
    //
    // A real deep link wins over siteUrl: safeRedirect rejects any candidate whose
    // origin differs from this one, so siteUrl can only ever resolve to the app
    // root — trying it first silently dropped the callbackUrl on every Plex
    // sign-in, while credentials/QuickConnect router.push(callbackUrl) honoured it.
    // Both candidates still go through safeRedirect (same-origin only).
    const deepLink =
      auth.callbackUrl && auth.callbackUrl !== "/"
        ? safeRedirect(withBasePath(auth.callbackUrl))
        : null;
    window.location.href =
      deepLink ?? safeRedirect(auth.siteUrl) ?? withBasePath("/");
  }

  async function completeSettings() {
    // The server polls the PIN it bound to this admin (pin id + a per-attempt
    // client identifier in an HttpOnly cookie) and stores the owner token itself
    // once Plex approves it — the token never reaches the browser. Plex only
    // forwards here after approval, so the first poll normally saves it.
    setMessage(t("auth.plexDone.saving"));
    let connected = false;
    const deadline = pollDeadline(PIN_POLL_WINDOW_MS);
    while (deadline.remaining() > 0) {
      try {
        // Above the route's own 15s plex.tv timeout, so a slow plex.tv answer
        // still arrives.
        const r = await fetch(withBasePath("/api/auth/plex/pin"), {
          method: "PATCH",
          signal: requestTimeoutSignal(SETTINGS_POLL_REQUEST_TIMEOUT_MS),
        });
        if (r.status === 400 || r.status === 401 || r.status === 403 || r.status === 422) {
          // No connect in progress for this session (expired / another admin),
          // or plex.tv refused the token it issued: retrying the poll can't help.
          fail(t("auth.plexDone.error.saveFailed"), "settings");
          return;
        }
        const d: { status?: string } = await r.json();
        if (d.status === "connected") { connected = true; break; }
      } catch { }
      await sleep(Math.min(PIN_POLL_INTERVAL_MS, deadline.remaining()));
    }

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

  useEffect(() => {
    if (startedRef.current) return;
    startedRef.current = true;
    const stored = sessionStorage.getItem("plex-redirect-auth");

    if (!stored) {
      window.location.replace(withBasePath("/login"));
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

    if (auth.flow === "login") {
      completeLogin(auth);
    } else {
      completeSettings();
    }
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
