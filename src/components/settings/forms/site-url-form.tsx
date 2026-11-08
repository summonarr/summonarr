"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Loader2 } from "@/components/icons";
import { SaveStatusMessage } from "./save-status";
import { useSettingsSave } from "./shared";
import { useT } from "@/components/i18n/i18n-provider";

export function SiteUrlForm({ initialUrl }: { initialUrl: string }) {
  const t = useT();
  const [url, setUrl] = useState(initialUrl);
  // `message` is the route's own reason (invalid URL, a 429 cooldown), shown
  // in place of the bare "Failed to save".
  const { status, message, save, edited } = useSettingsSave();
  const router = useRouter();

  async function handleSave(e: React.FormEvent) {
    e.preventDefault();
    const result = await save({ siteUrl: url });
    // The Plex connect form builds its plex.tv return address from this value,
    // handed down as a prop; refresh so it (and the router's cached tabs) read
    // the saved one, not the page-load copy.
    if (result.ok) router.refresh();
  }

  return (
    <form onSubmit={handleSave} className="space-y-4">
      <div className="space-y-1.5">
        <Label htmlFor="site-url">{t("settings.form.siteUrl.label")}</Label>
        <Input
          id="site-url"
          type="url"
          value={url}
          onChange={(e) => { setUrl(e.target.value); edited(); }}
          placeholder="https://request.yourdomain.com"
          className="bg-zinc-800 border-zinc-700"
        />
        <p className="text-xs text-zinc-500">
          {t("settings.form.siteUrl.help")}
        </p>
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
