"use client";

import { ApiKeySettingForm } from "./api-key-setting-form";
import { useT } from "@/components/i18n/i18n-provider";
import { rich } from "./rich";

export function MdblistForm({ initialApiKey }: { initialApiKey: string }) {
  const t = useT();
  return (
    <ApiKeySettingForm
      initialApiKey={initialApiKey}
      settingKey="mdblistApiKey"
      testService="mdblist"
      label={t("settings.form.apiKey.mdblist.label")}
      inputId="mdblist-key"
      help={rich(t("settings.form.apiKey.mdblist.help"), {
        link: (
          <a href="https://mdblist.com/" target="_blank" rel="noopener noreferrer" className="text-indigo-400 hover:underline">
            mdblist.com
          </a>
        ),
      })}
    />
  );
}
