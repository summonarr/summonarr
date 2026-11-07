"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { StyledSelect } from "@/components/ui/styled-select";
import { Loader2 } from "@/components/icons";
import { useSummonarrSession } from "@/components/auth/summonarr-session-provider";
import { BASE_PATH, withBasePath } from "@/lib/base-path";
import { plexForwardUrl, plexReturnBase } from "@/lib/client/plex-approval-url";
import { safeInternalPath } from "@/lib/safe-url";
import { getPasskeyAssertion, isWebAuthnCancel, isWebAuthnSupported, type RequestOptionsJSON } from "@/lib/client/webauthn";
import { rateLimitMessage } from "@/lib/client/rate-limit";
import { useT } from "@/components/i18n/i18n-provider";
import type { Translator } from "@/lib/i18n/translate";

type Provider = "credentials" | "plex" | "jellyfin" | "oidc";

// Every `?error=<code>` on /login is produced by the OIDC routes —
// /api/auth/oidc/start and /callback redirect here on failure — and until this
// map nothing on the page read it, so a denied consent, a disabled account or
// an expired state cookie all landed on a silent login page. A LITERAL map,
// never a key built from the code: the i18n dead-string scan can't see a built
// key, and an unknown code must fall back rather than render a raw key.
const LOGIN_ERROR_CODE_KEYS: Record<string, string> = {
  rate_limited: "auth.login.error.oidc.rate_limited",
  oidc_not_configured: "auth.login.error.oidc.oidc_not_configured",
  oidc_unavailable: "auth.login.error.oidc.oidc_unavailable",
  oidc_no_state: "auth.login.error.oidc.oidc_no_state",
  oidc_state_invalid: "auth.login.error.oidc.oidc_state_invalid",
  oidc_exchange_failed: "auth.login.error.oidc.oidc_exchange_failed",
  oidc_access_denied: "auth.login.error.oidc.oidc_access_denied",
  oidc_idp_error: "auth.login.error.oidc.oidc_idp_error",
  oidc_user_rejected: "auth.login.error.oidc.oidc_user_rejected",
  oidc_rebind_required: "auth.login.error.oidc.oidc_rebind_required",
  oidc_email_unverified: "auth.login.error.oidc.oidc_email_unverified",
  oidc_issuer_mismatch: "auth.login.error.oidc.oidc_issuer_mismatch",
  oidc_not_allowed: "auth.login.error.oidc.oidc_not_allowed",
  oidc_setup_required: "auth.login.error.oidc.oidc_setup_required",
  account_disabled: "auth.login.error.oidc.account_disabled",
  oidc_session_error: "auth.login.error.oidc.oidc_session_error",
};

function describeLoginErrorCode(code: string | null, t: Translator): string {
  if (!code) return "";
  // Own keys only: `?error=__proto__` (or constructor, toString) would
  // otherwise index Object.prototype, skip the fallback and hand the error
  // state an object, which React refuses to render.
  return t(Object.hasOwn(LOGIN_ERROR_CODE_KEYS, code) ? LOGIN_ERROR_CODE_KEYS[code] : "auth.login.error.oidc.generic");
}

// Consecutive non-terminal 5xx answers a QuickConnect poll tolerates, and the
// pause between them, before showing the server's error. Without a limit a
// persistent upstream failure polled into the 30/min per-secret limit, and the
// user saw "too many requests" instead of the cause.
const QC_MAX_CONSECUTIVE_FAILURES = 3;
const QC_FAILURE_BACKOFF_MS = 3_000;
// The poll route's marker for "QuickConnect is disabled on the server".
const QC_DISABLED_CODE = "quickconnect_disabled";

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

type SignInResult = Awaited<ReturnType<typeof signInWithFetch>>;

// The message for a failed sign-in. `fallback` is the provider's own wording
// for a plain refusal.
function signInFailureMessage(res: SignInResult, fallback: string, t: Translator): string {
  if (res.offline) return t("auth.login.error.network");
  if (res.rateLimited) return rateLimitMessage(res.rateLimited, t) ?? t("auth.login.error.signInFailed");
  if (res.disabled) return res.error ?? t("auth.login.error.signInFailed");
  return fallback;
}
type JellyfinMode = "password" | "quickconnect";

interface JellyfinInstance {
  slug: string;
  name: string;
}

interface Props {
  plexEnabled: boolean;
  jellyfinEnabled: boolean;
  jellyfinInstances: JellyfinInstance[];
  oidcEnabled: boolean;
  oidcName: string;
  localLoginDisabled: boolean;
  siteUrl: string;
}

// The password step's answer for an account with two-factor enabled (see
// src/lib/mfa/signin-challenge.ts for the wire contract).
type MfaMethod = "totp" | "webauthn" | "recovery";
interface MfaChallenge {
  mfaToken: string;
  methods: MfaMethod[];
  webauthn?: RequestOptionsJSON;
}

