"use client";

import { ApiKeySettingForm } from "./api-key-setting-form";

export function MdblistForm({ initialApiKey }: { initialApiKey: string }) {
  return (
    <ApiKeySettingForm
      initialApiKey={initialApiKey}
      settingKey="mdblistApiKey"
      testService="mdblist"
      label="MDBList API Key"
      inputId="mdblist-key"
      help={
        <>
          Adds RT Audience Score and Trakt ratings, and improves TV show coverage. Get a free key at{" "}
          <a href="https://mdblist.com/" target="_blank" rel="noopener noreferrer" className="text-indigo-400 hover:underline">
            mdblist.com
          </a>
          {" "}(Account → API). Free tier: 1,000 req/day.
        </>
      }
    />
  );
}
