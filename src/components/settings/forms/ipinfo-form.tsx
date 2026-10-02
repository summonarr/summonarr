"use client";

import { ApiKeySettingForm } from "./api-key-setting-form";
import { useT } from "@/components/i18n/i18n-provider";
import { rich } from "./rich";

export function IpinfoForm({ initialApiKey }: { initialApiKey: string }) {
  const t = useT();
  return (
    <ApiKeySettingForm
      initialApiKey={initialApiKey}
      settingKey="ipinfoToken"
      testService="ipinfo"
      label={t("settings.form.apiKey.ipinfo.label")}
      inputId="ipinfo-token"
      help={rich(t("settings.form.apiKey.ipinfo.help"), {
        link: (
          <a href="https://ipinfo.io/signup" target="_blank" rel="noopener noreferrer" className="text-indigo-400 hover:underline">
            ipinfo.io/signup
          </a>
        ),
      })}
    />
  );
}