function parseMfaChallenge(body: unknown): MfaChallenge | null {
  if (!body || typeof body !== "object") return null;
  const b = body as Record<string, unknown>;
  if (b.mfaRequired !== true || typeof b.mfaToken !== "string" || !Array.isArray(b.methods)) return null;
  const methods = b.methods.filter((m): m is MfaMethod => m === "totp" || m === "webauthn" || m === "recovery");
  const webauthn = b.webauthn && typeof b.webauthn === "object" ? (b.webauthn as RequestOptionsJSON) : undefined;
  return { mfaToken: b.mfaToken, methods, webauthn };
}

async function signInWithFetch(
  provider: "credentials" | "plex" | "jellyfin" | "jellyfin-quickconnect",
  payload: Record<string, unknown>,
): Promise<{ ok: boolean; error?: string; offline?: boolean; disabled?: boolean; mfa?: MfaChallenge; rateLimited?: Response }> {
  let res: Response;
  try {
    res = await fetch(withBasePath(`/api/auth/sign-in/${provider}`), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      credentials: "include",
      body: JSON.stringify(payload),
    });
  } catch {
    // Transport failure — offline, DNS, aborted. Reported as its own outcome
    // rather than folded into `ok: false`, because callers answer a plain
    // failure with "Invalid email or password." Telling someone their password
    // is wrong when their WiFi dropped sends them to retype it forever.
    return { ok: false, offline: true };
  }
  if (res.status === 429) return { ok: false, rateLimited: res };
  if (!res.ok) {
    // No default text here: callers substitute their own (translated) message.
    let error: string | undefined;
    try {
      const body = await res.json();
      // Correct password, second factor still owed — not a failure to report.
      const mfa = parseMfaChallenge(body);
      if (mfa) return { ok: false, mfa };
      if (typeof body?.error === "string") error = body.error;
    } catch {}
    // 403 is the disabled-account answer (disabledAccountResponse) — the one
    // failure where "check your password" is the wrong advice, so callers show
    // the server's message instead of their generic one.
    return { ok: false, error, disabled: res.status === 403 };
  }
  return { ok: true };
}

// The state every provider panel shares with the form around it.
interface PanelState {
  error: string;
  setError: (message: string) => void;
  loading: boolean;
  setLoading: (loading: boolean) => void;
  rememberMe: boolean;
  setRememberMe: (remember: boolean) => void;
}

interface Fields {
  email: string;
  password: string;
  username: string;
}

const EMPTY_FIELDS: Fields = { email: "", password: "", username: "" };

// A local-credentials or Jellyfin password sign-in. `invalidMessage` is the
// provider's own wording for a plain refusal.
type PasswordSignIn = (
  provider: "credentials" | "jellyfin",
  payload: Record<string, unknown>,
  invalidMessage: string,
) => Promise<void>;

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

