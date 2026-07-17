"use client";

import { ApiKeySettingForm } from "./api-key-setting-form";

export function TraktForm({ initialApiKey }: { initialApiKey: string }) {
  return (
    <ApiKeySettingForm
      initialApiKey={initialApiKey}
      settingKey="traktClientId"
      testService="trakt"
      label="Trakt Client ID"
      inputId="trakt-client-id"
      help={
        <>
          Adds Trakt popular and trending lists to the Top Rated page. Create a free app at{" "}
          <a href="https://trakt.tv/oauth/applications" target="_blank" rel="noopener noreferrer" className="text-indigo-400 hover:underline">
            trakt.tv/oauth/applications
          </a>
          {" "}and copy the Client ID.
        </>
      }
    />
  );
}
