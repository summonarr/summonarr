"use client";

import { useId, useState } from "react";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { SaveButtonRow } from "./save-status";
import { useSettingsSave } from "./shared";
import { Switch } from "@/components/ui/switch";
import { useT } from "@/components/i18n/i18n-provider";

interface MotdFormProps {
  initialEnabled: boolean;
  initialTitle: string;
  initialBody: string;
}

export function MotdForm({ initialEnabled, initialTitle, initialBody }: MotdFormProps) {
  const t = useT();
  const [enabled, setEnabled] = useState(initialEnabled);
  const [title,  setTitle]  = useState(initialTitle);
  const [body,   setBody]   = useState(initialBody);
  // `errorMessage` is the route's own reason (too long, a 429 cooldown), shown
  // in place of the bare "Failed to save".
  const { status: motdStatus, message: errorMessage, save, edited } = useSettingsSave();
  const labelId = useId();
  const descId = useId();
  const titleId = useId();
  const bodyId = useId();

  async function handleSave(e: React.FormEvent) {
    e.preventDefault();
    await save({ motdEnabled: enabled ? "true" : "false", motdTitle: title, motdBody: body });
  }

  return (
    <form onSubmit={handleSave} className="space-y-4">
      <div className="flex items-center justify-between gap-4 pb-4 border-b border-zinc-800">
        <div className="min-w-0">
          <p id={labelId} className="text-sm font-medium text-zinc-200">{t("settings.form.motd.showTitle")}</p>
          <p id={descId} className="text-xs text-zinc-500 mt-0.5">{t("settings.form.motd.showHelp")}</p>
        </div>
        <Switch
          checked={enabled}
          onCheckedChange={(next) => { setEnabled(next); edited(); }}
          aria-labelledby={labelId}
          aria-describedby={descId}
          className="shrink-0"
        />
      </div>
      <div className="space-y-1.5">
        <Label htmlFor={titleId}>{t("settings.form.motd.titleLabel")} <span className="text-zinc-500 font-normal">{t("settings.form.common.optional")}</span></Label>
        <Input
          id={titleId}
          value={title}
          onChange={(e) => { setTitle(e.target.value); edited(); }}
          placeholder={t("settings.form.motd.titlePlaceholder")}
          className="bg-zinc-800 border-zinc-700"
        />
      </div>
      <div className="space-y-1.5">
        <Label htmlFor={bodyId}>{t("settings.form.motd.messageLabel")}</Label>
        <Textarea
          id={bodyId}
          value={body}
          onChange={(e) => { setBody(e.target.value); edited(); }}
          placeholder={t("settings.form.motd.messagePlaceholder")}
          rows={4}
          className="resize-none"
        />
      </div>
      <SaveButtonRow status={motdStatus} message={errorMessage} />
    </form>
  );
}