// The provider tabs, the sign-in state they share, and the hand-off to the
// second-factor step. Each provider's own flow lives in its panel below.
export function LoginForm({ plexEnabled, jellyfinEnabled, jellyfinInstances, oidcEnabled, oidcName, localLoginDisabled, siteUrl }: Props) {
  const t = useT();
  const router = useRouter();
  const searchParams = useSearchParams();
  // Sidebar/header read role from this context; refresh after sign-in so
  // admin nav appears without a hard reload. router.refresh() then re-runs
  // the (app)/layout server component (which gates maintenance-mode bypass
  // on session.role === "ADMIN").
  const { refresh: refreshSession } = useSummonarrSession();

  // Resolve-then-compare-origin, not a startsWith test: `?callbackUrl=/%09/evil.com`
  // decodes to `/\t/evil.com`, which passes "starts with / and not //" but which
  // router.push resolves to https://evil.com/. See src/lib/safe-url.ts.
  const callbackUrl = safeInternalPath(searchParams.get("callbackUrl")) ?? "/";
  // Read ONCE, as initial state (never re-read on later renders, so a retry
  // that fails client-side replaces it instead of fighting it). The page is
  // force-dynamic, so useSearchParams is populated during SSR too and the
  // server and client initial states agree.
  const initialErrorCode = searchParams.get("error");

  const defaultProvider: Provider = localLoginDisabled
    ? (oidcEnabled ? "oidc" : plexEnabled ? "plex" : jellyfinEnabled ? "jellyfin" : "credentials")
    : "credentials";
  // A redirected-back OIDC failure lands on the tab it came from, so the
  // message sits beside the button that retries it.
  const [provider, setProvider] = useState<Provider>(initialErrorCode && oidcEnabled ? "oidc" : defaultProvider);
  // Kept here rather than in a panel so the email survives the trip to the
  // second-factor step and back.
  const [fields, setFields] = useState<Fields>(EMPTY_FIELDS);
  const [rememberMe, setRememberMe] = useState(false);
  const [error, setError] = useState(() => describeLoginErrorCode(initialErrorCode, t));
  const [loading, setLoading] = useState(false);
  // Set when the password was right but the account has two-factor enabled.
  const [mfaChallenge, setMfaChallenge] = useState<MfaChallenge | null>(null);
  // Bumped by every tab click, the active tab's included. The Jellyfin panel is
  // keyed on it, so a click remounts it fresh — password mode, the first
  // server, and its QuickConnect run cancelled by the unmount.
  const [panelGeneration, setPanelGeneration] = useState(0);

  // Plex and OIDC hand off with `window.location.href`, deliberately leaving
  // `loading` true because the document is about to be destroyed. Coming BACK
  // via the browser's Back button does not destroy it: bfcache resumes the same
  // document with its JS heap intact, so React never remounts, no effect
  // re-runs, and `loading` returns as true — a permanently disabled Sign in
  // button with no error text to explain it. Reset on a persisted restore only;
  // a normal load already starts false.
  //
  // A QuickConnect run is deliberately NOT cancelled here: QuickConnect never
  // leaves the page, so it can never be the restored flow, and cancelling it
  // would be spurious.
  useEffect(() => {
    const onPageShow = (e: PageTransitionEvent) => {
      if (e.persisted) setLoading(false);
    };
    window.addEventListener("pageshow", onPageShow);
    return () => window.removeEventListener("pageshow", onPageShow);
  }, []);

  const hasExternalProviders = plexEnabled || jellyfinEnabled || oidcEnabled;

  function setField(key: keyof Fields, value: string) {
    setFields((f) => ({ ...f, [key]: value }));
  }

  useEffect(() => {
    // Adopt the server-assigned Plex client ID (if any) so the browser and the
    // server identify this device to Plex with the same ID. Only a signed-in
    // visitor gets one back, and only matters when Plex sign-in is offered.
    if (!plexEnabled) return;
    let cancelled = false;
    fetch(withBasePath("/api/auth/plex/client-id"), { cache: "no-store" })
      .then((r) => (r.ok ? r.json() : null))
      .then((data: { clientId?: string | null } | null) => {
        if (cancelled || !data?.clientId) return;
        const current = readPlexClientId();
        if (current !== data.clientId) writePlexClientId(data.clientId);
      })
      .catch(() => { });
    return () => { cancelled = true; };
  }, [plexEnabled]);

  // Every successful sign-in ends the same way: refresh the session context,
  // re-run the server components, then go to the destination.
  async function completeSignIn() {
    await refreshSession();
    router.refresh();
    router.push(callbackUrl);
  }

  const signInWithPassword: PasswordSignIn = async (fetchProvider, payload, invalidMessage) => {
    setLoading(true);
    setError("");
    const res = await signInWithFetch(fetchProvider, payload);

    if (res.mfa) {
      setMfaChallenge(res.mfa);
      setFields((f) => ({ ...f, password: "" }));
      setLoading(false);
      return;
    }

    if (!res.ok) {
      setError(signInFailureMessage(res, invalidMessage, t));
      setLoading(false);
    } else {
      await completeSignIn();
    }
  };

  function switchProvider(next: Provider) {
    setPanelGeneration((g) => g + 1);
    setMfaChallenge(null);
    setProvider(next);
    setError("");
    setFields(EMPTY_FIELDS);
    setRememberMe(false);
    setLoading(false);
  }

  if (mfaChallenge) {
    return (
      <MfaStep
        challenge={mfaChallenge}
        onSuccess={completeSignIn}
        onRestart={(message) => {
          setMfaChallenge(null);
          setError(message ?? "");
        }}
      />
    );
  }

  const panel: PanelState = { error, setError, loading, setLoading, rememberMe, setRememberMe };

  return (
    <div className="space-y-5">
      {localLoginDisabled && !hasExternalProviders && (
        // Password sign-in is off and no provider is wired up: without this the
        // card rendered its heading above an empty box with nothing to say why.
        <div
          role="alert"
          className="text-sm"
          style={{
            background: "color-mix(in oklab, var(--ds-warning) 12%, transparent)",
            border: "1px solid color-mix(in oklab, var(--ds-warning) 28%, transparent)",
            borderRadius: "var(--ds-r-md)",
            padding: "10px 12px",
            color: "var(--ds-fg)",
          }}
        >
          {t("auth.login.noMethods")}
        </div>
      )}

      {hasExternalProviders && (
        <div
          role="group"
          aria-label={t("auth.login.method")}
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
              {t("auth.login.tab.password")}
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

      {provider === "oidc" && <OidcPanel panel={panel} oidcName={oidcName} callbackUrl={callbackUrl} />}

      {provider === "plex" && <PlexPanel panel={panel} callbackUrl={callbackUrl} siteUrl={siteUrl} />}

      {provider === "jellyfin" && (
        <JellyfinPanel
          key={panelGeneration}
          panel={panel}
          instances={jellyfinInstances}
          fields={fields}
          setField={setField}
          signInWithPassword={signInWithPassword}
          onSignedIn={completeSignIn}
        />
      )}

      {provider === "credentials" && !localLoginDisabled && (
        <CredentialsForm panel={panel} fields={fields} setField={setField} signInWithPassword={signInWithPassword} />
      )}
    </div>
  );
}

function OidcPanel({ panel, oidcName, callbackUrl }: { panel: PanelState; oidcName: string; callbackUrl: string }) {
  const t = useT();
  const { rememberMe, setRememberMe, loading, setLoading, error, setError } = panel;
  return (
    <div className="space-y-3">
      <RememberMeCheckbox checked={rememberMe} onChange={setRememberMe} />
      <Button
        onClick={() => {
          setLoading(true);
          setError("");
          const qp = new URLSearchParams();
          if (callbackUrl && callbackUrl !== "/") qp.set("callbackUrl", callbackUrl);
          // Carried in the signed flow state to the callback's mint.
          if (rememberMe) qp.set("rememberMe", "1");
          const qs = qp.toString();
          window.location.href = withBasePath(`/api/auth/oidc/start${qs ? `?${qs}` : ""}`);
        }}
        disabled={loading}
        className="w-full min-h-11"
      >
        {loading ? (
          <><Loader2 className="w-4 h-4 mr-2 animate-spin" />{t("auth.login.redirecting")}</>
        ) : (
          t("auth.login.signInWith", { provider: oidcName })
        )}
      </Button>
      <ErrorText error={error} />
    </div>
  );
}

function PlexPanel({ panel, callbackUrl, siteUrl }: { panel: PanelState; callbackUrl: string; siteUrl: string }) {
  const t = useT();
  const { rememberMe, setRememberMe, loading, setLoading, error, setError } = panel;

  async function handlePlexSignIn() {
    setLoading(true);
    setError("");
    const clientId = getPlexClientId();
    const deviceMeta = getPlexDeviceMeta();

    let pinId: number;
    let pinCode: string;
    try {
      // Server creates the PIN and sets a signed HttpOnly cookie binding the
      // pinId to this browser. /api/auth/sign-in/plex rejects any submission
      // whose body pinId doesn't match the cookie's pinId, defeating
      // PIN-phishing attacks where an attacker's PIN gets approved by a
      // victim and the resulting token is submitted from the attacker's
      // browser.
      const res = await fetch(withBasePath("/api/auth/plex/start"), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify({
          clientId,
          platform: deviceMeta.platform,
          device: deviceMeta.device,
          model: deviceMeta.model,
        }),
      });
      if (!res.ok) throw new Error("create failed");
      const data: { pinId: number; code: string } = await res.json();
      pinId = data.pinId;
      pinCode = data.code;
    } catch {
      setError(t("auth.login.error.plexStart"));
      setLoading(false);
      return;
    }

    const state = crypto.randomUUID();
    // siteUrl is the admin site URL, else AUTH_URL (a bare origin): the return
    // base carries BASE_PATH, or a sub-path install is sent back to a 404. The
    // same base is what /auth/plex/done lands on after sign-in.
    const base = plexReturnBase(siteUrl, window.location.origin, BASE_PATH);
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
      forwardUrl: plexForwardUrl(base, state),
    });
    const plexUrl = `https://app.plex.tv/auth/#!?${oauthParams.toString()}`;

    // PIN state is stashed in sessionStorage because the page navigates away; /auth/plex/done reads it on return
    try {
      sessionStorage.setItem("plex-redirect-auth", JSON.stringify({
        flow: "login", pinId, clientId, rememberMe, callbackUrl, siteUrl: base, state, deviceMeta,
      }));
    } catch {
      setError(t("auth.login.error.storeState"));
      setLoading(false);
      return;
    }
    window.location.href = plexUrl;
  }

  return (
    <div className="space-y-3">
      <RememberMeCheckbox checked={rememberMe} onChange={setRememberMe} />
      <Button
        onClick={handlePlexSignIn}
        disabled={loading}
        // hover:bg is restated, not just brightness: the default variant's
        // hover:bg-primary/90 would otherwise turn the Plex button accent-
        // coloured on hover (different variant prefix, so it isn't merged away).
        className="w-full min-h-11 bg-[var(--ds-plex)] hover:bg-[var(--ds-plex)] hover:brightness-110 text-black font-semibold"
      >
        {loading ? (
          <><Loader2 className="w-4 h-4 mr-2 animate-spin" />{t("auth.login.waitingForPlex")}</>
        ) : (
          t("auth.login.signInWith", { provider: "Plex" })
        )}
      </Button>
      <ErrorText error={error} />
    </div>
  );
}

