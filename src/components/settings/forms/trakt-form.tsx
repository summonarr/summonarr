"use client";

import { ApiKeySettingForm } from "./api-key-setting-form";
import { useT } from "@/components/i18n/i18n-provider";
import { rich } from "./rich";

export function TraktForm({ initialApiKey }: { initialApiKey: string }) {
  const t = useT();
  return (
    <ApiKeySettingForm
      initialApiKey={initialApiKey}
      settingKey="traktClientId"
      testService="trakt"
      label={t("settings.form.apiKey.trakt.label")}
      inputId="trakt-client-id"
      help={rich(t("settings.form.apiKey.trakt.help"), {
        link: (
          <a href="https://trakt.tv/oauth/applications" target="_blank" rel="noopener noreferrer" className="text-indigo-400 hover:underline">
            trakt.tv/oauth/applications
          </a>
        ),
      })}
    />
  );
}
