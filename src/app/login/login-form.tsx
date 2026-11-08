"use client";

import { useEffect, useMemo, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { StyledSelect } from "@/components/ui/styled-select";
import { Loader2 } from "@/components/icons";
import { useSummonarrSession } from "@/components/auth/summonarr-session-provider";
import { withBasePath } from "@/lib/base-path";
import { fetchJson } from "@/lib/client/fetch-json";
import { signInFailureMessage, type MfaChallenge } from "@/lib/client/login-answers";
import { safeInternalPath } from "@/lib/safe-url";
import { v } from "@/lib/validate";
import { useT } from "@/components/i18n/i18n-provider";
import type { Translator } from "@/lib/i18n/translate";
import { EMPTY_FIELDS, ErrorText, Field, PasswordForm, ProviderTab, RememberMeCheckbox, SecondaryAction, type Fields, type PanelState, type PasswordSignIn } from "./login-parts";
import { MfaStep } from "./mfa-step";
import { readPlexClientId, startPlexSignIn, writePlexClientId } from "./plex-sign-in";
import { signInWithFetch } from "./sign-in-request";
import { useQuickConnect } from "./use-quick-connect";

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

// The tab a visit opens on: password sign-in, else the first external provider.
function defaultProviderFor(p: Pick<Props, "localLoginDisabled" | "oidcEnabled" | "plexEnabled" | "jellyfinEnabled">): Provider {
  if (!p.localLoginDisabled) return "credentials";
  if (p.oidcEnabled) return "oidc";
  if (p.plexEnabled) return "plex";
  if (p.jellyfinEnabled) return "jellyfin";
  return "credentials";
}

const PlexClientIdAnswer = v.object({ clientId: v.optional(v.nullable(v.string())) });

// Adopt the server-assigned Plex client ID (if any) so the browser and the
// server identify this device to Plex with the same ID. Only a signed-in
// visitor gets one back, and only matters when Plex sign-in is offered.
function usePlexClientIdAdoption(plexEnabled: boolean) {
  useEffect(() => {
    if (!plexEnabled) return;
    const abort = new AbortController();
    void fetchJson(withBasePath("/api/auth/plex/client-id"), {
      init: { cache: "no-store" },
      schema: PlexClientIdAnswer,
      signal: abort.signal,
    }).then((res) => {
      if (!res.ok || !res.data?.clientId) return;
      try {
        if (readPlexClientId() !== res.data.clientId) writePlexClientId(res.data.clientId);
      } catch {
        // Storage blocked: the sign-in mints its own id instead.
      }
    });
    return () => abort.abort();
  }, [plexEnabled]);
}

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
function useBfcacheLoadingReset(setLoading: (loading: boolean) => void) {
  useEffect(() => {
    const onPageShow = (e: PageTransitionEvent) => {
      if (e.persisted) setLoading(false);
    };
    window.addEventListener("pageshow", onPageShow);
    return () => window.removeEventListener("pageshow", onPageShow);
  }, [setLoading]);
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

  // A redirected-back OIDC failure lands on the tab it came from, so the
  // message sits beside the button that retries it.
  const [provider, setProvider] = useState<Provider>(() =>
    initialErrorCode && oidcEnabled ? "oidc" : defaultProviderFor({ localLoginDisabled, oidcEnabled, plexEnabled, jellyfinEnabled }),
  );
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

  useBfcacheLoadingReset(setLoading);
  usePlexClientIdAdoption(plexEnabled);

  const hasExternalProviders = plexEnabled || jellyfinEnabled || oidcEnabled;
  const panel: PanelState = useMemo(
    () => ({ error, setError, loading, setLoading, rememberMe, setRememberMe }),
    [error, loading, rememberMe],
  );

  function setField(key: keyof Fields, value: string) {
    setFields((f) => ({ ...f, [key]: value }));
  }

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

  return (
    <div className="space-y-5">
      {/* Password sign-in is off and no provider is wired up: without this the
          card rendered its heading above an empty box with nothing to say why. */}
      {localLoginDisabled && !hasExternalProviders && <NoMethodsNotice />}

      {hasExternalProviders && (
        <ProviderTabs
          provider={provider}
          onSelect={switchProvider}
          localLoginDisabled={localLoginDisabled}
          plexEnabled={plexEnabled}
          jellyfinEnabled={jellyfinEnabled}
          oidcEnabled={oidcEnabled}
          oidcName={oidcName}
        />
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

function NoMethodsNotice() {
  const t = useT();
  return (
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
  );
}

function ProviderTabs({
  provider,
  onSelect,
  localLoginDisabled,
  plexEnabled,
  jellyfinEnabled,
  oidcEnabled,
  oidcName,
}: {
  provider: Provider;
  onSelect: (next: Provider) => void;
  localLoginDisabled: boolean;
  plexEnabled: boolean;
  jellyfinEnabled: boolean;
  oidcEnabled: boolean;
  oidcName: string;
}) {
  const t = useT();
  return (
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
        <ProviderTab active={provider === "credentials"} onClick={() => onSelect("credentials")}>
          {t("auth.login.tab.password")}
        </ProviderTab>
      )}
      {plexEnabled && (
        <ProviderTab active={provider === "plex"} onClick={() => onSelect("plex")}>
          Plex
        </ProviderTab>
      )}
      {jellyfinEnabled && (
        <ProviderTab active={provider === "jellyfin"} onClick={() => onSelect("jellyfin")}>
          Jellyfin
        </ProviderTab>
      )}
      {oidcEnabled && (
        <ProviderTab active={provider === "oidc"} onClick={() => onSelect("oidc")}>
          {oidcName}
        </ProviderTab>
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

  // startPlexSignIn never throws, so every failure ends with its message and
  // the button back; only a success leaves `loading` set for the navigation.
  async function handlePlexSignIn() {
    setLoading(true);
    setError("");
    const started = await startPlexSignIn({ rememberMe, callbackUrl, siteUrl, t });
    if (!started.ok) {
      setError(started.error);
      setLoading(false);
      return;
    }
    window.location.href = started.url;
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
  const { rememberMe, setLoading, setError } = panel;
  const [jellyfinMode, setJellyfinMode] = useState<JellyfinMode>("password");
  // Defaults to the FIRST syncable instance, not a bare "" — an admin can
  // configure only a named instance (e.g. via the separate "Additional media
  // servers" card) with no default ever wired up, in which case "" isn't a
  // valid instance at all and every sign-in would 503. Every existing
  // single-default deployment still resolves this to "" (getSyncableMediaInstances
  // always returns the default first when it's configured), so the select
  // below (which only renders for length > 1) never has to move it.
  const [jellyfinInstance, setJellyfinInstance] = useState(instances[0]?.slug ?? "");
  const quickConnect = useQuickConnect({ jellyfinInstance, rememberMe, setLoading, setError, onSignedIn });

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
        <QuickConnectSection
          panel={panel}
          qcCode={quickConnect.qcCode}
          onGenerate={quickConnect.handleQuickConnect}
          onUsePassword={() => { quickConnect.resetQuickConnect(); setJellyfinMode("password"); }}
        />
      ) : (
        <PasswordForm
          panel={panel}
          onSubmit={handleSubmit}
          footer={
            <SecondaryAction onClick={() => { setJellyfinMode("quickconnect"); setError(""); }}>
              {t("auth.login.quickConnect.useInstead")}
            </SecondaryAction>
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

// QuickConnect mode: the Generate button, then the code to type into Jellyfin
// while the poll waits for approval.
function QuickConnectSection({
  panel,
  qcCode,
  onGenerate,
  onUsePassword,
}: {
  panel: PanelState;
  qcCode: string | null;
  onGenerate: () => void;
  onUsePassword: () => void;
}) {
  const t = useT();
  const { rememberMe, setRememberMe, loading, error } = panel;
  return (
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
          onClick={onGenerate}
          disabled={loading}
          className="w-full min-h-11"
        >
          {loading ? <><Loader2 className="w-4 h-4 mr-2 animate-spin" />{t("auth.login.quickConnect.starting")}</> : t("auth.login.quickConnect.generate")}
        </Button>
      )}
      <ErrorText error={error} />
      <SecondaryAction onClick={onUsePassword}>
        {t("auth.login.quickConnect.usePassword")}
      </SecondaryAction>
    </div>
  );
}