function CredentialsForm({
  panel,
  fields,
  setField,
  signInWithPassword,
}: {
  panel: PanelState;
  fields: Fields;
  setField: (key: keyof Fields, value: string) => void;
  signInWithPassword: PasswordSignIn;
}) {
  const t = useT();

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    await signInWithPassword(
      "credentials",
      { email: fields.email, password: fields.password, rememberMe: String(panel.rememberMe) },
      t("auth.login.error.invalidCredentials"),
    );
  }

  return (
    <PasswordForm panel={panel} onSubmit={handleSubmit}>
      <Field label={t("auth.field.email")} htmlFor="email">
        <Input
          id="email"
          type="email"
          value={fields.email}
          onChange={(e) => setField("email", e.target.value)}
          placeholder={t("auth.field.emailPlaceholder")}
          autoComplete="email"
          required
        />
      </Field>
      <Field label={t("auth.field.password")} htmlFor="password">
        <Input
          id="password"
          type="password"
          value={fields.password}
          onChange={(e) => setField("password", e.target.value)}
          placeholder="••••••••"
          autoComplete="current-password"
          required
        />
      </Field>
    </PasswordForm>
  );
}

function JellyfinPanel({
  panel,
  instances,
  fields,
  setField,
  signInWithPassword,
  onSignedIn,
}: {
  panel: PanelState;
  instances: JellyfinInstance[];
  fields: Fields;
  setField: (key: keyof Fields, value: string) => void;
  signInWithPassword: PasswordSignIn;
  onSignedIn: () => Promise<void>;
}) {
  const t = useT();
  const { rememberMe, setRememberMe, loading, setLoading, error, setError } = panel;
  const [jellyfinMode, setJellyfinMode] = useState<JellyfinMode>("password");
  // Defaults to the FIRST syncable instance, not a bare "" — an admin can
  // configure only a named instance (e.g. via the separate "Additional media
  // servers" card) with no default ever wired up, in which case "" isn't a
  // valid instance at all and every sign-in would 503. Every existing
  // single-default deployment still resolves this to "" (getSyncableMediaInstances
  // always returns the default first when it's configured), so the select
  // below (which only renders for length > 1) never has to move it.
  const [jellyfinInstance, setJellyfinInstance] = useState(instances[0]?.slug ?? "");
  const { qcCode, setQcCode, handleQuickConnect, cancelQuickConnect } = useQuickConnect({
    jellyfinInstance,
    panel,
    onSignedIn,
  });

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    await signInWithPassword(
      "jellyfin",
      { username: fields.username, password: fields.password, rememberMe: String(rememberMe), instance: jellyfinInstance },
      t("auth.login.error.jellyfinInvalid"),
    );
  }

  return (
    <>
      {instances.length > 1 && (
        <Field label={t("auth.login.server")} htmlFor="jf-instance">
          <StyledSelect
            id="jf-instance"
            value={jellyfinInstance}
            onChange={(e) => setJellyfinInstance(e.target.value)}
            className="w-full"
          >
            {instances.map((i) => (
              <option key={i.slug} value={i.slug}>{i.name}</option>
            ))}
          </StyledSelect>
        </Field>
      )}

      {jellyfinMode === "quickconnect" ? (
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
              <p className="text-sm m-0" style={{ color: "var(--ds-fg-muted)" }}>{t("auth.login.quickConnect.enterCode")}</p>
              <p
                className="ds-mono m-0 font-bold tracking-widest"
                style={{ fontSize: 32, color: "var(--ds-fg)" }}
              >
                {qcCode}
              </p>
              <div className="flex items-center justify-center gap-2 text-sm" style={{ color: "var(--ds-fg-muted)" }}>
                <Loader2 className="w-4 h-4 animate-spin" />
                {t("auth.login.quickConnect.waiting")}
              </div>
            </div>
          ) : (
            <Button
              onClick={handleQuickConnect}
              disabled={loading}
              className="w-full min-h-11"
            >
              {loading ? <><Loader2 className="w-4 h-4 mr-2 animate-spin" />{t("auth.login.quickConnect.starting")}</> : t("auth.login.quickConnect.generate")}
            </Button>
          )}
          <ErrorText error={error} />
          <button
            type="button"
            onClick={() => { cancelQuickConnect(); setJellyfinMode("password"); setError(""); setQcCode(null); setLoading(false); }}
            className="ds-hover-tint w-full min-h-9 rounded-md text-sm text-zinc-400 hover:text-zinc-200 transition-colors"
          >
            {t("auth.login.quickConnect.usePassword")}
          </button>
        </div>
      ) : (
        <PasswordForm
          panel={panel}
          onSubmit={handleSubmit}
          footer={
            <button
              type="button"
              onClick={() => { setJellyfinMode("quickconnect"); setError(""); }}
              className="ds-hover-tint w-full min-h-9 rounded-md text-sm text-zinc-400 hover:text-zinc-200 transition-colors"
            >
              {t("auth.login.quickConnect.useInstead")}
            </button>
          }
        >
          <Field label={t("auth.login.jellyfinUsername")} htmlFor="jf-username">
            <Input
              id="jf-username"
              type="text"
              value={fields.username}
              onChange={(e) => setField("username", e.target.value)}
              placeholder={t("auth.login.usernamePlaceholder")}
              autoComplete="username"
              required
            />
          </Field>
          <Field label={t("auth.login.jellyfinPassword")} htmlFor="jf-password">
            <Input
              id="jf-password"
              type="password"
              value={fields.password}
              onChange={(e) => setField("password", e.target.value)}
              placeholder="••••••••"
              autoComplete="current-password"
              required
            />
          </Field>
        </PasswordForm>
      )}
    </>
  );
}

