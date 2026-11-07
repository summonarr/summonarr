"use client";

import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { StyledSelect } from "@/components/ui/styled-select";
import { Loader2 } from "@/components/icons";
import { SaveStatusMessage } from "./save-status";
import { useSettingsSave } from "./shared";
import { useT } from "@/components/i18n/i18n-provider";

interface QuotaFormProps {
  initialLimit: string;
  initialPeriod: string;
}

export function QuotaForm({ initialLimit, initialPeriod }: QuotaFormProps) {
  const t = useT();
  const [limit, setLimit] = useState(initialLimit);
  const [period, setPeriod] = useState(initialPeriod || "week");
  // `message` is the route's own reason (out-of-range limit, a 429 cooldown),
  // shown in place of the bare "Failed to save".
  const { status, message, save, edited } = useSettingsSave();

  async function handleSave(e: React.FormEvent) {
    e.preventDefault();
    await save({ quotaLimit: limit, quotaPeriod: period });
  }

  return (
    <form onSubmit={handleSave} className="space-y-4">
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
        <div className="space-y-1.5">
          <Label htmlFor="quota-limit">{t("settings.form.quota.limitLabel")}</Label>
          <Input
            id="quota-limit"
            type="number"
            min="0"
            value={limit}
            onChange={(e) => { setLimit(e.target.value); edited(); }}
            placeholder="0"
            className="bg-zinc-800 border-zinc-700"
          />
          <p className="text-xs text-zinc-500">{t("settings.form.quota.limitHelp")}</p>
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="quota-period">{t("settings.form.quota.periodLabel")}</Label>
          <StyledSelect
            id="quota-period"
            compact
            value={period}
            onChange={(e) => { setPeriod(e.target.value); edited(); }}
          >
            <option value="day">{t("settings.form.quota.perDay")}</option>
            <option value="week">{t("settings.form.quota.perWeek")}</option>
            <option value="month">{t("settings.form.quota.perMonth")}</option>
          </StyledSelect>
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
