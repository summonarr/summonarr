"use client";

import { useId, useState } from "react";
import { Button } from "@/components/ui/button";
import { useT } from "@/components/i18n/i18n-provider";
import { SettingToggleRow, useSettingToggle } from "./setting-toggle";

// Turning local login OFF refuses every password sign-in, registration and 2FA
// completion — admins included. So it is never one click: the switch asks first,
// and it can't be turned on at all until Plex, Jellyfin or SSO sign-in is set up
// (`externalSignInConfigured`, the login page's predicates). The settings route
// refuses the same write server-side. Turning it back off is always one click.
export function DisableLocalLoginToggle({
  initialDisabled,
  externalSignInConfigured,
}: {
  initialDisabled: boolean;
  externalSignInConfigured: boolean;
}) {
  const t = useT();
  // The switch moves before the server answers and flips back on a refusal.
  const toggle = useSettingToggle("disableLocalLogin", initialDisabled);
  const disabled = toggle.value;
  const [confirming, setConfirming] = useState(false);
  const titleId = useId();

  // The switch only ever asks: enabling waits for the confirmation below.
  function onSwitch() {
    if (disabled) void save(false);
    else setConfirming(true);
  }

  function save(next: boolean) {
    setConfirming(false);
    return toggle.set(next);
  }

  // A row of the Authentication card's divide-y stack: the row owns its padding.
  return (
    <SettingToggleRow
      title={t("settings.form.disableLocalLogin.title")}
      help={t("settings.form.disableLocalLogin.help")}
      note={!disabled && !externalSignInConfigured && (
        <p className="text-xs text-amber-400 mt-1">{t("settings.form.disableLocalLogin.noProvider")}</p>
      )}
      checked={disabled}
      onCheckedChange={onSwitch}
      disabled={toggle.status === "saving" || confirming || (!disabled && !externalSignInConfigured)}
      status={toggle.status}
      message={toggle.message}
      className="py-3 first:pt-0 last:pb-0"
      titleId={titleId}
    >
      {confirming && (
        <div role="alertdialog" aria-labelledby={titleId} className="basis-full flex flex-wrap items-center gap-2">
          <span className="text-sm text-zinc-400 basis-full sm:basis-auto sm:flex-1">
            {t("settings.form.disableLocalLogin.confirm")}
          </span>
          <Button type="button" variant="destructive" onClick={() => void save(true)}>
            {t("settings.form.disableLocalLogin.title")}
          </Button>
          {/* The switch is disabled while this asks, so focus moves here. */}
          <Button type="button" variant="ghost" autoFocus onClick={() => setConfirming(false)}>
            {t("settings.form.common.cancel")}
          </Button>
        </div>
      )}
    </SettingToggleRow>
  );
}