// Jellyfin QuickConnect: the server issues a short-lived code the user enters
// in another Jellyfin client, then this polls until that client approves it.
// Owned by the Jellyfin panel, whose unmount (a provider switch, or any tab
// click — the panel is keyed) cancels the run.
function useQuickConnect({
  jellyfinInstance,
  panel,
  onSignedIn,
}: {
  jellyfinInstance: string;
  panel: PanelState;
  onSignedIn: () => Promise<void>;
}) {
  const t = useT();
  const { rememberMe, setLoading, setError } = panel;
  const [qcCode, setQcCode] = useState<string | null>(null);
  // Cancels an in-flight QuickConnect poll loop (provider switch, "Use password
  // instead", unmount) so an abandoned code can't later complete a sign-in.
  //
  // A per-run generation, NOT a shared boolean: with one flag, starting a SECOND
  // QuickConnect reset it to false and thereby un-cancelled the first loop, which
  // then resumed polling its abandoned secret — both runs could reach
  // signInWithFetch. Each run captures its own id and bails the moment it is no
  // longer the current one; cancelling just bumps the counter.
  const qcRunRef = useRef(0);
  // The current run's requests. Aborting frees the server's long-poll slot at
  // once (it holds one of three per IP for up to 25s); bumping the generation
  // alone left the abandoned request running, so a few cancel-and-retry rounds
  // hit "too many polls".
  const qcAbortRef = useRef<AbortController | null>(null);
  const cancelQuickConnect = useCallback(() => {
    qcRunRef.current += 1;
    qcAbortRef.current?.abort();
    qcAbortRef.current = null;
  }, []);

  useEffect(() => cancelQuickConnect, [cancelQuickConnect]);

  async function handleQuickConnect() {
    cancelQuickConnect();
    const myRun = qcRunRef.current;
    const abort = new AbortController();
    qcAbortRef.current = abort;
    setLoading(true);
    setError("");
    setQcCode(null);

    const instanceQs = jellyfinInstance ? `?instance=${encodeURIComponent(jellyfinInstance)}` : "";

    let secret: string;
    let code: string;
    try {
      const res = await fetch(withBasePath(`/api/auth/jellyfin/quickconnect${instanceQs}`), {
        method: "POST",
        signal: abort.signal,
      });
      if (!res.ok) {
        // The server's own (translated) reason, e.g. QuickConnect is disabled.
        const body = (await res.json().catch(() => null)) as { error?: unknown } | null;
        if (qcRunRef.current !== myRun) return;
        setError(typeof body?.error === "string" && body.error ? body.error : t("auth.login.error.quickConnectStart"));
        setLoading(false);
        return;
      }
      const data: { secret: string; code: string } = await res.json();
      secret = data.secret;
      code = data.code;
    } catch {
      // A cancel (provider switch, "Use password instead", unmount) already reset the UI.
      if (abort.signal.aborted || qcRunRef.current !== myRun) return;
      setError(t("auth.login.error.quickConnectStart"));
      setLoading(false);
      return;
    }
    if (qcRunRef.current !== myRun) return;

    setQcCode(code);

    // Server holds each request up to ~25s; this wall-clock budget bounds the total wait
    const deadline = Date.now() + 2 * 60 * 1000;
    let authenticated = false;
    let consecutiveFailures = 0;
    while (Date.now() < deadline) {
      if (qcRunRef.current !== myRun) return;
      try {
        const poll = await fetch(
          withBasePath(`/api/auth/jellyfin/quickconnect?secret=${encodeURIComponent(secret)}&wait=1${instanceQs ? `&instance=${encodeURIComponent(jellyfinInstance)}` : ""}`),
          { signal: abort.signal },
        );
        if (poll.ok) {
          consecutiveFailures = 0;
          const data: { authenticated: boolean } = await poll.json();
          if (data.authenticated) { authenticated = true; break; }
        } else if (poll.status === 410) {
          break;
        } else if (poll.status === 400 || poll.status === 429 || poll.status === 503) {
          // Non-transient: retrying every second until the deadline only burns
          // the rate-limit budget. Stop and show the server's translated error.
          const body: { error?: string } | null = await poll.json().catch(() => null);
          if (qcRunRef.current !== myRun) return;
          setError(body?.error || t("auth.login.error.quickConnectFailed"));
          setLoading(false);
          setQcCode(null);
          return;
        } else {
          // Another failure (a 502 from Jellyfin, a proxy's 5xx). QuickConnect
          // disabled on the server is terminal; anything else is retried a few
          // times, more slowly, before its error is shown.
          const body = (await poll.json().catch(() => null)) as { error?: unknown; code?: unknown } | null;
          if (qcRunRef.current !== myRun) return;
          consecutiveFailures += 1;
          if (body?.code === QC_DISABLED_CODE || consecutiveFailures >= QC_MAX_CONSECUTIVE_FAILURES) {
            setError(typeof body?.error === "string" && body.error ? body.error : t("auth.login.error.quickConnectFailed"));
            setLoading(false);
            setQcCode(null);
            return;
          }
          await sleep(QC_FAILURE_BACKOFF_MS);
        }
      } catch {
        // Cancelled: the run is over, no pause.
        if (abort.signal.aborted) return;
        // Fetch rejected immediately (network down) — pause so the loop can't hot-spin.
        await sleep(1000);
      }
    }

    if (qcRunRef.current !== myRun) return;

    if (!authenticated) {
      setError(t("auth.login.error.quickConnectTimeout"));
      setLoading(false);
      setQcCode(null);
      return;
    }

    const result = await signInWithFetch("jellyfin-quickconnect", { secret, rememberMe: String(rememberMe) });
    // Re-check AFTER the await, not just before it. The checks above are
    // separated from the call by nothing, so cancellation can only land while
    // this request is in flight — and the QuickConnect card (with its "Use
    // password instead" button) and the provider tabs are all still on screen
    // for its whole duration. Without this, backing out still ran the else
    // branch and navigated the user into the app. It cannot un-issue the
    // request — the server may already have minted the session — but the
    // navigation is the half the user actually sees.
    if (qcRunRef.current !== myRun) return;
    if (!result.ok) {
      setError(signInFailureMessage(result, t("auth.login.error.quickConnectFailed"), t));
      setLoading(false);
      setQcCode(null);
    } else {
      await onSignedIn();
    }
  }

  return { qcCode, setQcCode, handleQuickConnect, cancelQuickConnect };
}

