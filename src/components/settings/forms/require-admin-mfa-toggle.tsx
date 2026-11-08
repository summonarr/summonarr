"use client";

import { useT } from "@/components/i18n/i18n-provider";
import { SettingToggle } from "./setting-toggle";

// Admin → Settings → Authentication: "Prompt administrators to set up two-factor"
// (Setting key requireMfaForAdmins).
// See src/lib/mfa/policy.ts for exactly what it enforces (an /admin redirect to
// enrollment — never a sign-in lockout).
export function RequireAdminMfaToggle({ initialRequired, envOverride }: { initialRequired: boolean; envOverride: boolean }) {
  const t = useT();
  // A row of the Authentication card's divide-y stack: the row owns its padding.
  // The env override is part of the switch's description.
  return (
    <SettingToggle
      settingKey="requireMfaForAdmins"
      initialEnabled={initialRequired}
      title={t("settings.form.requireAdminMfa.title")}
      help={
        <>
          {t("settings.form.requireAdminMfa.help")}
          {envOverride && (
            <span className="block mt-1 text-amber-400">
              {t("settings.form.requireAdminMfa.envOverride", { env: "SUMMONARR_DISABLE_MFA_ENFORCEMENT=true" })}
            </span>
          )}
        </>
      }
      className="py-3 first:pt-0 last:pb-0"
    />
  );
}
