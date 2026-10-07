"use client";

import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Loader2 } from "@/components/icons";
import { SaveStatusMessage } from "./save-status";
import { withBasePath } from "@/lib/base-path";
import type { SaveStatus } from "./shared";
import { useT } from "@/components/i18n/i18n-provider";

function generateSecret(): string {
  const bytes = new Uint8Array(24);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

function WebhookSecretField({
  id,
  label,
  helpText,
  payloadKey,
  initialSecret,
}: {
  id: string;
  label: string;
  helpText: React.ReactNode;
  payloadKey: string;
  initialSecret: string;
}) {
  const t = useT();
  const router = useRouter();
  const [secret, setSecret] = useState(initialSecret);
  const [status, setStatus] = useState<SaveStatus>("idle");
  // The route's own reason (a 429 cooldown, too long) — shown in place of the
  // bare "Failed to save".
  const [message, setMessage] = useState("");
  // An earlier save's idle timer must not fire into a later save (it would
  // re-enable Save mid-flight or hide the new result early).
  const idleTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => () => {
    if (idleTimer.current) clearTimeout(idleTimer.current);
  }, []);

  async function handleSave(e: React.FormEvent) {
    e.preventDefault();
    if (idleTimer.current) clearTimeout(idleTimer.current);
    setStatus("saving");
    setMessage("");
    try {
      const res = await fetch(withBasePath("/api/settings"), {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ [payloadKey]: secret }),
      });
      const data = (await res.json().catch(() => ({}))) as { ok?: boolean; error?: string };
      if (res.ok && data.ok !== false) {
        setStatus("ok");
        // The webhook URL list below is server-rendered from "does a secret
        // exist" flags; re-render it so the ?token= mask, the 4K copy row and
        // the "no secret" warning follow the save instead of waiting for a
        // reload (the secret input is type=password, so a reload was the only
        // way to get at the URL).
        router.refresh();
      } else {
        setMessage(data.error ?? t("settings.form.common.saveFailed"));
        setStatus("error");
      }
    } catch {
      setStatus("error");
    }
    idleTimer.current = setTimeout(() => setStatus((s) => (s === "ok" ? "idle" : s)), 3000);
  }

  return (
    <form onSubmit={handleSave} className="space-y-3">
      <div className="space-y-1.5">
        <Label htmlFor={id}>{label}</Label>
        <div className="flex gap-2">
          <Input
            id={id}
            type="password"
            value={secret}
            onChange={(e) => { setSecret(e.target.value); setStatus("idle"); }}
            placeholder={t("settings.form.webhookSecret.placeholder")}
            className="bg-zinc-800 border-zinc-700 font-mono"
          />
          <Button
            type="button"
            variant="outline"
            className="shrink-0 border-zinc-700 text-zinc-300 hover:text-zinc-100"
            onClick={() => { setSecret(generateSecret()); setStatus("idle"); }}
          >
            {t("settings.form.webhookSecret.generate")}
          </Button>
        </div>
        <p className="text-xs text-zinc-500">{helpText}</p>
      </div>
      <div className="flex items-center gap-3">
        <Button type="submit" disabled={status === "saving"} className="bg-indigo-600 hover:bg-indigo-500">
          {status === "saving" ? <><Loader2 className="w-4 h-4 mr-2 animate-spin" />{t("settings.form.common.saving")}</> : t("settings.form.webhookSecret.save")}
        </Button>
        <SaveStatusMessage status={status} errorLabel={message || t("settings.form.common.saveFailed")} />
      </div>
    </form>
  );
}

export function WebhookSecretForm({
  initialSecret,
  initialSonarrSecret,
  initialRadarrSecret,
  initialSonarr4kSecret,
  initialRadarr4kSecret,
}: {
  initialSecret: string;
  initialSonarrSecret?: string;
  initialRadarrSecret?: string;
  initialSonarr4kSecret?: string;
  initialRadarr4kSecret?: string;
}) {
  const t = useT();
  return (
    <div className="space-y-6">
      <WebhookSecretField
        id="webhook-secret-sonarr"
        label={t("settings.form.webhookSecret.label", { service: "Sonarr" })}
        payloadKey="sonarrWebhookSecret"
        initialSecret={initialSonarrSecret ?? ""}
        helpText={t("settings.form.webhookSecret.help", { service: "Sonarr" })}
      />
      <WebhookSecretField
        id="webhook-secret-radarr"
        label={t("settings.form.webhookSecret.label", { service: "Radarr" })}
        payloadKey="radarrWebhookSecret"
        initialSecret={initialRadarrSecret ?? ""}
        helpText={t("settings.form.webhookSecret.help", { service: "Radarr" })}
      />
      <WebhookSecretField
        id="webhook-secret-radarr4k"
        label={t("settings.form.webhookSecret.label", { service: "Radarr 4K" })}
        payloadKey="radarr4kWebhookSecret"
        initialSecret={initialRadarr4kSecret ?? ""}
        helpText={t("settings.form.webhookSecret.help4k", { service: "Radarr" })}
      />
      <WebhookSecretField
        id="webhook-secret-sonarr4k"
        label={t("settings.form.webhookSecret.label", { service: "Sonarr 4K" })}
        payloadKey="sonarr4kWebhookSecret"
        initialSecret={initialSonarr4kSecret ?? ""}
        helpText={t("settings.form.webhookSecret.help4k", { service: "Sonarr" })}
      />
      <div className="border-t border-zinc-800 pt-5">
        <WebhookSecretField
          id="webhook-secret-legacy"
          label={t("settings.form.webhookSecret.legacyLabel")}
          payloadKey="webhookSecret"
          initialSecret={initialSecret}
          helpText={t("settings.form.webhookSecret.legacyHelp")}
        />
      </div>
    </div>
  );
}