// The submit-button half every password form shares (local credentials and
// Jellyfin): the fields above it, remember me, Sign in, then the error.
function PasswordForm({
  panel,
  onSubmit,
  footer,
  children,
}: {
  panel: PanelState;
  onSubmit: (e: React.FormEvent) => void;
  footer?: React.ReactNode;
  children: React.ReactNode;
}) {
  const t = useT();
  return (
    <form onSubmit={onSubmit} className="space-y-4">
      {children}

      <RememberMeCheckbox checked={panel.rememberMe} onChange={panel.setRememberMe} />

      <Button
        type="submit"
        className="w-full min-h-11"
        disabled={panel.loading}
      >
        {panel.loading ? (
          <><Loader2 className="w-4 h-4 mr-2 animate-spin" />{t("auth.login.signingIn")}</>
        ) : (
          t("auth.login.signIn")
        )}
      </Button>

      {/* Below the submit, like the OIDC / Plex / QuickConnect / MFA paths,
          so switching tabs doesn't move the error above the button. */}
      <ErrorText error={panel.error} />

      {footer}
    </form>
  );
}

// Every panel's error sits directly below its own button.
function ErrorText({ error }: { error: string }) {
  if (!error) return null;
  return <p role="alert" aria-live="assertive" className="text-sm text-red-400">{error}</p>;
}

