"use client";

import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { AlertTriangle, Loader2 } from "@/components/icons";
import { withBasePath } from "@/lib/base-path";

interface LoginAuth {
  flow: "login";
  pinId: number;
  clientId: string;
  rememberMe: boolean;
  callbackUrl: string;
  siteUrl: string;
  state?: string;
}

interface SettingsAuth {
  flow: "settings";
  pinId: number;
  state?: string;
}

type RedirectAuth = LoginAuth | SettingsAuth;

// Turn a failed POST /api/auth/sign-in/plex into a message that reflects the
// ACTUAL failure class, instead of a blanket "you don't have access". The route
// returns { error } with a meaningful status:
//   400 → the sign-in flow expired or didn't match — per-user and retry-able.
//   401 → the membership/credential gate rejected it: EITHER this Plex account
//         isn't shared on the server, OR the server's Plex connection (admin
//         token / server URL) is broken — which locks out every Plex user at
//         once. Point at the server owner, not the individual.
//   5xx → the server errored while completing sign-in.
async function describePlexSignInFailure(res: Response): Promise<string> {
  let detail = "";
  try {
    const data: { error?: unknown } = await res.json();
    if (typeof data.error === "string") detail = data.error;
  } catch {
    // Non-JSON body (e.g. a reverse-proxy 502 HTML page) — use the status alone.
  }
  if (res.status === 400) {
    return "Your Plex sign-in session expired or was invalid. Please go back and try again.";
  }
  if (res.status === 401) {
    return "Plex sign-in was rejected. Either your Plex account isn't shared on this server, or the server's Plex connection needs to be re-authorized — contact the server owner.";
  }
  if (res.status >= 500) {
    return "The server hit an error finishing sign-in. Please try again, or contact the server owner if it keeps happening.";
  }
  return `Plex sign-in failed (${res.status}${detail ? ` — ${detail}` : ""}). Contact the server owner if this persists.`;
}

// Landing page after the Plex PIN sign-in redirect. It polls until the user has
// approved the PIN, then finishes either a login or the admin Settings connect.
export default function PlexDonePage() {
  const [message, setMessage] = useState("Completing Plex sign-in…");
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
    // Poll plex.tv directly (up to 120s) until the user approves the PIN in the Plex UI
    let authToken: string | null = null;
    for (let i = 0; i < 120; i++) {
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
        });
        const d: { authToken?: string | null } = await r.json();
        if (d.authToken) { authToken = d.authToken; break; }
      } catch { }
      await new Promise((r) => setTimeout(r, 1000));
    }

    if (!authToken) {
      fail("Sign-in timed out. Please go back and try again.");
      return;
    }

    setMessage("Signing in…");
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
      fail("Couldn't reach the server to finish sign-in. Check your connection and try again.");
      return;
    }

    if (!result.ok) {
      fail(await describePlexSignInFailure(result));
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

  async function completeSettings(auth: SettingsAuth) {
    // Settings flow routes through the server-side pin proxy so the admin token never touches the browser
    let authToken: string | null = null;
    for (let i = 0; i < 120; i++) {
      try {
        const r = await fetch(withBasePath(`/api/auth/plex/pin?id=${auth.pinId}`));
        const d: { authToken?: string | null } = await r.json();
        if (d.authToken) { authToken = d.authToken; break; }
      } catch { }
      await new Promise((r) => setTimeout(r, 1000));
    }

    if (!authToken) {
      fail("Connection timed out. Please go back and try again.", "settings");
      return;
    }

    setMessage("Saving connection…");
    try {
      const res = await fetch(withBasePath("/api/settings/plex"), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ authToken }),
      });
      if (!res.ok) throw new Error();
    } catch {
      fail("Failed to save Plex connection. Please try again.", "settings");
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
    let auth: RedirectAuth;
    try {
      auth = JSON.parse(stored) as RedirectAuth;
    } catch {
      // Corrupted/tampered sessionStorage value would otherwise throw here and leave the user
      // stuck on the loading spinner with no recovery path. Fall back to /login the same way the
      // missing-key branch above does.
      window.location.replace(withBasePath("/login"));
      return;
    }

    // CSRF: state written to sessionStorage before redirect and compared after return.
    // Reject if state is missing from either side — an absent stored state means the
    // session was tampered with; an absent URL state means the redirect was forged.
    const urlState = searchParams.get("state");
    if (!auth.state || !urlState || urlState !== auth.state) {
      fail("Sign-in failed: state mismatch. Please try again.", auth.flow === "settings" ? "settings" : "login");
      return;
    }

    if (auth.flow === "login") {
      completeLogin(auth);
    } else {
      completeSettings(auth);
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
          className="ds-tap ds-hover-tint inline-flex items-center justify-center font-medium mt-3"
          style={{
            background: "var(--ds-bg-2)",
            color: "var(--ds-fg)",
            border: "1px solid var(--ds-border)",
            borderRadius: 10,
            minHeight: 44,
            fontSize: 14,
            padding: "0 20px",
          }}
        >
          {failedFlow === "settings" ? "Back to settings" : "Back to sign in"}
        </Link>
      )}
    </div>
  );
}
