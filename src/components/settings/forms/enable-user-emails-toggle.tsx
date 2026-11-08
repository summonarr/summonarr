"use client";

import { useT } from "@/components/i18n/i18n-provider";
import { SettingToggle } from "./setting-toggle";

// This one sits alone under EmailForm in the Email card, which has no divide-y
// stack, so it keeps its own top rule.
export function EnableUserEmailsToggle({ initialEnabled }: { initialEnabled: boolean }) {
  const t = useT();
  return (
    <SettingToggle
      settingKey="enableUserEmails"
      initialEnabled={initialEnabled}
      title={t("settings.form.userEmails.title")}
      help={t("settings.form.userEmails.help")}
      className="py-3 border-t border-zinc-800"
    />
  );
}
