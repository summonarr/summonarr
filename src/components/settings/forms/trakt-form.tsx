"use client";

import { ApiKeySettingForm } from "./api-key-setting-form";
import { useT } from "@/components/i18n/i18n-provider";
import { rich } from "./rich";

// The Trakt app's two credentials. The client ID alone powers the public
// popular/trending lists; the client secret is what lets users connect their
// OWN Trakt accounts on their profile (src/lib/trakt-user.ts) — the device-code
// grant needs both. Neither is testable on its own as a secret, so the secret
// field has no Test button.
export function TraktForm({ initialApiKey, initialSecret }: { initialApiKey: string; initialSecret: string }) {
  const t = useT();
  const appLink = (
    <a href="https://trakt.tv/oauth/applications" target="_blank" rel="noopener noreferrer" className="text-indigo-400 hover:underline">
      trakt.tv/oauth/applications
    </a>
  );
  return (
    <div className="space-y-5">
      <ApiKeySettingForm
        initialApiKey={initialApiKey}
        settingKey="traktClientId"
        testService="trakt"
        label={t("settings.form.apiKey.trakt.label")}
        inputId="trakt-client-id"
        help={rich(t("settings.form.apiKey.trakt.help"), { link: appLink })}
      />
      <ApiKeySettingForm
        initialApiKey={initialSecret}
        settingKey="traktClientSecret"
        label={t("settings.form.apiKey.traktSecret.label")}
        inputId="trakt-client-secret"
        help={rich(t("settings.form.apiKey.traktSecret.help"), { link: appLink })}
      />
    </div>
  );
}
