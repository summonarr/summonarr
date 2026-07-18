"use client";

import { ApiKeySettingForm } from "./api-key-setting-form";

export function IpinfoForm({ initialApiKey }: { initialApiKey: string }) {
  return (
    <ApiKeySettingForm
      initialApiKey={initialApiKey}
      settingKey="ipinfoToken"
      testService="ipinfo"
      label="ipinfo.io Access Token"
      inputId="ipinfo-token"
      help={
        <>
          Resolves stream IPs to city, ISP, and approximate location on the activity pages. Get a free token at{" "}
          <a href="https://ipinfo.io/signup" target="_blank" rel="noopener noreferrer" className="text-indigo-400 hover:underline">
            ipinfo.io/signup
          </a>
          {" "}— free tier: 50,000 lookups/month. Results are cached per IP for 30 days.
        </>
      }
    />
  );
}
