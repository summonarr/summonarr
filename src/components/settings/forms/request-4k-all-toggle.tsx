"use client";

import { useT } from "@/components/i18n/i18n-provider";
import { SettingToggle } from "./setting-toggle";

// request4kAll skips the settings route's per-key cooldown, so a quick second
// click to undo isn't refused; SettingToggle keeps the switch locked while a
// save runs, so two saves can't finish in the wrong order.
export function Request4kAllToggle({ initialEnabled }: { initialEnabled: boolean }) {
  const t = useT();
  return (
    <SettingToggle
      settingKey="request4kAll"
      initialEnabled={initialEnabled}
      title={t("settings.form.request4kAll.title")}
      help={t("settings.form.request4kAll.help")}
    />
  );
}
