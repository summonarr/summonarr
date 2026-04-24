"use client";

import { useEffect, useState } from "react";
import { signIn } from "next-auth/react";
import { useRouter, useSearchParams } from "next/navigation";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Loader2 } from "lucide-react";

type Provider = "credentials" | "plex" | "jellyfin" | "oidc";
type JellyfinMode = "password" | "quickconnect";

interface Props {
  plexEnabled: boolean;
  jellyfinEnabled: boolean;
  oidcEnabled: boolean;
  oidcName: string;
  localLoginDisabled: boolean;
  siteUrl: string;
}

export function LoginForm({ plexEnabled, jellyfinEnabled, oidcEnabled, oidcName, localLoginDisabled, siteUrl }: Props) {
  const router = useRouter();
  const searchParams = useSearchParams();

  const rawCallback = searchParams.get("callbackUrl") ?? "/";
  const callbackUrl = rawCallback.startsWith("/") && !rawCallback.startsWith("//") ? rawCallback : "/";

  const defaultProvider: Provider = localLoginDisabled
    ? (oidcEnabled ? "oidc" : plexEnabled ? "plex" : jellyfinEnabled ? "jellyfin" : "credentials")
    : "credentials";
  const [provider, setProvider] = useState<Provider>(defaultProvider);
  const [fields, setFields] = useState({ email: "", password: "", username: "" });
  const [rememberMe, setRememberMe] = useState(false);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);
  const [jellyfinMode, setJellyfinMode] = useState<JellyfinMode>("password");
  const [qcCode, setQcCode] = useState<string | null>(null);

  const hasExternalProviders = plexEnabled || jellyfinEnabled || oidcEnabled;

  function setField(key: keyof typeof fields, value: string) {
    setFields((f) => ({ ...f, [key]: value }));
  }

  function readPlexClientId(): string | null {
    // Cookie is checked first; falls back to localStorage for older sessions that predate the cookie write
    const match = document.cookie.match(/(?:^|; )plex-client-id=([^;]+)/);
    if (match) return decodeURIComponent(match[1]);
    return localStorage.getItem("plex-client-id");
  }

  function writePlexClientId(id: string): void {
    // Cookie only — readPlexClientId falls back to localStorage for sessions that predate this change
    document.cookie = `plex-client-id=${encodeURIComponent(id)}; Max-Age=${60 * 60 * 24 * 365}; Path=/; SameSite=Lax${location.protocol === "https:" ? "; Secure" : ""}`;
  }

  function getPlexClientId(): string {
    let id = readPlexClientId();
    if (!id) {
      id = crypto.randomUUID();
      writePlexClientId(id);
    }
    return id;
  }

  useEffect(() => {
    // Sync client ID with the server-assigned value so SSR and client stay in agreement
    let cancelled = false;
    fetch("/api/auth/plex/client-id", { cache: "no-store" })
      .then((r) => (r.ok ? r.json() : null))
      .then((data: { clientId?: string | null } | null) => {
        if (cancelled || !data?.clientId) return;
        const current = readPlexClientId();
        if (current !== data.clientId) writePlexClientId(data.clientId);
      })
      .catch(() => { });
    return () => { cancelled = true; };
  }, []);

  function getPlexDeviceMeta(): { platform: string; device: string; model: string; layout: string } {
    const ua = navigator.userAgent;

    if (/android/i.test(ua)) {
      return { platform: "Android", device: "Android", model: "Android", layout: "mobile" };
    }

    if (/iPad|iPhone|iPod/.test(ua)) {
      const isIpad = /iPad/.test(ua);
      return { platform: "iOS", device: isIpad ? "iPad" : "iPhone", model: isIpad ? "iPad" : "iPhone", layout: "mobile" };
    }

    let browser = "Chrome";
    if (/Edg\//.test(ua)) browser = "Edge";
    else if (/Firefox\//.test(ua)) browser = "Firefox";
    else if (/Chrome\//.test(ua)) browser = "Chrome";
    else if (/Safari\//.test(ua)) browser = "Safari";

    let os = "Linux";
    if (/Windows/.test(ua)) os = "Windows";
    else if (/Mac OS X|Macintosh/.test(ua)) os = "OSX";
    else if (/CrOS/.test(ua)) os = "Chrome OS";

    return { platform: browser, device: os, model: "bundled", layout: "desktop" };
  }

  async function handlePlexSignIn() {
    setLoading(true);
    setError("");
    const clientId = getPlexClientId();
    const deviceMeta = getPlexDeviceMeta();

    let pinId: number;
    let pinCode: string;
    try {
      const res = await fetch("https://plex.tv/api/v2/pins", {
        method: "POST",
        headers: {
          "X-Plex-Client-Identifier": clientId,
          "X-Plex-Product": "Summonarr",
          "X-Plex-Version": "1.0",
          "X-Plex-Model": deviceMeta.model,
          "X-Plex-Device": deviceMeta.device,
          "X-Plex-Device-Name": "Summonarr",
          "X-Plex-Platform": deviceMeta.platform,
          "Content-Type": "application/x-www-form-urlencoded",
          Accept: "application/json",
        },
        body: "strong=true",
      });
      if (!res.ok) throw new Error("create failed");
      const data: { id: number; code: string } = await res.json();
      pinId = data.id;
      pinCode = data.code;
    } catch {
      setError("Could not start Plex sign-in. Please try again.");
      setLoading(false);
      return;
    }

    const state = crypto.randomUUID();
    const base = (siteUrl || window.location.origin).replace(/\/$/, "");
    const oauthParams = new URLSearchParams({
      clientID: clientId,
      code: pinCode,
      "context[device][product]": "Summonarr",
      "context[device][version]": "1.0",
      "context[device][platform]": deviceMeta.platform,
      "context[device][platformVersion]": "1.0",
      "context[device][device]": deviceMeta.device,
      "context[device][deviceName]": "Summonarr",
      "context[device][model]": deviceMeta.model,
      "context[device][layout]": deviceMeta.layout,
      forwardUrl: `${base}/auth/plex/done?state=${state}`,
    });
    const plexUrl = `https://app.plex.tv/auth/#!?${oauthParams.toString()}`;

    // PIN state is stashed in sessionStorage because the page navigates away; /auth/plex/done reads it on return
    sessionStorage.setItem("plex-redirect-auth", JSON.stringify({
      flow: "login", pinId, clientId, rememberMe, callbackUrl, siteUrl, state, deviceMeta,
    }));
    window.location.href = plexUrl;
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setLoading(true);
    setError("");

    const payload =
      provider === "credentials"
        ? { email: fields.email, password: fields.password, rememberMe: String(rememberMe) }
        : { username: fields.username, password: fields.password, rememberMe: String(rememberMe) };

    const res = await signIn(provider, { ...payload, redirect: false });

    if (res?.error) {
      setError(
        provider === "credentials"
          ? "Invalid email or password."
          : "Invalid credentials or Jellyfin server unreachable."
      );
      setLoading(false);
    } else {
      router.push(callbackUrl);
    }
  }

  function switchProvider(next: Provider) {
    setProvider(next);
    setError("");
    setFields({ email: "", password: "", username: "" });
    setJellyfinMode("password");
    setQcCode(null);
    setRememberMe(false);
  }

  async function handleQuickConnect() {
    // Jellyfin QuickConnect: server issues a short-lived code the user enters in another Jellyfin client
    setLoading(true);
    setError("");
    setQcCode(null);

    let secret: string;
    let code: string;
    try {
      const res = await fetch("/api/auth/jellyfin/quickconnect", { method: "POST" });
      if (!res.ok) throw new Error("initiate failed");
      const data: { secret: string; code: string } = await res.json();
      secret = data.secret;
      code = data.code;
    } catch {
      setError("Could not start QuickConnect. Is Jellyfin reachable?");
      setLoading(false);
      return;
    }

    setQcCode(code);

    // Server holds each request up to ~25s; this wall-clock budget bounds the total wait
    const deadline = Date.now() + 2 * 60 * 1000;
    let authenticated = false;
    while (Date.now() < deadline) {
      try {
        const poll = await fetch(
          `/api/auth/jellyfin/quickconnect?secret=${encodeURIComponent(secret)}&wait=1`
        );
        if (poll.ok) {
          const data: { authenticated: boolean } = await poll.json();
          if (data.authenticated) { authenticated = true; break; }
        } else if (poll.status === 410) {
          break;
        }
      } catch {

      }
    }

    if (!authenticated) {
      setError("QuickConnect timed out. Please try again.");
      setLoading(false);
      setQcCode(null);
      return;
    }

    const result = await signIn("jellyfin-quickconnect", { secret, rememberMe: String(rememberMe), redirect: false });
    if (result?.error) {
      setError("QuickConnect approved but sign-in failed. Contact the server owner.");
      setLoading(false);
      setQcCode(null);
    } else {
      router.push(callbackUrl);
    }
  }

  return (
    <div className="space-y-5">
      {hasExternalProviders && (
        <div
          className="flex gap-1"
          style={{
            padding: 2,
            background: "var(--ds-bg-2)",
            border: "1px solid var(--ds-border)",
            borderRadius: 8,
          }}
        >
          {!localLoginDisabled && (
            <ProviderTab active={provider === "credentials"} onClick={() => switchProvider("credentials")}>
              Password
            </ProviderTab>
          )}
          {plexEnabled && (
            <ProviderTab active={provider === "plex"} onClick={() => switchProvider("plex")}>
              Plex
            </ProviderTab>
          )}
          {jellyfinEnabled && (
            <ProviderTab active={provider === "jellyfin"} onClick={() => switchProvider("jellyfin")}>
              Jellyfin
            </ProviderTab>
          )}
          {oidcEnabled && (
            <ProviderTab active={provider === "oidc"} onClick={() => switchProvider("oidc")}>
              {oidcName}
            </ProviderTab>
          )}
        </div>
      )}

      {provider === "oidc" && (
        <div className="space-y-3">
          <RememberMeCheckbox checked={rememberMe} onChange={setRememberMe} />
          <Button
            onClick={() => {
              setLoading(true);
              setError("");
              signIn("oidc", { callbackUrl: callbackUrl });
            }}
            disabled={loading}
            className="w-full"
            style={{ background: "var(--ds-accent)", color: "var(--ds-accent-fg)" }}
          >
            {loading ? (
              <><Loader2 className="w-4 h-4 mr-2 animate-spin" />Redirecting…</>
            ) : (
              `Sign in with ${oidcName}`
            )}
          </Button>
          {error && <p className="text-sm text-red-400">{error}</p>}
        </div>
      )}

      {provider === "plex" && (
        <div className="space-y-3">
          <RememberMeCheckbox checked={rememberMe} onChange={setRememberMe} />
          <Button
            onClick={handlePlexSignIn}
            disabled={loading}
            className="w-full bg-[#e5a00d] hover:bg-[#f0ac14] text-black font-semibold"
          >
            {loading ? (
              <><Loader2 className="w-4 h-4 mr-2 animate-spin" />Waiting for Plex…</>
            ) : (
              "Sign in with Plex"
            )}
          </Button>
          {error && <p className="text-sm text-red-400">{error}</p>}
        </div>
      )}

      {provider === "jellyfin" && jellyfinMode === "quickconnect" && (
        <div className="space-y-4">
          <RememberMeCheckbox checked={rememberMe} onChange={setRememberMe} />
          {qcCode ? (
            <div
              className="text-center space-y-3"
              style={{
                background: "var(--ds-bg-2)",
                border: "1px solid var(--ds-border)",
                borderRadius: "var(--ds-r-md)",
                padding: 20,
              }}
            >
              <p className="text-sm m-0" style={{ color: "var(--ds-fg-muted)" }}>Enter this code in your Jellyfin app or server:</p>
              <p
                className="ds-mono m-0 font-bold tracking-widest"
                style={{ fontSize: 32, color: "var(--ds-fg)" }}
              >
                {qcCode}
              </p>
              <div className="flex items-center justify-center gap-2 text-sm" style={{ color: "var(--ds-fg-muted)" }}>
                <Loader2 className="w-4 h-4 animate-spin" />
                Waiting for approval…
              </div>
            </div>
          ) : (
            <Button
              onClick={handleQuickConnect}
              disabled={loading}
              className="w-full"
            style={{ background: "var(--ds-accent)", color: "var(--ds-accent-fg)" }}
            >
              {loading ? <><Loader2 className="w-4 h-4 mr-2 animate-spin" />Starting…</> : "Generate QuickConnect Code"}
            </Button>
          )}
          {error && <p className="text-sm text-red-400">{error}</p>}
          <button
            type="button"
            onClick={() => { setJellyfinMode("password"); setError(""); setQcCode(null); setLoading(false); }}
            className="w-full text-sm text-zinc-400 hover:text-zinc-200 transition-colors"
          >
            Use password instead
          </button>
        </div>
      )}

      {provider !== "plex" && provider !== "oidc" && !(provider === "jellyfin" && jellyfinMode === "quickconnect") && !(provider === "credentials" && localLoginDisabled) && (
        <form onSubmit={handleSubmit} className="space-y-4">
          {provider === "credentials" && !localLoginDisabled && (
            <>
              <Field label="Email" htmlFor="email">
                <Input
                  id="email"
                  type="email"
                  value={fields.email}
                  onChange={(e) => setField("email", e.target.value)}
                  placeholder="you@example.com"
                  className="bg-zinc-800 border-zinc-700"
                  required
                />
              </Field>
              <Field label="Password" htmlFor="password">
                <Input
                  id="password"
                  type="password"
                  value={fields.password}
                  onChange={(e) => setField("password", e.target.value)}
                  placeholder="••••••••"
                  className="bg-zinc-800 border-zinc-700"
                  required
                />
              </Field>
            </>
          )}

          {provider === "jellyfin" && jellyfinMode === "password" && (
            <>
              <Field label="Jellyfin username" htmlFor="jf-username">
                <Input
                  id="jf-username"
                  type="text"
                  value={fields.username}
                  onChange={(e) => setField("username", e.target.value)}
                  placeholder="username"
                  className="bg-zinc-800 border-zinc-700"
                  autoComplete="username"
                  required
                />
              </Field>
              <Field label="Jellyfin password" htmlFor="jf-password">
                <Input
                  id="jf-password"
                  type="password"
                  value={fields.password}
                  onChange={(e) => setField("password", e.target.value)}
                  placeholder="••••••••"
                  className="bg-zinc-800 border-zinc-700"
                  autoComplete="current-password"
                  required
                />
              </Field>
            </>
          )}

          {error && <p className="text-sm text-red-400">{error}</p>}

          <RememberMeCheckbox checked={rememberMe} onChange={setRememberMe} />

          <Button
            type="submit"
            className="w-full"
            style={{ background: "var(--ds-accent)", color: "var(--ds-accent-fg)" }}
            disabled={loading}
          >
            {loading ? "Signing in…" : "Sign in"}
          </Button>

          {provider === "jellyfin" && (
            <button
              type="button"
              onClick={() => { setJellyfinMode("quickconnect"); setError(""); }}
              className="w-full text-sm text-zinc-400 hover:text-zinc-200 transition-colors"
            >
              Use QuickConnect instead
            </button>
          )}
        </form>
      )}
    </div>
  );
}

function RememberMeCheckbox({
  checked,
  onChange,
}: {
  checked: boolean;
  onChange: (v: boolean) => void;
}) {
  return (
    <label className="flex items-center gap-2 cursor-pointer select-none">
      <input
        type="checkbox"
        checked={checked}
        onChange={(e) => onChange(e.target.checked)}
        className="w-4 h-4 rounded"
        style={{ accentColor: "var(--ds-accent)" }}
      />
      <span className="text-sm" style={{ color: "var(--ds-fg-muted)" }}>Remember me</span>
    </label>
  );
}

function Field({
  label,
  htmlFor,
  children,
}: {
  label: string;
  htmlFor: string;
  children: React.ReactNode;
}) {
  return (
    <div className="space-y-1.5">
      <Label htmlFor={htmlFor}>{label}</Label>
      {children}
    </div>
  );
}

function ProviderTab({
  active,
  onClick,
  children,
}: {
  active: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="flex-1 font-medium transition-colors"
      style={{
        padding: "6px 10px",
        borderRadius: 6,
        fontSize: 13,
        background: active ? "var(--ds-bg-3)" : "transparent",
        color: active ? "var(--ds-fg)" : "var(--ds-fg-muted)",
      }}
    >
      {children}
    </button>
  );
}
