"use client";

import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Loader2 } from "@/components/icons";
import { SaveStatusMessage } from "./save-status";
import { useSettingsSave } from "./shared";
import { useT } from "@/components/i18n/i18n-provider";

export function SiteTitleForm({ initialTitle }: { initialTitle: string }) {
  const t = useT();
  const [title, setTitle] = useState(initialTitle);
  // `message` is the route's own reason (too long, a 429 cooldown), shown in
  // place of the bare "Failed to save".
  const { status, message, save, edited } = useSettingsSave();

  async function handleSave(e: React.FormEvent) {
    e.preventDefault();
    await save({ siteTitle: title });
  }

  return (
    <form onSubmit={handleSave} className="space-y-4">
      <div className="space-y-1.5">
        <Label htmlFor="site-title">{t("settings.form.siteTitle.label")}</Label>
        <Input
          id="site-title"
          value={title}
          onChange={(e) => { setTitle(e.target.value); edited(); }}
          placeholder="Summonarr"
          className="bg-zinc-800 border-zinc-700"
        />
      </div>
      <div className="flex items-center gap-3">
        <Button type="submit" disabled={status === "saving"} className="bg-indigo-600 hover:bg-indigo-500">
          {status === "saving" ? <><Loader2 className="w-4 h-4 mr-2 animate-spin" />{t("settings.form.common.saving")}</> : t("settings.form.common.save")}
        </Button>
        <SaveStatusMessage status={status} errorLabel={message || t("settings.form.common.saveFailed")} />
      </div>
    </form>
  );
}
