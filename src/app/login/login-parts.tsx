"use client";

// The pieces every login panel shares: the state the form hands each panel,
// and the small controls they are built from.
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Loader2 } from "@/components/icons";
import { useT } from "@/components/i18n/i18n-provider";

// The state every provider panel shares with the form around it.
export interface PanelState {
  error: string;
  setError: (message: string) => void;
  loading: boolean;
  setLoading: (loading: boolean) => void;
  rememberMe: boolean;
  setRememberMe: (remember: boolean) => void;
}

export interface Fields {
  email: string;
  password: string;
  username: string;
}

export const EMPTY_FIELDS: Fields = { email: "", password: "", username: "" };

// A local-credentials or Jellyfin password sign-in. `invalidMessage` is the
// provider's own wording for a plain refusal.
export type PasswordSignIn = (
  provider: "credentials" | "jellyfin",
  payload: Record<string, unknown>,
  invalidMessage: string,
) => Promise<void>;

// The submit-button half every password form shares (local credentials and
// Jellyfin): the fields above it, remember me, Sign in, then the error.
export function PasswordForm({
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
export function ErrorText({ error }: { error: string }) {
  if (!error) return null;
  return <p role="alert" aria-live="assertive" className="text-sm text-red-400">{error}</p>;
}

export function RememberMeCheckbox({
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

export function Field({
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

// The quiet full-width text button under a panel ("Use password instead",
// "Back to sign in", the second-factor method switches).
export function SecondaryAction({ onClick, children }: { onClick: () => void; children: React.ReactNode }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="ds-hover-tint w-full min-h-9 rounded-md text-sm text-zinc-400 hover:text-zinc-200 transition-colors"
    >
      {children}
    </button>
  );
}

export function ProviderTab({
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
