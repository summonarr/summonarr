"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Loader2, Trash2 } from "@/components/icons";
import { SaveStatusMessage } from "./save-status";
import { useSettingsSave } from "./shared";
import { useFocusReturn } from "@/hooks/use-focus-return";
import { useT } from "@/components/i18n/i18n-provider";
import { SECRET_MASK_SENTINEL } from "@/lib/secret-mask";

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
  // The settings page passes the mask when a secret is saved, "" when none is.
  initialSecret: string;
}) {
  const t = useT();
  const router = useRouter();
  // The field starts EMPTY even when a secret is saved: the mask is only its
  // placeholder. As the field's value, a secret pasted with the caret after it
  // was refused, and select-all, delete, Save removed the stored one. An empty
  // field with a saved secret means "keep it"; removal is its own button.
  const [secret, setSecret] = useState("");
  // Whether a secret is SAVED on the server right now (the prop is set once at
  // page load), updated after every successful PATCH.
  const [secretIsSet, setSecretIsSet] = useState(initialSecret.length > 0);
  // The last success was a removal (the result line says so).
  const [removed, setRemoved] = useState(false);
  // Remove deletes the stored secret at once and the webhook then answers 401,
  // so it asks first. Focus moves into the confirm row and back to Remove.
  const [confirmingRemove, setConfirmingRemove] = useState(false);
  const focus = useFocusReturn();
  // `message` is the route's own reason (a 429 cooldown, too long), shown in
  // place of the bare "Failed to save".
  const { status, message, save, edited } = useSettingsSave();

  // The server ignores the bare mask, and an empty field only matters as an
  // explicit Remove, so neither is a change to save.
  const dirty = secret.length > 0 && secret !== SECRET_MASK_SENTINEL;
  const busy = status === "saving";

  // "" deletes the stored secret (the webhook secrets are clearable).
  async function patchSecret(value: string): Promise<boolean> {
    const result = await save({ [payloadKey]: value });
    if (!result.ok) return false;
    setSecretIsSet(value.length > 0);
    setRemoved(value.length === 0);
    // The stored secret is write-only: the field goes back to empty.
    setSecret("");
    // The webhook URL list below is server-rendered from "does a secret
    // exist" flags; re-render it so the ?token= mask, the 4K copy row and
    // the "no secret" warning follow the save instead of waiting for a
    // reload.
    router.refresh();
    return true;
  }

  async function handleSave(e: React.FormEvent) {
    e.preventDefault();
    if (!dirty || busy) return;
    await patchSecret(secret);
  }

  async function handleRemove() {
    setConfirmingRemove(false);
    focus.returnToIfLost("secret");
    await patchSecret("");
  }

  return (
    <form onSubmit={handleSave} className="space-y-3">
      <div className="space-y-1.5">
        <Label htmlFor={id}>{label}</Label>
        <div className="flex flex-wrap gap-2">
          <Input
            id={id}
            type="password"
            autoComplete="new-password"
            data-1p-ignore
            data-lpignore="true"
            value={secret}
            onChange={(e) => { setSecret(e.target.value); edited(); }}
            placeholder={secretIsSet ? SECRET_MASK_SENTINEL : t("settings.form.webhookSecret.placeholder")}
            className="bg-zinc-800 border-zinc-700 font-mono min-w-0 flex-1"
          />
          <Button
            type="button"
            variant="outline"
            className="shrink-0 border-zinc-700 text-zinc-300 hover:text-zinc-100"
            onClick={() => { setSecret(generateSecret()); edited(); }}
          >
            {t("settings.form.webhookSecret.generate")}
          </Button>
          {secretIsSet && !confirmingRemove && (
            <Button
              ref={focus.refFor("secret")}
              type="button"
              variant="outline"
              onClick={() => setConfirmingRemove(true)}
              disabled={busy}
              className="shrink-0 border-zinc-700 text-zinc-400 hover:text-zinc-100 gap-1.5"
            >
              <Trash2 className="w-3.5 h-3.5" aria-hidden />
              {t("settings.form.common.remove")}
            </Button>
          )}
        </div>
        {secretIsSet && confirmingRemove && (
          <div role="group" aria-label={t("settings.form.common.remove")} className="flex flex-wrap items-center gap-2">
            <span className="text-xs text-zinc-400">{t("settings.form.webhookSecret.confirmRemove")}</span>
            <Button type="button" variant="destructive" size="sm" autoFocus disabled={busy} onClick={() => void handleRemove()}>
              {t("settings.form.common.remove")}
            </Button>
            <Button
              type="button"
              variant="ghost"
              size="sm"
              onClick={() => { focus.returnTo("secret"); setConfirmingRemove(false); }}
            >
              {t("settings.form.common.cancel")}
            </Button>
          </div>
        )}
        {secretIsSet && !secret && (
          <p className="text-xs text-zinc-500">{t("settings.form.agents.secretKeep")}</p>
        )}
        <p className="text-xs text-zinc-500">{helpText}</p>
      </div>
      <div className="flex items-center gap-3">
        {/* Disabled while there is nothing new to save: an empty field means
            "keep the saved secret". Removing is its own button above. */}
        <Button type="submit" disabled={busy || !dirty} className="bg-indigo-600 hover:bg-indigo-500">
          {busy
            ? <><Loader2 className="w-4 h-4 mr-2 animate-spin" />{t("settings.form.common.saving")}</>
            : t("settings.form.webhookSecret.save")}
        </Button>
        <SaveStatusMessage
          status={status}
          okLabel={removed ? t("settings.form.webhookSecret.removed") : undefined}
          errorLabel={message || t("settings.form.common.saveFailed")}
        />
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
