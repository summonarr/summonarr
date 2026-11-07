"use client";

import { useT } from "@/components/i18n/i18n-provider";
import { SettingToggle } from "./setting-toggle";

// The two switches for the Plex watchlist server-token source (guardrail 34b):
// plexWatchlistServerSource and plexWatchlistServerAutoEnroll. Both keys skip
// the route's cooldown; SettingToggle saves one at a time.
export function PlexWatchlistServerToggles({
  initialServerSource,
  initialAutoEnroll,
}: {
  initialServerSource: boolean;
  initialAutoEnroll: boolean;
}) {
  const t = useT();
  return (
    <div className="space-y-5">
      <SettingToggle
        settingKey="plexWatchlistServerSource"
        initialEnabled={initialServerSource}
        title={t("settings.form.plexWatchlistServer.title")}
        help={t("settings.form.plexWatchlistServer.help")}
      />
      <div className="border-t border-zinc-800 pt-5">
        <SettingToggle
          settingKey="plexWatchlistServerAutoEnroll"
          initialEnabled={initialAutoEnroll}
          title={t("settings.form.plexWatchlistAutoEnroll.title")}
          help={t("settings.form.plexWatchlistAutoEnroll.help")}
        />
      </div>
    </div>
  );
}
