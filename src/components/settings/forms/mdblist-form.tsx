"use client";

import { ApiKeySettingForm } from "./api-key-setting-form";
import { MdblistPlanForm, type MdblistPlanUsage } from "./mdblist-plan-form";
import { useT } from "@/components/i18n/i18n-provider";
import { rich } from "./rich";
import type { MdblistPlanSetting } from "@/lib/mdblist-plan";

export function MdblistForm({
  initialApiKey,
  initialPlan,
  usage,
}: {
  initialApiKey: string;
  initialPlan: MdblistPlanSetting;
  usage: MdblistPlanUsage;
}) {
  const t = useT();
  return (
    <div className="space-y-5">
      <ApiKeySettingForm
        initialApiKey={initialApiKey}
        settingKey="mdblistApiKey"
        testService="mdblist"
        label={t("settings.form.apiKey.mdblist.label")}
        inputId="mdblist-key"
        help={rich(t("settings.form.apiKey.mdblist.help"), {
          link: (
            <a href="https://mdblist.com/" target="_blank" rel="noopener noreferrer" className="text-indigo-400 hover:underline">
              mdblist.com
            </a>
          ),
        })}
      />
      {/* The plan only means something once a key is saved. */}
      {initialApiKey && <MdblistPlanForm initialPlan={initialPlan} usage={usage} />}
    </div>
  );
}
