"use client";

import { useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { Loader2, Check, Copy, Download, KeyRound, Plus, ShieldCheck, Smartphone, Trash2, AlertTriangle } from "@/components/icons";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { useHasMounted } from "@/hooks/use-has-mounted";
import { withBasePath } from "@/lib/base-path";
import { formatRelativeTime } from "@/lib/relative-time";
import { encodeQr, qrToSvgPath } from "@/lib/qr";
import { createPasskey, isWebAuthnCancel, isWebAuthnSupported, type CreationOptionsJSON } from "@/lib/client/webauthn";

export interface TwoFactorPasskey {
  id: string;
  name: string;
  createdAt: string; // ISO — formatted only after mount (guardrail 16)
  lastUsedAt: string | null;
  backedUp: boolean;
}

export interface TwoFactorState {
  enabled: boolean;
  totpEnabled: boolean;
  passkeys: TwoFactorPasskey[];
  recoveryCodesRemaining: number;
  webauthnAvailable: boolean;
}

interface Props {
  initial: TwoFactorState;
  // The admin enrollment policy sent this user here (see src/lib/mfa/policy.ts).
  required: boolean;
}

type ApiResult = { ok: true; data: Record<string, unknown> } | { ok: false; error: string };

async function call(path: string, method: string, body?: unknown): Promise<ApiResult> {
  try {
    const res = await fetch(withBasePath(path), {
      method,
      headers: { "Content-Type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const data = (await res.json().catch(() => ({}))) as Record<string, unknown>;
    if (!res.ok) return { ok: false, error: typeof data.error === "string" ? data.error : `Request failed (${res.status})` };
    return { ok: true, data };
  } catch {
    return { ok: false, error: "Network error — please try again." };
  }
}

function QrImage({ text }: { text: string }) {
  const { path, viewBox } = useMemo(() => qrToSvgPath(encodeQr(text, "M")), [text]);
  // Black modules on white regardless of theme: scanners need dark-on-light,
  // and this is an image, not a themed surface (guardrail 42 governs surfaces).
  return (
    <svg
      role="img"
      aria-label="QR code for your authenticator app"
      viewBox={viewBox}
      width={184}
      height={184}
      shapeRendering="crispEdges"
      style={{ borderRadius: 8 }}
    >
      <rect width="100%" height="100%" fill="#fff" />
      <path d={path} fill="#000" />
    </svg>
  );
}

function RecoveryCodes({ codes, onDone }: { codes: string[]; onDone: () => void }) {
  const [copied, setCopied] = useState(false);
  const text = codes.join("\n");
  function download() {
    const blob = new Blob([`Summonarr recovery codes\nEach code works once.\n\n${text}\n`], { type: "text/plain" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = "summonarr-recovery-codes.txt";
    a.click();
    URL.revokeObjectURL(url);
  }
  return (
    <div className="space-y-3" role="region" aria-label="Recovery codes">
      <p className="text-sm text-amber-400 flex items-start gap-2">
        <AlertTriangle className="w-4 h-4 shrink-0 mt-0.5" />
        Save these recovery codes somewhere safe. Each one signs you in once if you lose your authenticator or passkey. They won&apos;t be shown again.
      </p>
      <ul
        className="ds-mono grid grid-cols-2 gap-x-6 gap-y-1 text-sm text-zinc-100"
        style={{ padding: 12, background: "var(--ds-bg-3)", border: "1px solid var(--ds-border)", borderRadius: 8 }}
      >
        {codes.map((c) => <li key={c}>{c}</li>)}
      </ul>
      <div className="flex flex-wrap gap-2">
        <Button
          type="button"
          variant="outline"
          onClick={async () => {
            try {
              await navigator.clipboard.writeText(text);
              setCopied(true);
            } catch {
              setCopied(false);
            }
          }}
        >
          {copied ? <Check className="w-4 h-4 mr-1.5" /> : <Copy className="w-4 h-4 mr-1.5" />}
          {copied ? "Copied" : "Copy"}
        </Button>
        <Button type="button" variant="outline" onClick={download}>
          <Download className="w-4 h-4 mr-1.5" />Download
        </Button>
        <Button type="button" onClick={onDone}>I&apos;ve saved them</Button>
      </div>
    </div>
  );
}

// Profile → "Two-factor authentication". Every change re-asks for the current
// password (the server enforces it — src/lib/mfa/step-up.ts); one password
// field serves every action in the section.
export function TwoFactorSettings({ initial, required }: Props) {
  const router = useRouter();
  const mounted = useHasMounted();
  const [state, setState] = useState<TwoFactorState>(initial);
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [setup, setSetup] = useState<{ secret: string; otpauthUri: string } | null>(null);
  const [setupCode, setSetupCode] = useState("");
  const [codes, setCodes] = useState<string[] | null>(null);
  const [passkeyName, setPasskeyName] = useState("");
  const [renaming, setRenaming] = useState<{ id: string; name: string } | null>(null);
  const [confirmDisable, setConfirmDisable] = useState(false);

  async function refresh() {
    const r = await call("/api/profile/mfa", "GET");
    if (r.ok) {
      const d = r.data as unknown as TwoFactorState & { passkeys: TwoFactorPasskey[] };
      setState({
        enabled: !!d.enabled,
        totpEnabled: !!d.totpEnabled,
        passkeys: d.passkeys ?? [],
        recoveryCodesRemaining: Number(d.recoveryCodesRemaining ?? 0),
        webauthnAvailable: !!d.webauthnAvailable,
      });
    }
    router.refresh();
  }

  function needPassword(): boolean {
    if (password.length === 0) {
      setError("Enter your current password first.");
      return true;
    }
    return false;
  }

  async function run(key: string, fn: () => Promise<void>) {
    setBusy(key);
    setError(null);
    setNotice(null);
    try {
      await fn();
    } finally {
      setBusy(null);
    }
  }

  const startTotp = () => run("totp-setup", async () => {
    if (needPassword()) return;
    const r = await call("/api/profile/mfa/totp/setup", "POST", { password });
    if (!r.ok) return setError(r.error);
    setSetup({ secret: String(r.data.secret), otpauthUri: String(r.data.otpauthUri) });
    setSetupCode("");
  });

  const confirmTotp = () => run("totp-enable", async () => {
    const r = await call("/api/profile/mfa/totp/enable", "POST", { code: setupCode });
    if (!r.ok) return setError(r.error);
    setSetup(null);
    setSetupCode("");
    if (Array.isArray(r.data.recoveryCodes)) setCodes(r.data.recoveryCodes as string[]);
    setNotice("Authenticator app turned on.");
    await refresh();
  });

  const removeTotp = () => run("totp-remove", async () => {
    if (needPassword()) return;
    const r = await call("/api/profile/mfa/totp", "DELETE", { password });
    if (!r.ok) return setError(r.error);
    setNotice("Authenticator app removed.");
    await refresh();
  });

  const addPasskey = () => run("passkey-add", async () => {
    if (needPassword()) return;
    if (!isWebAuthnSupported()) return setError("This browser doesn't support passkeys.");
    const opts = await call("/api/profile/mfa/passkeys/options", "POST", { password });
    if (!opts.ok) return setError(opts.error);
    let credential: Record<string, unknown>;
    try {
      credential = await createPasskey(opts.data.publicKey as CreationOptionsJSON);
    } catch (err) {
      if (!isWebAuthnCancel(err)) setError("The passkey couldn't be created on this device.");
      return;
    }
    const r = await call("/api/profile/mfa/passkeys", "POST", {
      registrationToken: opts.data.registrationToken,
      name: passkeyName.trim() || "Passkey",
      credential,
    });
    if (!r.ok) return setError(r.error);
    setPasskeyName("");
    if (Array.isArray(r.data.recoveryCodes)) setCodes(r.data.recoveryCodes as string[]);
    setNotice("Passkey added.");
    await refresh();
  });

  const renamePasskey = (id: string, name: string) => run(`rename-${id}`, async () => {
    if (needPassword()) return;
    const r = await call(`/api/profile/mfa/passkeys/${encodeURIComponent(id)}`, "PATCH", { password, name });
    if (!r.ok) return setError(r.error);
    setRenaming(null);
    await refresh();
  });

  const removePasskey = (id: string) => run(`remove-${id}`, async () => {
    if (needPassword()) return;
    const r = await call(`/api/profile/mfa/passkeys/${encodeURIComponent(id)}`, "DELETE", { password });
    if (!r.ok) return setError(r.error);
    setNotice("Passkey removed.");
    await refresh();
  });

  const regenerateCodes = () => run("codes", async () => {
    if (needPassword()) return;
    const r = await call("/api/profile/mfa/recovery-codes", "POST", { password });
    if (!r.ok) return setError(r.error);
    setCodes(r.data.recoveryCodes as string[]);
    await refresh();
  });

  const disableAll = () => run("disable", async () => {
    if (needPassword()) return;
    const r = await call("/api/profile/mfa", "DELETE", { password });
    if (!r.ok) return setError(r.error);
    setConfirmDisable(false);
    setSetup(null);
    setNotice("Two-factor authentication turned off.");
    await refresh();
  });

  if (codes) return <RecoveryCodes codes={codes} onDone={() => setCodes(null)} />;

  return (
    <div className="space-y-5">
      {required && !state.enabled && (
        <p role="alert" className="text-sm text-amber-400 flex items-start gap-2">
          <AlertTriangle className="w-4 h-4 shrink-0 mt-0.5" />
          Your administrator requires two-factor authentication for admin accounts. Set it up below to use the admin pages.
        </p>
      )}

      <p className="text-sm flex items-center gap-2" style={{ color: state.enabled ? "var(--ds-success)" : "var(--ds-fg-muted)" }}>
        <ShieldCheck className="w-4 h-4 shrink-0" />
        {state.enabled ? "Two-factor authentication is on." : "Two-factor authentication is off — your password alone signs you in."}
      </p>

      <div>
        <label className="block text-sm text-zinc-400 mb-1" htmlFor="mfa-password">
          Current password <span className="text-zinc-500">(needed for any change)</span>
        </label>
        <Input
          id="mfa-password"
          type="password"
          autoComplete="current-password"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
        />
      </div>

      {/* Authenticator app */}
      <section className="space-y-2">
        <h3 className="text-sm font-medium text-zinc-100 flex items-center gap-2">
          <Smartphone className="w-4 h-4 text-zinc-400" /> Authenticator app
        </h3>
        {state.totpEnabled ? (
          <div className="flex items-center justify-between gap-3">
            <span className="text-sm text-zinc-400">On — enter a 6-digit code when you sign in.</span>
            <Button type="button" variant="outline" disabled={busy !== null} onClick={removeTotp}>
              {busy === "totp-remove" ? <Loader2 className="w-4 h-4 animate-spin" /> : "Remove"}
            </Button>
          </div>
        ) : setup ? (
          <div className="space-y-3">
            <p className="text-sm text-zinc-400">
              Scan this code with an authenticator app (1Password, Google Authenticator, Aegis, …), then enter the 6-digit code it shows.
            </p>
            <div className="flex flex-wrap items-start gap-4">
              <QrImage text={setup.otpauthUri} />
              <div className="min-w-0 flex-1 space-y-2">
                <p className="text-xs text-zinc-500">Can&apos;t scan? Enter this key manually:</p>
                <p className="ds-mono break-all text-sm text-zinc-100">{setup.secret.replace(/(.{4})/g, "$1 ").trim()}</p>
                <a href={setup.otpauthUri} className="text-xs underline" style={{ color: "var(--ds-accent-text)" }}>
                  Open in an authenticator app on this device
                </a>
              </div>
            </div>
            <form
              className="flex flex-wrap items-end gap-2"
              onSubmit={(e) => { e.preventDefault(); void confirmTotp(); }}
            >
              <div>
                <label className="block text-sm text-zinc-400 mb-1" htmlFor="mfa-setup-code">Code</label>
                <Input
                  id="mfa-setup-code"
                  inputMode="numeric"
                  autoComplete="one-time-code"
                  pattern="[0-9 ]*"
                  maxLength={7}
                  value={setupCode}
                  onChange={(e) => setSetupCode(e.target.value)}
                  className="w-32"
                />
              </div>
              <Button type="submit" disabled={busy !== null || setupCode.replace(/\s/g, "").length !== 6}>
                {busy === "totp-enable" ? <Loader2 className="w-4 h-4 animate-spin" /> : "Turn on"}
              </Button>
              <Button type="button" variant="outline" onClick={() => setSetup(null)}>Cancel</Button>
            </form>
          </div>
        ) : (
          <Button type="button" variant="outline" disabled={busy !== null} onClick={startTotp}>
            {busy === "totp-setup" ? <Loader2 className="w-4 h-4 animate-spin mr-1.5" /> : <Plus className="w-4 h-4 mr-1.5" />}
            Set up authenticator app
          </Button>
        )}
      </section>

      {/* Passkeys */}
      <section className="space-y-2">
        <h3 className="text-sm font-medium text-zinc-100 flex items-center gap-2">
          <KeyRound className="w-4 h-4 text-zinc-400" /> Passkeys &amp; security keys
        </h3>
        {!state.webauthnAvailable ? (
          <p className="text-sm text-zinc-500">Passkeys are unavailable until the server&apos;s AUTH_URL is set to its public address.</p>
        ) : (
          <>
            {state.passkeys.length > 0 && (
              <ul className="space-y-1.5">
                {state.passkeys.map((p) => (
                  <li
                    key={p.id}
                    className="flex items-center justify-between gap-3"
                    style={{ padding: "8px 10px", background: "var(--ds-bg-3)", border: "1px solid var(--ds-border)", borderRadius: 8 }}
                  >
                    {renaming?.id === p.id ? (
                      <form
                        className="flex flex-1 items-center gap-2"
                        onSubmit={(e) => { e.preventDefault(); void renamePasskey(p.id, renaming.name); }}
                      >
                        <Input
                          aria-label="Passkey name"
                          value={renaming.name}
                          maxLength={64}
                          onChange={(e) => setRenaming({ id: p.id, name: e.target.value })}
                        />
                        <Button type="submit" disabled={busy !== null}>Save</Button>
                        <Button type="button" variant="outline" onClick={() => setRenaming(null)}>Cancel</Button>
                      </form>
                    ) : (
                      <>
                        <div className="min-w-0">
                          <p className="text-sm text-zinc-100 truncate">{p.name}</p>
                          <p className="text-xs text-zinc-500">
                            {mounted
                              ? p.lastUsedAt
                                ? `Last used ${formatRelativeTime(new Date(p.lastUsedAt))}`
                                : `Added ${new Date(p.createdAt).toLocaleDateString()}`
                              : ""}
                            {p.backedUp ? " · synced" : ""}
                          </p>
                        </div>
                        <div className="flex shrink-0 gap-1.5">
                          <Button type="button" variant="outline" size="sm" disabled={busy !== null} onClick={() => setRenaming({ id: p.id, name: p.name })}>
                            Rename
                          </Button>
                          <Button
                            type="button"
                            variant="outline"
                            size="sm"
                            aria-label={`Remove passkey ${p.name}`}
                            disabled={busy !== null}
                            onClick={() => removePasskey(p.id)}
                          >
                            {busy === `remove-${p.id}` ? <Loader2 className="w-4 h-4 animate-spin" /> : <Trash2 className="w-4 h-4" />}
                          </Button>
                        </div>
                      </>
                    )}
                  </li>
                ))}
              </ul>
            )}
            <div className="flex flex-wrap items-end gap-2">
              <div>
                <label className="block text-sm text-zinc-400 mb-1" htmlFor="mfa-passkey-name">Name</label>
                <Input
                  id="mfa-passkey-name"
                  placeholder="e.g. YubiKey, MacBook"
                  maxLength={64}
                  value={passkeyName}
                  onChange={(e) => setPasskeyName(e.target.value)}
                  className="w-56"
                />
              </div>
              <Button type="button" variant="outline" disabled={busy !== null} onClick={addPasskey}>
                {busy === "passkey-add" ? <Loader2 className="w-4 h-4 animate-spin mr-1.5" /> : <Plus className="w-4 h-4 mr-1.5" />}
                Add passkey
              </Button>
            </div>
          </>
        )}
      </section>

      {state.enabled && (
        <section className="space-y-2">
          <h3 className="text-sm font-medium text-zinc-100">Recovery codes</h3>
          <div className="flex items-center justify-between gap-3">
            <span className="text-sm text-zinc-400">
              {state.recoveryCodesRemaining} unused code{state.recoveryCodesRemaining === 1 ? "" : "s"} left.
            </span>
            <Button type="button" variant="outline" disabled={busy !== null} onClick={regenerateCodes}>
              {busy === "codes" ? <Loader2 className="w-4 h-4 animate-spin" /> : "Generate new codes"}
            </Button>
          </div>
        </section>
      )}

      {state.enabled && (
        <section className="pt-2" style={{ borderTop: "1px solid var(--ds-border)" }}>
          {confirmDisable ? (
            <div className="flex flex-wrap items-center gap-2">
              <span className="text-sm text-zinc-400">Remove every second factor and recovery code?</span>
              <Button
                type="button"
                className="bg-red-600 text-[var(--ds-on-status)] hover:bg-[var(--ds-danger-hover)]"
                disabled={busy !== null}
                onClick={disableAll}
              >
                {busy === "disable" ? <Loader2 className="w-4 h-4 animate-spin" /> : "Turn off"}
              </Button>
              <Button type="button" variant="outline" onClick={() => setConfirmDisable(false)}>Cancel</Button>
            </div>
          ) : (
            <Button type="button" variant="outline" onClick={() => setConfirmDisable(true)}>
              Turn off two-factor authentication
            </Button>
          )}
        </section>
      )}

      {error && <p role="alert" className="text-sm text-red-400">{error}</p>}
      {notice && (
        <p className="flex items-center gap-1.5 text-sm text-emerald-400">
          <Check className="w-4 h-4" /> {notice}
        </p>
      )}
    </div>
  );
}
