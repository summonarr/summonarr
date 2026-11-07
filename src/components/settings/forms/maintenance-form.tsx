"use client";

import { useId, useState } from "react";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Loader2 } from "@/components/icons";
import { SaveStatusMessage } from "./save-status";
import { useSettingsSave } from "./shared";
import { Switch } from "@/components/ui/switch";
import { useT } from "@/components/i18n/i18n-provider";

interface MaintenanceFormProps {
  initialEnabled: boolean;
  initialMessage: string;
}

export function MaintenanceForm({ initialEnabled, initialMessage }: MaintenanceFormProps) {
  const t = useT();
  const [enabled, setEnabled] = useState(initialEnabled);
  const [message, setMessage] = useState(initialMessage);
  // `errorMessage` is the route's own reason (too long, a 429 cooldown), shown
  // in place of the bare "Failed to save". An edit during a save keeps Save
  // locked and isn't reported as saved (useSettingsSave).
  const { status, message: errorMessage, save, edited } = useSettingsSave();
  const titleId = useId();
  const descId = useId();

  async function handleSave(e: React.FormEvent) {
    e.preventDefault();
    await save({
      maintenanceEnabled: enabled ? "true" : "false",
      maintenanceMessage: message,
    });
  }

  return (
    <form onSubmit={handleSave} className="space-y-4">
      {/* Same labelled row as the MOTD card right below it: title + help on the
          left, the switch on the right. The warning track colour stays — this
          one locks everyone but admins out. */}
      <div className="flex items-center justify-between gap-4 pb-4 border-b border-zinc-800">
        <div className="min-w-0">
          <p id={titleId} className="text-sm font-medium text-zinc-200">{t("settings.form.maintenance.enableTitle")}</p>
          <p id={descId} className="text-xs text-zinc-500 mt-0.5">{t("settings.form.maintenance.enableHelp")}</p>
        </div>
        <Switch
          variant="warning"
          checked={enabled}
          onCheckedChange={() => { setEnabled(!enabled); edited(); }}
          aria-labelledby={titleId}
          aria-describedby={descId}
          className="shrink-0"
        />
      </div>
      <div className="space-y-1.5">
        <Label htmlFor="maintenance-message">{t("settings.form.maintenance.messageLabel")} <span className="text-zinc-500 font-normal">{t("settings.form.common.optional")}</span></Label>
        <Textarea
          id="maintenance-message"
          value={message}
          onChange={(e) => { setMessage(e.target.value); edited(); }}
          placeholder={t("settings.form.maintenance.messagePlaceholder")}
          rows={3}
          className="resize-none"
        />
      </div>
      <div className="flex items-center gap-3">
        <Button type="submit" disabled={status === "saving"} className="bg-indigo-600 hover:bg-indigo-500">
          {status === "saving" ? <><Loader2 className="w-4 h-4 mr-2 animate-spin" />{t("settings.form.common.saving")}</> : t("settings.form.common.save")}
        </Button>
        <SaveStatusMessage status={status} errorLabel={errorMessage || t("settings.form.common.saveFailed")} />
      </div>
    </form>
  );
}
