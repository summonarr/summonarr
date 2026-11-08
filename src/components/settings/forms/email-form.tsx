"use client";

import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { AlertTriangle, Loader2 } from "@/components/icons";
import { SaveStatusMessage } from "./save-status";
import { useSettingsSave } from "./shared";
import { useT } from "@/components/i18n/i18n-provider";
import { SECRET_MASK_SENTINEL } from "@/lib/secret-mask";
import { rich } from "./rich";
import { emailSaveBody, ignoredKeys } from "./email-form-body";

interface EmailFormProps {
  initialBackend: "smtp" | "resend";
  initialHost: string;
  initialPort: string;
  initialUser: string;
  // The settings page passes the mask when a secret is saved, "" when none is.
  initialPassword: string;
  initialFrom: string;
  initialResendApiKey: string;
  initialResendFrom: string;
}

// The field labels for the keys the route can answer `ignored` with.
const FIELD_LABEL_KEYS: Record<string, string> = {
  smtpHost: "settings.form.email.smtpHost",
  smtpPort: "settings.form.email.port",
  smtpUser: "settings.form.email.username",
  smtpPassword: "settings.form.email.password",
  smtpFrom: "settings.form.email.fromAddress",
  resendApiKey: "settings.form.email.resendKey",
  resendFrom: "settings.form.email.fromAddress",
};

