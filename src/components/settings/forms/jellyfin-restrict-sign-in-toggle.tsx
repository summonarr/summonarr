"use client";

import { useT } from "@/components/i18n/i18n-provider";
import { SettingToggle } from "./setting-toggle";

// A row of the Authentication card's divide-y stack: the row owns its padding.
// An error (e.g. the 10s write cooldown's "wait 9s") stays until the next flip.
export function JellyfinRestrictSignInToggle({ initialRestrict }: { initialRestrict: boolean }) {
  const t = useT();
  return (
    <SettingToggle
      settingKey="jellyfinRestrictSignIn"
      initialEnabled={initialRestrict}
      title={t("settings.form.jellyfinRestrict.title")}
      help={t("settings.form.jellyfinRestrict.help")}
      className="py-3 first:pt-0 last:pb-0"
    />
  );
}