// Second step of a password sign-in for an account with two-factor enabled.
// Everything decisive happens server-side at POST /api/auth/sign-in/mfa.
function MfaStep({
  challenge,
  onSuccess,
  onRestart,
}: {
  challenge: MfaChallenge;
  onSuccess: () => Promise<void>;
  onRestart: (message?: string) => void;
}) {
  const t = useT();
  const initial: MfaMethod = challenge.methods.includes("totp")
    ? "totp"
    : challenge.methods.includes("webauthn")
      ? "webauthn"
      : "recovery";
  const [method, setMethod] = useState<MfaMethod>(initial);
  const [code, setCode] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  async function submit(body: Record<string, unknown>) {
    setBusy(true);
    setError("");
    let res: Response;
    try {
      res = await fetch(withBasePath("/api/auth/sign-in/mfa"), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify({ mfaToken: challenge.mfaToken, ...body }),
      });
    } catch {
      setError(t("auth.login.error.network"));
      setBusy(false);
      return;
    }
    if (res.ok) {
      await onSuccess();
      return;
    }
    const data = (await res.json().catch(() => ({}))) as { error?: string; mfaExpired?: boolean };
    if (data.mfaExpired) {
      onRestart(data.error ?? t("auth.mfa.error.expired"));
      return;
    }
    setError(data.error ?? t("auth.mfa.error.failed"));
    setCode("");
    setBusy(false);
  }

  async function usePasskey() {
    if (!challenge.webauthn) return;
    if (!isWebAuthnSupported()) {
      setError(t("auth.mfa.error.passkeyUnsupported"));
      return;
    }
    let credential: Record<string, unknown>;
    try {
      credential = await getPasskeyAssertion(challenge.webauthn);
    } catch (err) {
      if (!isWebAuthnCancel(err)) setError(t("auth.mfa.error.passkeyFailed"));
      return;
    }
    await submit({ method: "webauthn", credential });
  }

  const noMethods = challenge.methods.length === 0;

  return (
    <div className="space-y-4">
      <div className="space-y-1">
        <p className="text-sm font-medium m-0" style={{ color: "var(--ds-fg)" }}>{t("auth.mfa.title")}</p>
        <p className="text-sm m-0" style={{ color: "var(--ds-fg-muted)" }}>
          {noMethods
            ? t("auth.mfa.noMethods")
            : method === "totp"
              ? t("auth.mfa.totpHint")
              : method === "webauthn"
                ? t("auth.mfa.passkeyHint")
                : t("auth.mfa.recoveryHint")}
        </p>
      </div>

      {method === "webauthn" && challenge.methods.includes("webauthn") && (
        <Button type="button" onClick={usePasskey} disabled={busy} className="w-full min-h-11">
          {busy ? <><Loader2 className="w-4 h-4 mr-2 animate-spin" />{t("auth.mfa.verifying")}</> : t("auth.mfa.usePasskeyButton")}
        </Button>
      )}

      {(method === "totp" || method === "recovery") && challenge.methods.includes(method) && (
        <form
          className="space-y-3"
          onSubmit={(e) => {
            e.preventDefault();
            void submit({ method, code });
          }}
        >
          <Field label={method === "totp" ? t("auth.mfa.verificationCode") : t("auth.mfa.recoveryCode")} htmlFor="mfa-code">
            <Input
              id="mfa-code"
              value={code}
              onChange={(e) => setCode(e.target.value)}
              autoComplete="one-time-code"
              inputMode={method === "totp" ? "numeric" : "text"}
              placeholder={method === "totp" ? "123456" : "XXXX-XXXX-XXXX-XXXX"}
              maxLength={method === "totp" ? 7 : 24}
              autoFocus
              required
            />
          </Field>
          <Button type="submit" disabled={busy || code.trim().length === 0} className="w-full min-h-11">
            {busy ? t("auth.mfa.verifying") : t("auth.mfa.verify")}
          </Button>
        </form>
      )}

      {error && <p role="alert" aria-live="assertive" className="text-sm text-red-400">{error}</p>}

      <div className="flex flex-col gap-1">
        {challenge.methods.filter((m) => m !== method).map((m) => (
          <button
            key={m}
            type="button"
            onClick={() => { setMethod(m); setError(""); setCode(""); }}
            className="ds-hover-tint w-full min-h-9 rounded-md text-sm text-zinc-400 hover:text-zinc-200 transition-colors"
          >
            {m === "totp" ? t("auth.mfa.switch.totp") : m === "webauthn" ? t("auth.mfa.switch.passkey") : t("auth.mfa.switch.recovery")}
          </button>
        ))}
        <button
          type="button"
          onClick={() => onRestart()}
          className="ds-hover-tint w-full min-h-9 rounded-md text-sm text-zinc-400 hover:text-zinc-200 transition-colors"
        >
          {t("auth.mfa.backToSignIn")}
        </button>
      </div>
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
  const t = useT();
  return (
    <label className="flex items-center gap-2 cursor-pointer select-none">
      <input
        type="checkbox"
        checked={checked}
        onChange={(e) => onChange(e.target.checked)}
        className="w-4 h-4 rounded"
        style={{ accentColor: "var(--ds-accent)" }}
      />
      <span className="text-sm" style={{ color: "var(--ds-fg-muted)" }}>{t("auth.login.rememberMe")}</span>
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
      aria-pressed={active}
      onClick={onClick}
      // min-w-0 + truncate: with all four providers on a 375px phone a long
      // single-word OIDC_DISPLAY_NAME ("Authentik") otherwise pushes the strip
      // past the card's border, since flex items default to min-width:auto.
      // ds-hover-tint: the background is set inline, so only the inset-shadow
      // tint can give hover feedback and the DS focus ring (guardrail 42).
      className="ds-hover-tint flex-1 min-w-0 truncate font-medium transition-colors"
      style={{
        // Padding alone landed at ~43.5px (just under 44), so an explicit
        // minHeight guarantees Apple HIG tap-target compliance.
        padding: "12px 12px",
        minHeight: 44,
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
