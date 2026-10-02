"use client";

import { ApiKeySettingForm } from "./api-key-setting-form";
import { useT } from "@/components/i18n/i18n-provider";
import { rich } from "./rich";

export function OmdbForm({ initialApiKey }: { initialApiKey: string }) {
  const t = useT();
  return (
    <ApiKeySettingForm
      initialApiKey={initialApiKey}
      settingKey="omdbApiKey"
      testService="omdb"
      label={t("settings.form.apiKey.omdb.label")}
      inputId="omdb-key"
      help={rich(t("settings.form.apiKey.omdb.help"), {
        link: (
          <a href="https://www.omdbapi.com/apikey.aspx" target="_blank" rel="noopener noreferrer" className="text-indigo-400 hover:underline">
            omdbapi.com
          </a>
        ),
      })}
    />
  );
}
