"use client";

import { ApiKeySettingForm } from "./api-key-setting-form";

export function OmdbForm({ initialApiKey }: { initialApiKey: string }) {
  return (
    <ApiKeySettingForm
      initialApiKey={initialApiKey}
      settingKey="omdbApiKey"
      testService="omdb"
      label="OMDB API Key"
      inputId="omdb-key"
      help={
        <>
          Enables IMDb and Rotten Tomatoes ratings on all detail pages. Get a free key at{" "}
          <a href="https://www.omdbapi.com/apikey.aspx" target="_blank" rel="noopener noreferrer" className="text-indigo-400 hover:underline">
            omdbapi.com
          </a>.
        </>
      }
    />
  );
}
