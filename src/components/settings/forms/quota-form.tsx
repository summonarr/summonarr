"use client";

import { useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { StyledSelect } from "@/components/ui/styled-select";
import { Loader2 } from "@/components/icons";
import { SaveStatusMessage } from "./save-status";
import { withBasePath } from "@/lib/base-path";
import type { SaveStatus } from "./shared";
import { useT } from "@/components/i18n/i18n-provider";

interface QuotaFormProps {
  initialLimit: string;
  initialPeriod: string;
}

export function QuotaForm({ initialLimit, initialPeriod }: QuotaFormProps) {
  const t = useT();
  const [limit, setLimit] = useState(initialLimit);
  const [period, setPeriod] = useState(initialPeriod || "week");
  const [status, setStatus] = useState<SaveStatus>("idle");
  // The route's own reason (out-of-range limit, a 429 cooldown) — shown in
  // place of the bare "Failed to save".
  const [message, setMessage] = useState("");
  // An earlier save's idle timer must not fire into a later save (it would
  // re-enable Save mid-flight or hide the new result early).
  const idleTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => () => {
    if (idleTimer.current) clearTimeout(idleTimer.current);
  }, []);

  async function handleSave(e: React.FormEvent) {
    e.preventDefault();
    if (idleTimer.current) clearTimeout(idleTimer.current);
    setStatus("saving");
    setMessage("");
    try {
      const res = await fetch(withBasePath("/api/settings"), {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ quotaLimit: limit, quotaPeriod: period }),
      });
      const data = (await res.json().catch(() => ({}))) as { ok?: boolean; error?: string };
      if (res.ok && data.ok !== false) {
        setStatus("ok");
      } else {
        setMessage(data.error ?? t("settings.form.common.saveFailed"));
        setStatus("error");
      }
    } catch {
      setStatus("error");
    }
    // Only an "ok" fades; an error stays until the next edit or save.
    idleTimer.current = setTimeout(() => setStatus((s) => (s === "ok" ? "idle" : s)), 3000);
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
            onChange={(e) => { setLimit(e.target.value); setStatus("idle"); }}
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
            onChange={(e) => { setPeriod(e.target.value); setStatus("idle"); }}
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
