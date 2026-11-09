"use client";

import { useState } from "react";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { SaveButtonRow } from "./save-status";
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
      <SaveButtonRow status={status} message={message} />
    </form>
  );
}
