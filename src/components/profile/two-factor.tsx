"use client";

import { useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { Loader2, Check, Copy, Download, KeyRound, Plus, ShieldCheck, Smartphone, Trash2, AlertTriangle } from "@/components/icons";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { useHasMounted } from "@/hooks/use-has-mounted";
import { withBasePath } from "@/lib/base-path";
import { useLocale, useT } from "@/components/i18n/i18n-provider";
import type { Translator } from "@/lib/i18n/translate";
import { translatedRelativeTime } from "./relative-time";
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

async function call(t: Translator, path: string, method: string, body?: unknown): Promise<ApiResult> {
  try {
    const res = await fetch(withBasePath(path), {
      method,
      headers: { "Content-Type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const data = (await res.json().catch(() => ({}))) as Record<string, unknown>;
    if (!res.ok) return { ok: false, error: typeof data.error === "string" ? data.error : t("profile.mfa.error.requestFailed", { status: res.status }) };
    return { ok: true, data };
  } catch {
    return { ok: false, error: t("auth.login.error.network") };
  }
}

function QrImage({ text }: { text: string }) {
  const t = useT();
  const { path, viewBox } = useMemo(() => qrToSvgPath(encodeQr(text, "M")), [text]);
  // Black modules on white regardless of theme: scanners need dark-on-light,
  // and this is an image, not a themed surface (guardrail 42 governs surfaces).
  return (
    <svg
      role="img"
      aria-label={t("profile.mfa.qrLabel")}
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
  const t = useT();
  const [copied, setCopied] = useState(false);
  const text = codes.join("\n");
  function download() {
    const blob = new Blob([`${t("profile.mfa.codes.fileHeader")}\n\n${text}\n`], { type: "text/plain" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = "summonarr-recovery-codes.txt";
    a.click();
    URL.revokeObjectURL(url);
  }
  return (
    <div className="space-y-3" role="region" aria-label={t("auth.mfa.recoveryCodes")}>
      <p className="text-sm text-amber-400 flex items-start gap-2">
        <AlertTriangle className="w-4 h-4 shrink-0 mt-0.5" />
        {t("profile.mfa.codes.saveWarning")}
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
          {copied ? t("profile.common.copied") : t("profile.common.copy")}
        </Button>
        <Button type="button" variant="outline" onClick={download}>
          <Download className="w-4 h-4 mr-1.5" />{t("profile.common.download")}
        </Button>
        <Button type="button" onClick={onDone}>{t("profile.mfa.codes.saved")}</Button>
      </div>
    </div>
  );
}

// Profile → "Two-factor authentication". Every change re-asks for the current
// password (the server enforces it — src/lib/mfa/step-up.ts); one password
// field serves every action in the section.
export function TwoFactorSettings({ initial, required }: Props) {
  const t = useT();
  const locale = useLocale();
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
    const r = await call(t, "/api/profile/mfa", "GET");
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
      setError(t("profile.mfa.error.needPassword"));
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
    const r = await call(t, "/api/profile/mfa/totp/setup", "POST", { password });
    if (!r.ok) return setError(r.error);
    setSetup({ secret: String(r.data.secret), otpauthUri: String(r.data.otpauthUri) });
    setSetupCode("");
  });

  const confirmTotp = () => run("totp-enable", async () => {
    const r = await call(t, "/api/profile/mfa/totp/enable", "POST", { code: setupCode });
    if (!r.ok) return setError(r.error);
    setSetup(null);
    setSetupCode("");
    if (Array.isArray(r.data.recoveryCodes)) setCodes(r.data.recoveryCodes as string[]);
    setNotice(t("profile.mfa.notice.totpOn"));
    await refresh();
  });

  const removeTotp = () => run("totp-remove", async () => {
    if (needPassword()) return;
    const r = await call(t, "/api/profile/mfa/totp", "DELETE", { password });
    if (!r.ok) return setError(r.error);
    setNotice(t("profile.mfa.notice.totpRemoved"));
    await refresh();
  });

  const addPasskey = () => run("passkey-add", async () => {
    if (needPassword()) return;
    if (!isWebAuthnSupported()) return setError(t("auth.mfa.error.passkeyUnsupported"));
    const opts = await call(t, "/api/profile/mfa/passkeys/options", "POST", { password });
    if (!opts.ok) return setError(opts.error);
    let credential: Record<string, unknown>;
    try {
      credential = await createPasskey(opts.data.publicKey as CreationOptionsJSON);
    } catch (err) {
      if (!isWebAuthnCancel(err)) setError(t("profile.mfa.error.passkeyCreate"));
      return;
    }
    const r = await call(t, "/api/profile/mfa/passkeys", "POST", {
      registrationToken: opts.data.registrationToken,
      name: passkeyName.trim() || t("profile.mfa.passkey.defaultName"),
      credential,
    });
    if (!r.ok) return setError(r.error);
    setPasskeyName("");
    if (Array.isArray(r.data.recoveryCodes)) setCodes(r.data.recoveryCodes as string[]);
    setNotice(t("profile.mfa.notice.passkeyAdded"));
    await refresh();
  });

  const renamePasskey = (id: string, name: string) => run(`rename-${id}`, async () => {
    if (needPassword()) return;
    const r = await call(t, `/api/profile/mfa/passkeys/${encodeURIComponent(id)}`, "PATCH", { password, name });
    if (!r.ok) return setError(r.error);
    setRenaming(null);
    await refresh();
  });

  const removePasskey = (id: string) => run(`remove-${id}`, async () => {
    if (needPassword()) return;
    const r = await call(t, `/api/profile/mfa/passkeys/${encodeURIComponent(id)}`, "DELETE", { password });
    if (!r.ok) return setError(r.error);
    setNotice(t("profile.mfa.notice.passkeyRemoved"));
    await refresh();
  });

  const regenerateCodes = () => run("codes", async () => {
    if (needPassword()) return;
    const r = await call(t, "/api/profile/mfa/recovery-codes", "POST", { password });
    if (!r.ok) return setError(r.error);
    setCodes(r.data.recoveryCodes as string[]);
    await refresh();
  });

  const disableAll = () => run("disable", async () => {
    if (needPassword()) return;
    const r = await call(t, "/api/profile/mfa", "DELETE", { password });
    if (!r.ok) return setError(r.error);
    setConfirmDisable(false);
    setSetup(null);
    setNotice(t("profile.mfa.notice.disabled"));
    await refresh();
  });

  if (codes) return <RecoveryCodes codes={codes} onDone={() => setCodes(null)} />;

  return (
    <div className="space-y-5">
      {required && !state.enabled && (
        <p role="alert" className="text-sm text-amber-400 flex items-start gap-2">
          <AlertTriangle className="w-4 h-4 shrink-0 mt-0.5" />
          {t("profile.mfa.requiredByAdmin")}
        </p>
      )}

      <p className="text-sm flex items-center gap-2" style={{ color: state.enabled ? "var(--ds-success)" : "var(--ds-fg-muted)" }}>
        <ShieldCheck className="w-4 h-4 shrink-0" />
        {state.enabled ? t("profile.mfa.statusOn") : t("profile.mfa.statusOff")}
      </p>

      <div>
        <label className="block text-sm text-zinc-400 mb-1" htmlFor="mfa-password">
          {t("profile.password.current")} <span className="text-zinc-500">{t("profile.mfa.passwordNeeded")}</span>
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
          <Smartphone className="w-4 h-4 text-zinc-400" /> {t("profile.mfa.totp.title")}
        </h3>
        {state.totpEnabled ? (
          <div className="flex items-center justify-between gap-3">
            <span className="text-sm text-zinc-400">{t("profile.mfa.totp.on")}</span>
            <Button type="button" variant="outline" disabled={busy !== null} onClick={removeTotp}>
              {busy === "totp-remove" ? <Loader2 className="w-4 h-4 animate-spin" /> : t("profile.common.remove")}
            </Button>
          </div>
        ) : setup ? (
          <div className="space-y-3">
            <p className="text-sm text-zinc-400">
              {t("profile.mfa.totp.scan")}
            </p>
            <div className="flex flex-wrap items-start gap-4">
              <QrImage text={setup.otpauthUri} />
              <div className="min-w-0 flex-1 space-y-2">
                <p className="text-xs text-zinc-500">{t("profile.mfa.totp.manual")}</p>
                <p className="ds-mono break-all text-sm text-zinc-100">{setup.secret.replace(/(.{4})/g, "$1 ").trim()}</p>
                <a href={setup.otpauthUri} className="text-xs underline" style={{ color: "var(--ds-accent-text)" }}>
                  {t("profile.mfa.totp.openApp")}
                </a>
              </div>
            </div>
            <form
              className="flex flex-wrap items-end gap-2"
              onSubmit={(e) => { e.preventDefault(); void confirmTotp(); }}
            >
              <div>
                <label className="block text-sm text-zinc-400 mb-1" htmlFor="mfa-setup-code">{t("profile.mfa.totp.code")}</label>
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
                {busy === "totp-enable" ? <Loader2 className="w-4 h-4 animate-spin" /> : t("profile.mfa.turnOn")}
              </Button>
              <Button type="button" variant="outline" onClick={() => setSetup(null)}>{t("profile.common.cancel")}</Button>
            </form>
          </div>
        ) : (
          <Button type="button" variant="outline" disabled={busy !== null} onClick={startTotp}>
            {busy === "totp-setup" ? <Loader2 className="w-4 h-4 animate-spin mr-1.5" /> : <Plus className="w-4 h-4 mr-1.5" />}
            {t("profile.mfa.totp.setup")}
          </Button>
        )}
      </section>

      {/* Passkeys */}
      <section className="space-y-2">
        <h3 className="text-sm font-medium text-zinc-100 flex items-center gap-2">
          <KeyRound className="w-4 h-4 text-zinc-400" /> {t("profile.mfa.passkey.title")}
        </h3>
        {!state.webauthnAvailable ? (
          <p className="text-sm text-zinc-500">{t("profile.mfa.passkey.unavailable")}</p>
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
                          aria-label={t("profile.mfa.passkey.nameLabel")}
                          value={renaming.name}
                          maxLength={64}
                          onChange={(e) => setRenaming({ id: p.id, name: e.target.value })}
                        />
                        <Button type="submit" disabled={busy !== null}>{t("profile.common.save")}</Button>
                        <Button type="button" variant="outline" onClick={() => setRenaming(null)}>{t("profile.common.cancel")}</Button>
                      </form>
                    ) : (
                      <>
                        <div className="min-w-0">
                          <p className="text-sm text-zinc-100 truncate">{p.name}</p>
                          <p className="text-xs text-zinc-500">
                            {mounted
                              ? p.lastUsedAt
                                ? t("profile.mfa.passkey.lastUsed", { time: translatedRelativeTime(p.lastUsedAt, t) })
                                : t("profile.push.added", { date: new Date(p.createdAt).toLocaleDateString(locale) })
                              : ""}
                            {p.backedUp ? ` · ${t("profile.mfa.passkey.synced")}` : ""}
                          </p>
                        </div>
                        <div className="flex shrink-0 gap-1.5">
                          <Button type="button" variant="outline" size="sm" disabled={busy !== null} onClick={() => setRenaming({ id: p.id, name: p.name })}>
                            {t("profile.mfa.passkey.rename")}
                          </Button>
                          <Button
                            type="button"
                            variant="outline"
                            size="sm"
                            aria-label={t("profile.mfa.passkey.removeNamed", { name: p.name })}
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
                <label className="block text-sm text-zinc-400 mb-1" htmlFor="mfa-passkey-name">{t("profile.mfa.passkey.name")}</label>
                <Input
                  id="mfa-passkey-name"
                  placeholder={t("profile.mfa.passkey.namePlaceholder")}
                  maxLength={64}
                  value={passkeyName}
                  onChange={(e) => setPasskeyName(e.target.value)}
                  className="w-56"
                />
              </div>
              <Button type="button" variant="outline" disabled={busy !== null} onClick={addPasskey}>
                {busy === "passkey-add" ? <Loader2 className="w-4 h-4 animate-spin mr-1.5" /> : <Plus className="w-4 h-4 mr-1.5" />}
                {t("profile.mfa.passkey.add")}
              </Button>
            </div>
          </>
        )}
      </section>

      {state.enabled && (
        <section className="space-y-2">
          <h3 className="text-sm font-medium text-zinc-100">{t("auth.mfa.recoveryCodes")}</h3>
          <div className="flex items-center justify-between gap-3">
            <span className="text-sm text-zinc-400">
              {t("profile.mfa.codes.remaining", { count: state.recoveryCodesRemaining })}
            </span>
            <Button type="button" variant="outline" disabled={busy !== null} onClick={regenerateCodes}>
              {busy === "codes" ? <Loader2 className="w-4 h-4 animate-spin" /> : t("profile.mfa.codes.regenerate")}
            </Button>
          </div>
        </section>
      )}

      {state.enabled && (
        <section className="pt-2" style={{ borderTop: "1px solid var(--ds-border)" }}>
          {confirmDisable ? (
            <div className="flex flex-wrap items-center gap-2">
              <span className="text-sm text-zinc-400">{t("profile.mfa.confirmDisable")}</span>
              <Button
                type="button"
                className="bg-red-600 text-[var(--ds-on-status)] hover:bg-[var(--ds-danger-hover)]"
                disabled={busy !== null}
                onClick={disableAll}
              >
                {busy === "disable" ? <Loader2 className="w-4 h-4 animate-spin" /> : t("profile.calendar.turnOff")}
              </Button>
              <Button type="button" variant="outline" onClick={() => setConfirmDisable(false)}>{t("profile.common.cancel")}</Button>
            </div>
          ) : (
            <Button type="button" variant="outline" onClick={() => setConfirmDisable(true)}>
              {t("profile.mfa.disable")}
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
