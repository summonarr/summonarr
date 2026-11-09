"use client";

import { useState } from "react";
import { NumberField } from "./number-field";
import { SaveButtonRow } from "./save-status";
import { useSettingsSave } from "./shared";
import { useT } from "@/components/i18n/i18n-provider";
import { MAX_CONFIGURABLE_SESSION_SECONDS } from "@/lib/session-lifetime";

interface SessionFormProps {
  initialDefaultDuration: string;
  initialMobileDuration: string;
  initialMaxDuration: string;
}

// The route refuses anything outside 60 s..90 days with a 400 (the settings
// registry's bound, which tests/session-transport.test.mts holds equal to this
// shared constant); the native max lets the browser say so before the request,
// and the help text names the cap so the limit isn't a surprise.
const MAX_SESSION_SECONDS = MAX_CONFIGURABLE_SESSION_SECONDS;

export function SessionForm({ initialDefaultDuration, initialMobileDuration, initialMaxDuration }: SessionFormProps) {
  const t = useT();
  const [defaultDuration, setDefaultDuration] = useState(initialDefaultDuration);
  const [mobileDuration,  setMobileDuration]  = useState(initialMobileDuration);
  const [maxDuration,     setMaxDuration]     = useState(initialMaxDuration);
  // `message` is the route's own reason (a 400 for an out-of-range duration, a
  // 429 cooldown), shown in place of the bare "Failed to save".
  const { status, message, save, edited } = useSettingsSave();

  async function handleSave(e: React.FormEvent) {
    e.preventDefault();
    await save({
      sessionDefaultDuration: defaultDuration,
      sessionMobileDuration:  mobileDuration,
      sessionMaxDuration:     maxDuration,
    });
  }

  return (
    <form onSubmit={handleSave} className="space-y-4">
      <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
        <NumberField
          wide
          id="session-default"
          label={<>{t("settings.form.session.desktop")} <span className="text-zinc-500 font-normal">{t("settings.form.session.seconds")}</span></>}
          value={defaultDuration}
          onChange={(v) => { setDefaultDuration(v); edited(); }}
          min={60}
          max={MAX_SESSION_SECONDS}
          placeholder="3600"
        />
        <NumberField
          wide
          id="session-mobile"
          label={<>{t("settings.form.session.mobile")} <span className="text-zinc-500 font-normal">{t("settings.form.session.seconds")}</span></>}
          value={mobileDuration}
          onChange={(v) => { setMobileDuration(v); edited(); }}
          min={60}
          max={MAX_SESSION_SECONDS}
          placeholder="604800"
        />
        <NumberField
          wide
          id="session-max"
          label={<>{t("settings.form.session.rememberMe")} <span className="text-zinc-500 font-normal">{t("settings.form.session.seconds")}</span></>}
          value={maxDuration}
          onChange={(v) => { setMaxDuration(v); edited(); }}
          min={60}
          max={MAX_SESSION_SECONDS}
          placeholder="2592000"
        />
      </div>
      <p className="text-xs text-zinc-500">
        {t("settings.form.session.help")}
      </p>
      <SaveButtonRow status={status} message={message} />
    </form>
  );
}
