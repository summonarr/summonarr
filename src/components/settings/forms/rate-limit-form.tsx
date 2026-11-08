"use client";

import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Loader2 } from "@/components/icons";
import { SaveStatusMessage } from "./save-status";
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
        <div className="space-y-1.5">
          <Label htmlFor="rl-register">{t("settings.form.rateLimit.registrations")} <span className="text-zinc-500 font-normal">{t("settings.form.rateLimit.per15Min")}</span></Label>
          <Input
            id="rl-register"
            type="number"
            min="1"
            value={register}
            onChange={(e) => { setRegister(e.target.value); edited(); }}
            placeholder="5"
            className="bg-zinc-800 border-zinc-700"
          />
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="rl-requests">{t("settings.form.rateLimit.requests")} <span className="text-zinc-500 font-normal">{t("settings.form.rateLimit.perMin")}</span></Label>
          <Input
            id="rl-requests"
            type="number"
            min="1"
            value={requests}
            onChange={(e) => { setRequests(e.target.value); edited(); }}
            placeholder="20"
            className="bg-zinc-800 border-zinc-700"
          />
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="rl-issues">{t("settings.form.rateLimit.issues")} <span className="text-zinc-500 font-normal">{t("settings.form.rateLimit.perMin")}</span></Label>
          <Input
            id="rl-issues"
            type="number"
            min="1"
            value={issues}
            onChange={(e) => { setIssues(e.target.value); edited(); }}
            placeholder="10"
            className="bg-zinc-800 border-zinc-700"
          />
        </div>
      </div>
      <p className="text-xs text-zinc-500">{t("settings.form.rateLimit.help")}</p>
      <div className="border-t border-zinc-800 pt-4">
        <div className="space-y-1.5 max-w-[180px]">
          <Label htmlFor="rl-push-subs">{t("settings.form.rateLimit.pushDevices")} <span className="text-zinc-500 font-normal">{t("settings.form.rateLimit.maxPerUser")}</span></Label>
          <Input
            id="rl-push-subs"
            type="number"
            // The route's range; 0 is refused (there is no "no limit").
            min="1"
            max="100"
            value={maxPushSubscriptions}
            onChange={(e) => { setMaxPushSubscriptions(e.target.value); edited(); }}
            placeholder="5"
            className="bg-zinc-800 border-zinc-700"
          />
          <p className="text-xs text-zinc-500">{t("settings.form.rateLimit.pushHelp")}</p>
        </div>
      </div>
      <div className="flex items-center gap-3">
        <Button type="submit" disabled={status === "saving"} className="bg-indigo-600 hover:bg-indigo-500">
          {status === "saving" ? <><Loader2 className="w-4 h-4 mr-2 animate-spin" />{t("settings.form.common.saving")}</> : t("settings.form.common.save")}
        </Button>
        <SaveStatusMessage status={status} errorLabel={message || t("settings.form.common.saveFailed")} />
      </div>
    </form>
  );
}
