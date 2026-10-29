"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { StyledSelect } from "@/components/ui/styled-select";
import { Loader2 } from "@/components/icons";
import { SaveStatusMessage } from "./save-status";
import type { SaveStatus } from "./shared";
import { withBasePath } from "@/lib/base-path";
import { useLocale, useT } from "@/components/i18n/i18n-provider";
import { LocalDateTime } from "@/components/local-date-time";
import {
  MDBLIST_PLANS,
  MDBLIST_PLAN_SETTING_KEY,
  planDailyRequests,
  type MdblistPlanId,
  type MdblistPlanSetting,
} from "@/lib/mdblist-plan";

// The serializable slice of getMdblistUsageSnapshot (mdblist.ts) this form shows.
export interface MdblistPlanUsage {
  reportedLimit: number | null;
  reportedPlan: MdblistPlanId | null;
  usedToday: number | null;
  backgroundStopped: boolean;
  pausedUntil: string | null;
}

// Which MDBList plan the account is on. Summonarr keeps its requests under the
// lower of this and what MDBList reports, and background jobs leave a quarter
// of the day for pages (mdblist-plan.ts). "auto" is MDBList's own number.
export function MdblistPlanForm({ initialPlan, usage }: { initialPlan: MdblistPlanSetting; usage: MdblistPlanUsage }) {
  const t = useT();
  const locale = useLocale();
  const router = useRouter();
  const [plan, setPlan] = useState<MdblistPlanSetting>(initialPlan);
  const [savedPlan, setSavedPlan] = useState<MdblistPlanSetting>(initialPlan);
  const [status, setStatus] = useState<SaveStatus>("idle");
  const [error, setError] = useState("");

  const number = new Intl.NumberFormat(locale);
  const planName = (id: MdblistPlanId) => t(`settings.form.mdblistPlan.name.${id}`);
  const dirty = plan !== savedPlan;

  async function handleSave(e: React.FormEvent) {
    e.preventDefault();
    if (!dirty) return;
    setStatus("saving");
    setError("");
    try {
      const res = await fetch(withBasePath("/api/settings"), {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ [MDBLIST_PLAN_SETTING_KEY]: plan }),
      });
      const data = (await res.json().catch(() => ({}))) as { ok?: boolean; error?: string };
      if (!res.ok || data.ok === false) {
        setError(data.error ?? t("settings.form.common.saveFailed"));
        setStatus("error");
        return;
      }
      setSavedPlan(plan);
      setStatus("ok");
      // The usage line below is rendered by the server from the saved plan.
      router.refresh();
    } catch {
      setError(t("settings.form.common.saveFailed"));
      setStatus("error");
    }
  }

  // What MDBList last said about the account.
  let reported: string;
  if (usage.reportedLimit === null) {
    reported = t("settings.form.mdblistPlan.notReported");
  } else {
    const limit = number.format(usage.reportedLimit);
    const name = usage.reportedPlan ? planName(usage.reportedPlan) : null;
    if (usage.usedToday === null) {
      reported = name
        ? t("settings.form.mdblistPlan.reportedPlan", { plan: name, limit })
        : t("settings.form.mdblistPlan.reportedLimit", { limit });
    } else {
      const used = number.format(usage.usedToday);
      reported = name
        ? t("settings.form.mdblistPlan.reportedPlanUsed", { plan: name, limit, used })
        : t("settings.form.mdblistPlan.reportedLimitUsed", { limit, used });
    }
  }

  // A saved plan bigger than the account's: MDBList's number is what counts.
  const overstated =
    savedPlan !== "auto" && usage.reportedLimit !== null && planDailyRequests(savedPlan) > usage.reportedLimit;

  return (
    <form onSubmit={handleSave} className="space-y-4">
      <div className="space-y-1.5">
        <Label htmlFor="mdblist-plan">{t("settings.form.mdblistPlan.label")}</Label>
        <StyledSelect
          id="mdblist-plan"
          value={plan}
          onChange={(e) => { setPlan(e.target.value as MdblistPlanSetting); setStatus("idle"); }}
        >
          <option value="auto">{t("settings.form.mdblistPlan.auto")}</option>
          {MDBLIST_PLANS.map((p) => (
            <option key={p.id} value={p.id}>
              {t("settings.form.mdblistPlan.option", { plan: planName(p.id), limit: number.format(p.dailyRequests) })}
            </option>
          ))}
        </StyledSelect>
        <p className="text-xs text-zinc-500">{t("settings.form.mdblistPlan.help")}</p>
        <p role="status" className="text-xs text-zinc-400">{reported}</p>
        {overstated && usage.reportedLimit !== null && (
          <p className="text-xs text-amber-400">
            {t("settings.form.mdblistPlan.overstated", {
              plan: planName(savedPlan as MdblistPlanId),
              limit: number.format(usage.reportedLimit),
            })}
          </p>
        )}
        {usage.pausedUntil ? (
          <p className="text-xs text-amber-400">
            {t("settings.form.mdblistPlan.paused")} <LocalDateTime iso={usage.pausedUntil} />
          </p>
        ) : usage.backgroundStopped ? (
          <p className="text-xs text-amber-400">{t("settings.form.mdblistPlan.backgroundStopped")}</p>
        ) : null}
      </div>
      <div className="flex items-center gap-3">
        <Button type="submit" disabled={!dirty || status === "saving"} className="bg-indigo-600 hover:bg-indigo-500">
          {status === "saving"
            ? <><Loader2 className="w-4 h-4 mr-2 animate-spin" />{t("settings.form.common.saving")}</>
            : t("settings.form.common.save")}
        </Button>
        <SaveStatusMessage status={status} errorLabel={error || undefined} />
      </div>
    </form>
  );
}
