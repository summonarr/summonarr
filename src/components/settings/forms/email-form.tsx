"use client";

import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Loader2 } from "@/components/icons";
import { SaveStatusMessage } from "./save-status";
import { withBasePath } from "@/lib/base-path";
import type { SaveStatus } from "./shared";
import { useT } from "@/components/i18n/i18n-provider";
import { rich } from "./rich";

interface EmailFormProps {
  initialBackend: "smtp" | "resend";
  initialHost: string;
  initialPort: string;
  initialUser: string;
  initialPassword: string;
  initialFrom: string;
  initialResendApiKey: string;
  initialResendFrom: string;
}

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
  const [password,     setPassword]     = useState(initialPassword);
  const [from,         setFrom]         = useState(initialFrom);
  const [resendApiKey, setResendApiKey] = useState(initialResendApiKey);
  const [resendFrom,   setResendFrom]   = useState(initialResendFrom);
  const [status,       setStatus]       = useState<SaveStatus>("idle");
  const [message,      setMessage]      = useState("");

  async function handleSave(e: React.FormEvent) {
    e.preventDefault();
    setStatus("saving");
    setMessage("");

    const body: Record<string, string> = { emailBackend: backend };
    if (backend === "smtp") {
      body.smtpHost = host;
      body.smtpPort = port;
      body.smtpUser = user;
      body.smtpPassword = password;
      body.smtpFrom = from;
    } else {
      body.resendApiKey = resendApiKey;
      body.resendFrom = resendFrom;
    }

    try {
      const res = await fetch(withBasePath("/api/settings"), {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });

      const data = (await res.json().catch(() => ({}))) as { ok?: boolean; error?: string; smtpError?: string; smtpTested?: boolean };

      if (res.ok && data.ok) {
        setMessage(data.smtpTested ? t("settings.form.email.savedTested") : t("settings.form.common.saved"));
        setStatus("ok");
      } else {
        setMessage(data.smtpError ?? data.error ?? t("settings.form.common.saveFailed"));
        setStatus("error");
      }
    } catch {
      setMessage(t("settings.form.common.saveFailed"));
      setStatus("error");
    }
  }

  const canSubmit = backend === "smtp" ? Boolean(host) : Boolean(resendApiKey);

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
              onClick={() => { setBackend(b); setStatus("idle"); }}
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
                onChange={(e) => { setHost(e.target.value); setStatus("idle"); }}
                placeholder="smtp.example.com"
                className="bg-zinc-800 border-zinc-700 font-mono text-sm"
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="smtp-port">{t("settings.form.email.port")}</Label>
              <Input
                id="smtp-port"
                value={port}
                onChange={(e) => { setPort(e.target.value); setStatus("idle"); }}
                placeholder="587"
                className="bg-zinc-800 border-zinc-700 font-mono text-sm"
              />
            </div>
          </div>
          <div className="lg:grid lg:grid-cols-2 lg:gap-4 space-y-4 lg:space-y-0">
            <div className="space-y-1.5">
              <Label htmlFor="smtp-user">{t("settings.form.email.username")}</Label>
              <Input
                id="smtp-user"
                value={user}
                onChange={(e) => { setUser(e.target.value); setStatus("idle"); }}
                placeholder="user@example.com"
                className="bg-zinc-800 border-zinc-700 text-sm"
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="smtp-password">{t("settings.form.email.password")}</Label>
              <Input
                id="smtp-password"
                type="password"
                value={password}
                onChange={(e) => { setPassword(e.target.value); setStatus("idle"); }}
                placeholder="••••••••••••••••"
                className="bg-zinc-800 border-zinc-700 font-mono text-sm"
              />
            </div>
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="smtp-from">{t("settings.form.email.fromAddress")}</Label>
            <Input
              id="smtp-from"
              value={from}
              onChange={(e) => { setFrom(e.target.value); setStatus("idle"); }}
              placeholder="Summonarr <noreply@example.com>"
              className="bg-zinc-800 border-zinc-700 text-sm"
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
              value={resendApiKey}
              onChange={(e) => { setResendApiKey(e.target.value); setStatus("idle"); }}
              placeholder="re_••••••••••••••••"
              className="bg-zinc-800 border-zinc-700 font-mono text-sm"
            />
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
              onChange={(e) => { setResendFrom(e.target.value); setStatus("idle"); }}
              placeholder="Summonarr <noreply@yourdomain.com>"
              className="bg-zinc-800 border-zinc-700 text-sm"
            />
            <p className="text-xs text-zinc-500">{t("settings.form.email.resendFromHelp")}</p>
          </div>
        </>
      )}

      <div className="flex items-center gap-3">
        <Button type="submit" disabled={status === "saving" || !canSubmit} className="bg-indigo-600 hover:bg-indigo-500">
          {status === "saving" ? <><Loader2 className="w-4 h-4 mr-2 animate-spin" />{t("settings.form.common.saving")}</> : t("settings.form.common.saveAndTest")}
        </Button>
        <SaveStatusMessage status={status} okLabel={message} errorLabel={message} />
      </div>
    </form>
  );
}
