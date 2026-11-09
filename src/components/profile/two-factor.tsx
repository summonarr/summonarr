"use client";

import { useMemo, useState, type ReactNode } from "react";
import { useRouter } from "next/navigation";
import { Loader2, Check, Copy, Download, KeyRound, Plus, ShieldCheck, Smartphone, Trash2, AlertTriangle } from "@/components/icons";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { useHasMounted } from "@/hooks/use-has-mounted";
import { useCopyFeedback } from "@/hooks/use-copy-feedback";
import { withBasePath } from "@/lib/base-path";
import { apiErrorText } from "@/lib/client/api-error";
import { useLocale, useT } from "@/components/i18n/i18n-provider";
import type { Translator } from "@/lib/i18n/translate";
import { formatRelativeTimeLocalized } from "@/lib/relative-time";
import { encodeQr, qrToSvgPath } from "@/lib/qr";
import { createPasskey, isWebAuthnCancel, isWebAuthnSupported } from "@/lib/client/webauthn";
import type { SecondFactorProof } from "@/lib/client/step-up";
import { SecondFactorCodeField } from "./second-factor-code-field";
import { useSecondFactorStepUp } from "./use-second-factor-step-up";
import {
  readCreationOptions,
  readRecoveryCodes,
  readTotpSetup,
  readTwoFactorState,
  type TwoFactorPasskey,
  type TwoFactorState,
} from "./two-factor-data";
import { timedFetch } from "@/lib/client/fetch-json";

export type { TwoFactorPasskey, TwoFactorState };

interface Props {
  initial: TwoFactorState;
  // The admin enrollment policy sent this user here (see src/lib/mfa/policy.ts).
  required: boolean;
}

type ApiResult = { ok: true; data: Record<string, unknown> } | { ok: false; error: string };

type StepUp = { password: string; secondFactor?: SecondFactorProof };

// Reads a refused answer's text. Plain fetch, not fetchJson: a refusal's text
// can come from Retry-After (readSecondFactorRefusal), which fetchJson hides.
type RefusalReader = (res: Response, data: unknown, fallback: string) => string;

