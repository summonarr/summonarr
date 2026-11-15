"use client";

import { useState } from "react";
import { NumberField } from "./number-field";
import { SaveButtonRow } from "./save-status";
import { useSettingsSave } from "./shared";
import { useT } from "@/components/i18n/i18n-provider";

interface RateLimitFormProps {
  initialRegister: string;
  initialRequests: string;
  initialIssues: string;
  initialMaxPushSubscriptions: string;
}

export function RateLimitForm({ initialRegister, initialRequests, initialIssues, initialMaxPushSubscriptions }: RateLimitFormProps) {
  const t = useT();
  const [register, setRegister] = useState(initialRegister);
  const [requests, setRequests] = useState(initialRequests);
  const [issues, setIssues] = useState(initialIssues);
  const [maxPushSubscriptions, setMaxPushSubscriptions] = useState(initialMaxPushSubscriptions);
  const { status, message, save, edited } = useSettingsSave();

  async function handleSave(e: React.FormEvent) {
    e.preventDefault();
    await save({
      rateLimitRegister: register,
      rateLimitRequests: requests,
      rateLimitIssues: issues,
      maxPushSubscriptions,
    });
  }

  return (
    <form onSubmit={handleSave} className="space-y-4">
      <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
        <NumberField
          wide
          id="rl-register"
          label={<>{t("settings.form.rateLimit.registrations")} <span className="text-zinc-500 font-normal">{t("settings.form.rateLimit.per15Min")}</span></>}
          value={register}
          onChange={(v) => { setRegister(v); edited(); }}
          min={1}
          placeholder="5"
        />
        <NumberField
          wide
          id="rl-requests"
          label={<>{t("settings.form.rateLimit.requests")} <span className="text-zinc-500 font-normal">{t("settings.form.rateLimit.perMin")}</span></>}
          value={requests}
          onChange={(v) => { setRequests(v); edited(); }}
          min={1}
          placeholder="20"
        />
        <NumberField
          wide
          id="rl-issues"
          label={<>{t("settings.form.rateLimit.issues")} <span className="text-zinc-500 font-normal">{t("settings.form.rateLimit.perMin")}</span></>}
          value={issues}
          onChange={(v) => { setIssues(v); edited(); }}
          min={1}
          placeholder="10"
        />
      </div>
      <p className="text-xs text-zinc-500">{t("settings.form.rateLimit.help")}</p>
      <div className="border-t border-zinc-800 pt-4">
        <div className="max-w-[180px]">
          {/* The route's range; 0 is refused (there is no "no limit"). */}
          <NumberField
            wide
            id="rl-push-subs"
            label={<>{t("settings.form.rateLimit.pushDevices")} <span className="text-zinc-500 font-normal">{t("settings.form.rateLimit.maxPerUser")}</span></>}
            value={maxPushSubscriptions}
            onChange={(v) => { setMaxPushSubscriptions(v); edited(); }}
            min={1}
            max={100}
            placeholder="5"
            help={t("settings.form.rateLimit.pushHelp")}
          />
        </div>
      </div>
      <SaveButtonRow status={status} message={message} />
    </form>
  );
}
