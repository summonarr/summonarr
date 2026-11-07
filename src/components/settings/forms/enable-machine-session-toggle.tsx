"use client";

import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { Loader2 } from "@/components/icons";
import { useT } from "@/components/i18n/i18n-provider";
import { rich } from "./rich";
import { SaveStatusMessage } from "./save-status";
import { SettingToggleRow, useSettingToggle } from "./setting-toggle";
import { useSettingsSave } from "./shared";

export function EnableMachineSessionToggle({
  initialEnabled,
  initialAllowedIps,
}: {
  initialEnabled: boolean;
  initialAllowedIps: string;
}) {
  const t = useT();
  const toggle = useSettingToggle("enableMachineSession", initialEnabled);
  // The IP list has its own save. Only its "Saved" fades; an error (an
  // unparseable CIDR, the write cooldown) stays until the next edit or save,
  // and an edit during a save keeps it locked (useSettingsSave).
  const ips = useSettingsSave();
  const [allowedIps, setAllowedIps] = useState(initialAllowedIps);
  const [savedAllowedIps, setSavedAllowedIps] = useState(initialAllowedIps);

  async function saveAllowedIps() {
    const sent = allowedIps.trim();
    const result = await ips.save({ machineSessionAllowedIps: sent });
    if (result.ok) setSavedAllowedIps(sent);
  }

  const ipsDirty = allowedIps.trim() !== savedAllowedIps.trim();

  // A row of the Authentication card's divide-y stack: this wrapper owns the
  // padding for the switch row and the IP list under it.
  return (
    <div className="py-3 first:pt-0 last:pb-0">
      <SettingToggleRow
        title={t("settings.form.machineSession.title")}
        help={rich(t("settings.form.machineSession.help"), {
          endpoint: <code className="text-zinc-400">POST /api/auth/machine-session</code>,
          secret: <code className="text-zinc-400">CRON_SECRET</code>,
        })}
        checked={toggle.value}
        onCheckedChange={() => void toggle.set(!toggle.value)}
        status={toggle.status}
        message={toggle.message}
      />

      {/*
        Always shown, even while the switch is off. The server refuses to turn
        the switch on while the IP list is empty, and the toggle then flips the
        switch back. If this editor only showed while the switch was on, it would
        vanish along with the failed toggle and a fresh install could never be
        enabled. So: set the IPs first, then flip the switch.
      */}
      <div className="mt-3 pl-0.5">
        <label htmlFor="machine-session-ips" className="block text-xs font-medium text-zinc-300">
          {t("settings.form.machineSession.ipsLabel")}
        </label>
        <p className="text-xs text-zinc-500 mt-0.5 mb-1.5">
          {rich(t("settings.form.machineSession.ipsHelp"), {
            example: <code className="text-zinc-400">10.0.0.5, 192.168.1.0/24</code>,
            required: <strong className="text-zinc-300">{t("settings.form.machineSession.required")}</strong>,
            trustProxy: <code className="text-zinc-400">TRUST_PROXY=true</code>,
            header: <code className="text-zinc-400">X-Forwarded-For</code>,
          })}
        </p>
        <Textarea
          id="machine-session-ips"
          value={allowedIps}
          onChange={(e) => { setAllowedIps(e.target.value); ips.edited(); }}
          rows={2}
          spellCheck={false}
          placeholder={t("settings.form.machineSession.ipsPlaceholder", { example: "10.0.0.5, 192.168.1.0/24" })}
          className="font-mono"
        />
        <div className="flex flex-wrap items-center gap-2 mt-1.5">
          <Button
            type="button"
            size="xs"
            onClick={saveAllowedIps}
            disabled={!ipsDirty || ips.status === "saving"}
          >
            {t("settings.form.machineSession.saveIps")}
          </Button>
          {ips.status === "saving" && <Loader2 className="w-3.5 h-3.5 animate-spin text-zinc-500" aria-hidden />}
          <SaveStatusMessage status={ips.status} errorLabel={ips.message || t("settings.form.common.saveFailed")} />
        </div>
      </div>
    </div>
  );
}