async function call(
  t: Translator,
  path: string,
  method: string,
  body?: unknown,
  refusal: RefusalReader = (_res, data, fallback) => apiErrorText(data, fallback),
): Promise<ApiResult> {
  let res: Response;
  try {
    res = await timedFetch(withBasePath(path), {
      method,
      headers: { "Content-Type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  } catch {
    return { ok: false, error: t("auth.login.error.network") };
  }
  const parsed: unknown = await res.json().catch(() => null);
  if (!res.ok) return { ok: false, error: refusal(res, parsed, t("profile.mfa.error.requestFailed", { status: res.status })) };
  const data = parsed && typeof parsed === "object" && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : {};
  return { ok: true, data };
}

// Saves `text` as a file. The anchor is attached while it is clicked and the
// URL outlives the click: some browsers (Safari, older Firefox) start the
// download after click() returns, and a revoked URL there saves nothing.
function downloadText(text: string, filename: string) {
  const blob = new Blob([text], { type: "text/plain" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  a.style.display = "none";
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
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

// A copy button's label and icon; the tick resets (useCopyFeedback).
function CopyButton({ text, ariaLabel, size }: { text: string; ariaLabel?: string; size?: "sm" }) {
  const t = useT();
  const { copied, failed, copy } = useCopyFeedback();
  return (
    <>
      <Button type="button" variant="outline" size={size} aria-label={ariaLabel} onClick={() => void copy(text)}>
        {copied ? <Check className="w-4 h-4 mr-1.5" /> : <Copy className="w-4 h-4 mr-1.5" />}
        {copied ? t("profile.common.copied") : t("profile.common.copy")}
      </Button>
      {/* No clipboard path worked (an insecure page, a denied permission). */}
      {failed && <p role="alert" className="basis-full text-xs text-amber-400">{t("profile.common.copyFailed")}</p>}
    </>
  );
}

function RecoveryCodes({ codes, onDone }: { codes: string[]; onDone: () => void }) {
  const t = useT();
  const text = codes.join("\n");
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
        <CopyButton text={text} />
        <Button
          type="button"
          variant="outline"
          onClick={() => downloadText(`${t("profile.mfa.codes.fileHeader")}\n\n${text}\n`, "summonarr-recovery-codes.txt")}
        >
          <Download className="w-4 h-4 mr-1.5" />{t("profile.common.download")}
        </Button>
        <Button type="button" onClick={onDone}>{t("profile.mfa.codes.saved")}</Button>
      </div>
    </div>
  );
}

// Profile → "Two-factor authentication". Every change re-asks for the current
// password, and once 2FA is on a fresh second factor too (the server enforces
// both — src/lib/mfa/step-up.ts); one password
// field serves every action in the section. It is cleared after each change the
// server accepted, so the next one (planting a new first factor after 2FA was
// turned off, say) is re-asked, not ridden on a password left in the tab.
export function TwoFactorSettings({ initial, required }: Props) {
  const t = useT();
  const router = useRouter();
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
  // Removing a factor confirms first (the push-devices pattern). When it is the
  // account's LAST factor the server also drops the recovery codes and signs out
  // every other device (guardrail 6d), so the copy says so.
  const [confirmingRemove, setConfirmingRemove] = useState<RemoveTarget | null>(null);
  // Once 2FA is on, every change also needs a fresh second factor (the server
  // enforces it — src/lib/mfa/step-up.ts): a code typed here, or a passkey.
  // The shared step-up (use-second-factor-step-up.ts) also shows the field when
  // the server asks for one this page didn't know about (2FA turned on in
  // another tab).
  const stepUpFactor = useSecondFactorStepUp({
    known: {
      enabled: state.enabled,
      hasPasskeys: state.passkeys.length > 0,
      webauthnAvailable: state.webauthnAvailable,
    },
    failedMessage: t("profile.mfa.stepUp.passkeyFailed"),
  });

  async function refresh() {
    const r = await call(t, "/api/profile/mfa", "GET");
    if (r.ok) setState(readTwoFactorState(r.data));
    else setError(r.error);
    router.refresh();
  }

  function needPassword(): boolean {
    if (password.length === 0) {
      setError(t("profile.mfa.error.needPassword"));
      return true;
    }
    return false;
  }

  // The `secondFactor` body field for a change, or null when the user must act
  // first (an error is already shown). An account without 2FA sends nothing.
  // Reading the proof clears the code field: a code is single-use (a recovery
  // code is consumed), so it is never resent.
  async function secondFactorBody(): Promise<{ secondFactor?: SecondFactorProof } | null> {
    if (!stepUpFactor.needsSecondFactor) return {};
    const r = await stepUpFactor.secondFactorProof();
    if ("proof" in r) return { secondFactor: r.proof };
    if (r.error) setError(r.error);
    return null;
  }

  // A request behind the step-up: a refusal is read by the shared reader, which
  // also notes a second factor the server asked for.
  const stepUpCall = (path: string, method: string, body: StepUp & Record<string, unknown>) =>
    call(t, path, method, body, (res, data, fallback) =>
      stepUpFactor.refusalMessage(res, data, body.secondFactor !== undefined, fallback));

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

  // Every change behind the step-up: the password, then (once 2FA is on) a
  // second factor, then the request with `{ password, secondFactor? }`.
  // `precheck` refuses early with a message, before a passkey prompt is shown.
  const stepUpRun = (
    key: string,
    fn: (stepUp: StepUp) => Promise<void>,
    precheck?: () => string | null,
  ) => run(key, async () => {
    if (needPassword()) return;
    const refused = precheck?.();
    if (refused) return setError(refused);
    const sf = await secondFactorBody();
    if (!sf) return;
    await fn({ password, ...sf });
  });

  const startTotp = () => stepUpRun("totp-setup", async (stepUp) => {
    const r = await stepUpCall("/api/profile/mfa/totp/setup", "POST", stepUp);
    if (!r.ok) return setError(r.error);
    setPassword("");
    // A 200 without both (a proxy page, say) must not render "undefined" as
    // the key and its QR code.
    const next = readTotpSetup(r.data);
    if (!next) return setError(t("profile.mfa.error.requestFailed", { status: 200 }));
    setSetup(next);
    setSetupCode("");
  });

  const confirmTotp = () => run("totp-enable", async () => {
    const r = await call(t, "/api/profile/mfa/totp/enable", "POST", { code: setupCode });
    if (!r.ok) return setError(r.error);
    setSetup(null);
    setSetupCode("");
    const issued = readRecoveryCodes(r.data);
    if (issued) setCodes(issued);
    setNotice(t("profile.mfa.notice.totpOn"));
    await refresh();
  });

  const removeTotp = () => stepUpRun("totp-remove", async (stepUp) => {
    const r = await stepUpCall("/api/profile/mfa/totp", "DELETE", stepUp);
    if (!r.ok) return setError(r.error);
    setPassword("");
    setConfirmingRemove(null);
    setNotice(t("profile.mfa.notice.totpRemoved"));
    await refresh();
  });

  const addPasskey = () => stepUpRun("passkey-add", async (stepUp) => {
    const opts = await stepUpCall("/api/profile/mfa/passkeys/options", "POST", stepUp);
    if (!opts.ok) return setError(opts.error);
    // The step-up passed; the registration below doesn't need the password.
    setPassword("");
    const publicKey = readCreationOptions(opts.data);
    if (!publicKey) return setError(t("profile.mfa.error.passkeyCreate"));
    let credential: Record<string, unknown>;
    try {
      credential = await createPasskey(publicKey);
    } catch (err) {
      if (!isWebAuthnCancel(err)) setError(t("profile.mfa.error.passkeyCreate"));
      return;
    }
    const registrationToken = opts.data.registrationToken;
    if (typeof registrationToken !== "string" || !registrationToken) return setError(t("profile.mfa.error.passkeyCreate"));
    const r = await call(t, "/api/profile/mfa/passkeys", "POST", {
      registrationToken,
      name: passkeyName.trim() || t("profile.mfa.passkey.defaultName"),
      credential,
    });
    if (!r.ok) return setError(r.error);
    setPasskeyName("");
    const issued = readRecoveryCodes(r.data);
    if (issued) setCodes(issued);
    setNotice(t("profile.mfa.notice.passkeyAdded"));
    await refresh();
  }, () => (isWebAuthnSupported() ? null : t("auth.mfa.error.passkeyUnsupported")));

  const renamePasskey = (id: string, name: string) => stepUpRun(`rename-${id}`, async (stepUp) => {
    const r = await stepUpCall(`/api/profile/mfa/passkeys/${encodeURIComponent(id)}`, "PATCH", { ...stepUp, name });
    if (!r.ok) return setError(r.error);
    setPassword("");
    setRenaming(null);
    await refresh();
  });

  const removePasskey = (id: string) => stepUpRun(`remove-${id}`, async (stepUp) => {
    const r = await stepUpCall(`/api/profile/mfa/passkeys/${encodeURIComponent(id)}`, "DELETE", stepUp);
    if (!r.ok) return setError(r.error);
    setPassword("");
    setConfirmingRemove(null);
    setNotice(t("profile.mfa.notice.passkeyRemoved"));
    await refresh();
  });

  const regenerateCodes = () => stepUpRun("codes", async (stepUp) => {
    const r = await stepUpCall("/api/profile/mfa/recovery-codes", "POST", stepUp);
    if (!r.ok) return setError(r.error);
    setPassword("");
    // The old codes are already replaced: a 200 without the new ones must say
    // so, not silently show nothing.
    const issued = readRecoveryCodes(r.data);
    if (!issued) {
      setError(t("profile.mfa.error.requestFailed", { status: 200 }));
      return refresh();
    }
    setCodes(issued);
    await refresh();
  });

  const disableAll = () => stepUpRun("disable", async (stepUp) => {
    const r = await stepUpCall("/api/profile/mfa", "DELETE", stepUp);
    if (!r.ok) return setError(r.error);
    setPassword("");
    setConfirmDisable(false);
    setSetup(null);
    setNotice(t("profile.mfa.notice.disabled"));
    await refresh();
  });

  if (codes) return <RecoveryCodes codes={codes} onDone={() => setCodes(null)} />;

  const removeConfirmPanel = (
    <RemoveConfirmPanel
      target={confirmingRemove}
      state={state}
      busy={busy}
      onConfirm={(target) => {
        if (target.kind === "totp") void removeTotp();
        else void removePasskey(target.id);
      }}
      onCancel={() => setConfirmingRemove(null)}
    />
  );

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

      {stepUpFactor.needsSecondFactor && (
        <SecondFactorCodeField
          id="mfa-stepup-code"
          value={stepUpFactor.stepUpCode}
          onChange={stepUpFactor.setStepUpCode}
          passkeyPossible={stepUpFactor.passkeyPossible}
        />
      )}

      {error && <p role="alert" className="text-sm text-red-400">{error}</p>}
      {notice && (
        <p role="status" className="flex items-center gap-1.5 text-sm text-emerald-400">
          <Check className="w-4 h-4" /> {notice}
        </p>
      )}

      <TotpSection
        state={state}
        busy={busy}
        setup={setup}
        setupCode={setupCode}
        onSetupCode={setSetupCode}
        removeConfirm={confirmingRemove?.kind === "totp" ? removeConfirmPanel : null}
        onAskRemove={() => setConfirmingRemove({ kind: "totp" })}
        onStart={startTotp}
        onConfirm={() => void confirmTotp()}
        onCancelSetup={() => setSetup(null)}
      />

      <PasskeySection
        state={state}
        busy={busy}
        confirmingRemove={confirmingRemove}
        removeConfirmPanel={removeConfirmPanel}
        renaming={renaming}
        onRenaming={setRenaming}
        onRename={(id, name) => void renamePasskey(id, name)}
        onAskRemove={(id) => setConfirmingRemove({ kind: "passkey", id })}
        passkeyName={passkeyName}
        onPasskeyName={setPasskeyName}
        onAdd={addPasskey}
      />

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
                variant="destructive"
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
    </div>
  );
}

type RemoveTarget = { kind: "totp" } | { kind: "passkey"; id: string };

function RemoveConfirmPanel({ target, state, busy, onConfirm, onCancel }: {
  target: RemoveTarget | null;
  state: TwoFactorState;
  busy: string | null;
  onConfirm: (target: RemoveTarget) => void;
  onCancel: () => void;
}) {
  const t = useT();
  const factorCount = state.passkeys.length + (state.totpEnabled ? 1 : 0);
  let copy: string;
  if (factorCount === 1) copy = t("profile.mfa.confirmRemoveLast");
  else if (target?.kind === "passkey") {
    const name = state.passkeys.find((p) => p.id === target.id)?.name ?? "";
    copy = t("profile.mfa.confirmRemovePasskey", { name });
  } else copy = t("profile.mfa.confirmRemoveTotp");
  const removing = busy === "totp-remove" || (target?.kind === "passkey" && busy === `remove-${target.id}`);
  return (
    <div className="flex flex-wrap items-center gap-2" role="group">
      <span className="text-sm text-zinc-400 basis-full sm:basis-auto sm:flex-1">{copy}</span>
      <Button
        type="button"
        variant="destructive"
        disabled={busy !== null}
        autoFocus
        onClick={() => {
          if (target) onConfirm(target);
        }}
      >
        {removing ? <Loader2 className="w-4 h-4 animate-spin" /> : t("profile.common.remove")}
      </Button>
      <Button type="button" variant="outline" disabled={busy !== null} onClick={onCancel}>
        {t("profile.common.cancel")}
      </Button>
    </div>
  );
}

// Authenticator app: on (with Remove), the setup (QR, key, code), or Set up.
function TotpSection({ state, busy, setup, setupCode, onSetupCode, removeConfirm, onAskRemove, onStart, onConfirm, onCancelSetup }: {
  state: TwoFactorState;
  busy: string | null;
  setup: { secret: string; otpauthUri: string } | null;
  setupCode: string;
  onSetupCode: (code: string) => void;
  removeConfirm: ReactNode;
  onAskRemove: () => void;
  onStart: () => void;
  onConfirm: () => void;
  onCancelSetup: () => void;
}) {
  const t = useT();
  let content: ReactNode;
  if (state.totpEnabled) {
    content = removeConfirm ?? (
      <div className="flex items-center justify-between gap-3">
        <span className="text-sm text-zinc-400">{t("profile.mfa.totp.on")}</span>
        <Button type="button" variant="outline" disabled={busy !== null} onClick={onAskRemove}>
          {busy === "totp-remove" ? <Loader2 className="w-4 h-4 animate-spin" /> : t("profile.common.remove")}
        </Button>
      </div>
    );
  } else if (setup) {
    content = (
      <div className="space-y-3">
        <p className="text-sm text-zinc-400">
          {t("profile.mfa.totp.scan")}
        </p>
        <div className="flex flex-wrap items-start gap-4">
          <QrImage text={setup.otpauthUri} />
          <div className="min-w-0 flex-1 space-y-2">
            <p className="text-xs text-zinc-500">{t("profile.mfa.totp.manual")}</p>
            <p className="ds-mono break-all text-sm text-zinc-100">{setup.secret.replace(/(.{4})/g, "$1 ").trim()}</p>
            {/* The display adds spaces every 4 chars; copy the raw key. Keyed
                by the key so a new setup starts with the tick off. */}
            <CopyButton key={setup.secret} text={setup.secret} size="sm" ariaLabel={t("profile.mfa.totp.copyKey")} />
            <a href={setup.otpauthUri} className="text-xs underline" style={{ color: "var(--ds-accent-text)" }}>
              {t("profile.mfa.totp.openApp")}
            </a>
          </div>
        </div>
        <form
          className="flex flex-wrap items-end gap-2"
          onSubmit={(e) => { e.preventDefault(); onConfirm(); }}
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
              onChange={(e) => onSetupCode(e.target.value)}
              className="w-32"
            />
          </div>
          <Button type="submit" disabled={busy !== null || setupCode.replace(/\s/g, "").length !== 6}>
            {busy === "totp-enable" ? <Loader2 className="w-4 h-4 animate-spin" /> : t("profile.mfa.turnOn")}
          </Button>
          <Button type="button" variant="outline" onClick={onCancelSetup}>{t("profile.common.cancel")}</Button>
        </form>
      </div>
    );
  } else {
    content = (
      <Button type="button" variant="outline" disabled={busy !== null} onClick={onStart}>
        {busy === "totp-setup" ? <Loader2 className="w-4 h-4 animate-spin mr-1.5" /> : <Plus className="w-4 h-4 mr-1.5" />}
        {t("profile.mfa.totp.setup")}
      </Button>
    );
  }
  return (
    <section className="space-y-2">
      <h3 className="text-sm font-medium text-zinc-100 flex items-center gap-2">
        <Smartphone className="w-4 h-4 text-zinc-400" /> {t("profile.mfa.totp.title")}
      </h3>
      {content}
    </section>
  );
}

function PasskeySection({
  state, busy, confirmingRemove, removeConfirmPanel, renaming, onRenaming, onRename, onAskRemove, passkeyName, onPasskeyName, onAdd,
}: {
  state: TwoFactorState;
  busy: string | null;
  confirmingRemove: RemoveTarget | null;
  removeConfirmPanel: ReactNode;
  renaming: { id: string; name: string } | null;
  onRenaming: (next: { id: string; name: string } | null) => void;
  onRename: (id: string, name: string) => void;
  onAskRemove: (id: string) => void;
  passkeyName: string;
  onPasskeyName: (name: string) => void;
  onAdd: () => void;
}) {
  const t = useT();
  return (
    /* Passkeys */
    <section className="space-y-2">
      <h3 className="text-sm font-medium text-zinc-100 flex items-center gap-2">
        <KeyRound className="w-4 h-4 text-zinc-400" /> {t("profile.mfa.passkey.title")}
      </h3>
      {/* Enrolled passkeys stay listed (rename/remove need no WebAuthn — a code
          confirms them) even when the server can't run WebAuthn any more:
          they still count as factors, so hiding them would hide what the
          account holds. Only adding one needs it. */}
      {state.passkeys.length > 0 && (
        <ul className="space-y-1.5">
          {state.passkeys.map((p) => (
            <li
              key={p.id}
              className="flex items-center justify-between gap-3"
              style={{ padding: "8px 10px", background: "var(--ds-bg-3)", border: "1px solid var(--ds-border)", borderRadius: 8 }}
            >
              {confirmingRemove?.kind === "passkey" && confirmingRemove.id === p.id ? (
                <div className="flex-1 min-w-0">{removeConfirmPanel}</div>
              ) : renaming?.id === p.id ? (
                <form
                  className="flex flex-1 items-center gap-2"
                  onSubmit={(e) => {
                    e.preventDefault();
                    const name = renaming.name.trim();
                    if (name) onRename(p.id, name);
                  }}
                >
                  <Input
                    aria-label={t("profile.mfa.passkey.nameLabel")}
                    value={renaming.name}
                    maxLength={64}
                    onChange={(e) => onRenaming({ id: p.id, name: e.target.value })}
                  />
                  <Button type="submit" disabled={busy !== null || renaming.name.trim() === ""}>{t("profile.common.save")}</Button>
                  <Button type="button" variant="outline" onClick={() => onRenaming(null)}>{t("profile.common.cancel")}</Button>
                </form>
              ) : (
                <PasskeyRow passkey={p} busy={busy} onRename={() => onRenaming({ id: p.id, name: p.name })} onAskRemove={() => onAskRemove(p.id)} />
              )}
            </li>
          ))}
        </ul>
      )}
      {state.webauthnAvailable ? (
        <div className="flex flex-wrap items-end gap-2">
          <div>
            <label className="block text-sm text-zinc-400 mb-1" htmlFor="mfa-passkey-name">{t("profile.mfa.passkey.name")}</label>
            <Input
              id="mfa-passkey-name"
              placeholder={t("profile.mfa.passkey.namePlaceholder")}
              maxLength={64}
              value={passkeyName}
              onChange={(e) => onPasskeyName(e.target.value)}
              className="w-56"
            />
          </div>
          <Button type="button" variant="outline" disabled={busy !== null} onClick={onAdd}>
            {busy === "passkey-add" ? <Loader2 className="w-4 h-4 animate-spin mr-1.5" /> : <Plus className="w-4 h-4 mr-1.5" />}
            {t("profile.mfa.passkey.add")}
          </Button>
        </div>
      ) : (
        <p className="text-sm text-zinc-500">{t("profile.mfa.passkey.unavailable")}</p>
      )}
    </section>
  );
}

function PasskeyRow({ passkey: p, busy, onRename, onAskRemove }: {
  passkey: TwoFactorPasskey;
  busy: string | null;
  onRename: () => void;
  onAskRemove: () => void;
}) {
  const t = useT();
  const locale = useLocale();
  const mounted = useHasMounted();
  let when = "";
  if (mounted) {
    when = p.lastUsedAt
      ? t("profile.mfa.passkey.lastUsed", { time: formatRelativeTimeLocalized(p.lastUsedAt, locale) })
      : t("profile.push.added", { date: new Date(p.createdAt).toLocaleDateString(locale) });
  }
  return (
    <>
      <div className="min-w-0">
        <p className="text-sm text-zinc-100 truncate">{p.name}</p>
        <p className="text-xs text-zinc-500">
          {when}
          {p.backedUp ? ` · ${t("profile.mfa.passkey.synced")}` : ""}
        </p>
      </div>
      <div className="flex shrink-0 items-center gap-1.5">
        <Button type="button" variant="outline" size="sm" disabled={busy !== null} onClick={onRename}>
          {t("profile.mfa.passkey.rename")}
        </Button>
        <Button
          type="button"
          variant="ghost"
          aria-label={t("profile.mfa.passkey.removeNamed", { name: p.name })}
          title={t("profile.common.remove")}
          className="h-9 w-9 px-0 text-zinc-400 hover:text-red-400 hover:bg-red-400/10"
          disabled={busy !== null}
          onClick={onAskRemove}
        >
          {busy === `remove-${p.id}` ? <Loader2 className="w-4 h-4 animate-spin" /> : <Trash2 className="w-4 h-4" />}
        </Button>
      </div>
    </>
  );
}
