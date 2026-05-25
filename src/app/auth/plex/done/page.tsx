"use client";

import { useEffect, useState } from "react";
import { useSearchParams } from "next/navigation";
import { Loader2 } from "@/components/icons";

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

// Landing page for the Plex PIN-based OAuth redirect; polls plex.tv until the PIN is claimed
export default function PlexDonePage() {
  const [message, setMessage] = useState("Completing Plex sign-in…");
  const searchParams = useSearchParams();

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
      setMessage("Sign-in timed out. Please go back and try again.");
      return;
    }

    setMessage("Signing in…");
    const result = await fetch("/api/auth/sign-in/plex", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      credentials: "include",
      body: JSON.stringify({
        plexToken: authToken,
        plexClientId: auth.clientId,
        rememberMe: String(auth.rememberMe),
      }),
    });

    if (!result.ok) {
      setMessage("You don't have access. Contact the server owner.");
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

    window.location.href =
      safeRedirect(auth.siteUrl) ?? safeRedirect(auth.callbackUrl) ?? "/";
  }

  async function completeSettings(auth: SettingsAuth) {
    // Settings flow routes through the server-side pin proxy so the admin token never touches the browser
    let authToken: string | null = null;
    for (let i = 0; i < 120; i++) {
      try {
        const r = await fetch(`/api/auth/plex/pin?id=${auth.pinId}`);
        const d: { authToken?: string | null } = await r.json();
        if (d.authToken) { authToken = d.authToken; break; }
      } catch { }
      await new Promise((r) => setTimeout(r, 1000));
    }

    if (!authToken) {
      setMessage("Connection timed out. Please go back and try again.");
      return;
    }

    setMessage("Saving connection…");
    try {
      const res = await fetch("/api/settings/plex", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ authToken }),
      });
      if (!res.ok) throw new Error();
    } catch {
      setMessage("Failed to save Plex connection. Please try again.");
      return;
    }

    window.location.href = "/settings";
  }

  useEffect(() => {
    const stored = sessionStorage.getItem("plex-redirect-auth");

    if (!stored) {
      window.location.replace("/login");
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
      window.location.replace("/login");
      return;
    }

    // CSRF: state written to sessionStorage before redirect and compared after return.
    // Reject if state is missing from either side — an absent stored state means the
    // session was tampered with; an absent URL state means the redirect was forged.
    const urlState = searchParams.get("state");
    if (!auth.state || !urlState || urlState !== auth.state) {
      setMessage("Sign-in failed: state mismatch. Please try again.");
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
    <div className="min-h-screen flex flex-col items-center justify-center bg-zinc-950 gap-3">
      <Loader2 className="w-6 h-6 text-indigo-400 animate-spin" />
      <p className="text-zinc-400 text-sm">{message}</p>
    </div>
  );
}
