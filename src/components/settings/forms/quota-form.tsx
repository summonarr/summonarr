"use client";

import { useState } from "react";
import { NumberField } from "./number-field";
import { Label } from "@/components/ui/label";
import { StyledSelect } from "@/components/ui/styled-select";
import { SaveButtonRow } from "./save-status";
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
        <NumberField
          wide
          id="quota-limit"
          label={t("settings.form.quota.limitLabel")}
          value={limit}
          onChange={(v) => { setLimit(v); edited(); }}
          min={0}
          placeholder="0"
          help={t("settings.form.quota.limitHelp")}
        />
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
      <SaveButtonRow status={status} message={message} />
    </form>
  );
}