export function EmailForm({
  initialBackend,
  initialHost,
  initialPort,
  initialUser,
  initialPassword,
  initialFrom,
  initialResendApiKey,
  initialResendFrom,
}: EmailFormProps) {
  const t = useT();
  const [backend,      setBackend]      = useState<"smtp" | "resend">(initialBackend);
  const [host,         setHost]         = useState(initialHost);
  const [port,         setPort]         = useState(initialPort || "587");
  const [user,         setUser]         = useState(initialUser);
  const [password,     setPassword]     = useState("");
  const [from,         setFrom]         = useState(initialFrom);
  const [resendApiKey, setResendApiKey] = useState("");
  const [resendFrom,   setResendFrom]   = useState(initialResendFrom);
  const [passwordSaved, setPasswordSaved] = useState(initialPassword.length > 0);
  const [resendKeySaved, setResendKeySaved] = useState(initialResendApiKey.length > 0);
  // Only the "Saved" line fades; an error stays until the next edit or save,
  // and an edit while Save & Test runs keeps Save locked, so a second click
  // can't send a second test email (useSettingsSave).
  const { status, message, save, edited } = useSettingsSave();
  const [okText, setOkText] = useState("");
  const [ignored, setIgnored] = useState<string[]>([]);

  async function handleSave(e: React.FormEvent) {
    e.preventDefault();
    setIgnored([]);
    const body = emailSaveBody({ backend, host, port, user, password, from, resendApiKey, resendFrom });
    const result = await save(body, (r) => {
      const reason = r.data.smtpError;
      return typeof reason === "string" && reason ? reason : t("settings.form.common.saveFailed");
    });
    if (!result.ok) return;
    setOkText(result.data.smtpTested === true ? t("settings.form.email.savedTested") : t("settings.form.common.saved"));
    setIgnored(ignoredKeys(result.data));
    if (body.smtpPassword) { setPasswordSaved(true); setPassword(""); }
    if (body.resendApiKey) { setResendKeySaved(true); setResendApiKey(""); }
  }

  // Every field edit: clears the last result, never a save in flight.
  function change<T>(set: (value: T) => void) {
    return (value: T) => {
      set(value);
      setIgnored([]);
      edited();
    };
  }

  // The route refuses a port outside 1–65535 and can't store a blank one
  // (email.ts would read it as invalid), so the form doesn't send either.
  const portValid = /^\d+$/.test(port) && Number(port) >= 1 && Number(port) <= 65535;
  const canSubmit = backend === "smtp" ? Boolean(host) && portValid : Boolean(resendApiKey) || resendKeySaved;
  const ignoredText = ignored.map((k) => (FIELD_LABEL_KEYS[k] ? t(FIELD_LABEL_KEYS[k]) : k)).join(", ");

  return (
    <form onSubmit={handleSave} className="space-y-4">
      <div className="space-y-1.5">
        <Label id="email-backend-label">{t("settings.form.email.backend")}</Label>
        <div role="group" aria-labelledby="email-backend-label" className="inline-flex rounded-lg border border-zinc-700 bg-zinc-800 p-1 text-sm">
          {(["smtp", "resend"] as const).map((b) => (
            <button
              key={b}
              type="button"
              aria-pressed={backend === b}
              onClick={() => change(setBackend)(b)}
              className={
                "px-3 py-1.5 rounded-md transition-colors " +
                (backend === b
                  ? "bg-[var(--ds-accent)] text-[var(--ds-accent-fg)]"
                  : "text-zinc-400 hover:text-zinc-200")
              }
            >
              {b === "smtp" ? "SMTP" : "Resend"}
            </button>
          ))}
        </div>
      </div>

      {backend === "smtp" ? (
        <>
          <div className="grid grid-cols-[1fr_100px] gap-3">
            <div className="space-y-1.5">
              <Label htmlFor="smtp-host">{t("settings.form.email.smtpHost")}</Label>
              <Input
                id="smtp-host"
                value={host}
                onChange={(e) => change(setHost)(e.target.value)}
                placeholder="smtp.example.com"
                className="bg-zinc-800 border-zinc-700 font-mono"
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="smtp-port">{t("settings.form.email.port")}</Label>
              <Input
                id="smtp-port"
                type="number"
                inputMode="numeric"
                min={1}
                max={65535}
                value={port}
                onChange={(e) => change(setPort)(e.target.value)}
                placeholder="587"
                className="bg-zinc-800 border-zinc-700 font-mono"
              />
            </div>
          </div>
          <div className="lg:grid lg:grid-cols-2 lg:gap-4 space-y-4 lg:space-y-0">
            <div className="space-y-1.5">
              <Label htmlFor="smtp-user">{t("settings.form.email.username")}</Label>
              <Input
                id="smtp-user"
                value={user}
                onChange={(e) => change(setUser)(e.target.value)}
                placeholder="user@example.com"
                className="bg-zinc-800 border-zinc-700"
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="smtp-password">{t("settings.form.email.password")}</Label>
              <Input
                id="smtp-password"
                type="password"
                autoComplete="new-password"
                data-1p-ignore
                data-lpignore="true"
                value={password}
                onChange={(e) => change(setPassword)(e.target.value)}
                placeholder={passwordSaved ? SECRET_MASK_SENTINEL : "••••••••••••••••"}
                className="bg-zinc-800 border-zinc-700 font-mono"
              />
              {passwordSaved && !password && (
                <p className="text-xs text-zinc-500">{t("settings.form.agents.secretKeep")}</p>
              )}
            </div>
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="smtp-from">{t("settings.form.email.fromAddress")}</Label>
            <Input
              id="smtp-from"
              value={from}
              onChange={(e) => change(setFrom)(e.target.value)}
              placeholder="Summonarr <noreply@example.com>"
              className="bg-zinc-800 border-zinc-700"
            />
            <p className="text-xs text-zinc-500">{t("settings.form.email.fromHelp")}</p>
          </div>
        </>
      ) : (
        <>
          <div className="space-y-1.5">
            <Label htmlFor="resend-api-key">{t("settings.form.email.resendKey")}</Label>
            <Input
              id="resend-api-key"
              type="password"
              autoComplete="new-password"
              data-1p-ignore
              data-lpignore="true"
              value={resendApiKey}
              onChange={(e) => change(setResendApiKey)(e.target.value)}
              placeholder={resendKeySaved ? SECRET_MASK_SENTINEL : "re_••••••••••••••••"}
              className="bg-zinc-800 border-zinc-700 font-mono"
            />
            {resendKeySaved && !resendApiKey && (
              <p className="text-xs text-zinc-500">{t("settings.form.agents.secretKeep")}</p>
            )}
            <p className="text-xs text-zinc-500">
              {rich(t("settings.form.email.resendKeyHelp"), {
                link: (
                  <a href="https://resend.com/api-keys" target="_blank" rel="noreferrer" className="text-indigo-400 hover:underline">
                    resend.com/api-keys
                  </a>
                ),
              })}
            </p>
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="resend-from">{t("settings.form.email.fromAddress")}</Label>
            <Input
              id="resend-from"
              value={resendFrom}
              onChange={(e) => change(setResendFrom)(e.target.value)}
              placeholder="Summonarr <noreply@yourdomain.com>"
              className="bg-zinc-800 border-zinc-700"
            />
            <p className="text-xs text-zinc-500">{t("settings.form.email.resendFromHelp")}</p>
          </div>
        </>
      )}

      <div className="flex items-center gap-3">
        <Button type="submit" disabled={status === "saving" || !canSubmit} className="bg-indigo-600 hover:bg-indigo-500">
          {status === "saving" ? <><Loader2 className="w-4 h-4 mr-2 animate-spin" />{t("settings.form.common.saving")}</> : t("settings.form.common.saveAndTest")}
        </Button>
        <SaveStatusMessage status={status} okLabel={okText || undefined} errorLabel={message || undefined} />
      </div>
      {ignored.length > 0 && (
        <p role="status" className="flex items-start gap-1.5 text-sm text-amber-400">
          <AlertTriangle className="w-4 h-4 shrink-0 mt-0.5" />
          {t("settings.form.email.ignored", { fields: ignoredText })}
        </p>
      )}
    </form>
  );
}
