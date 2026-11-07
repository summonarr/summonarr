"use client";

import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Loader2 } from "@/components/icons";
import { SaveStatusMessage } from "./save-status";
import { useSettingsSave } from "./shared";
import { useT } from "@/components/i18n/i18n-provider";

// How many days audit-log rows keep personal data (PII, e.g. IP addresses)
// before it is scrubbed. getAuditPiiRetentionDays() reads this one setting for
// BOTH the daily scrub-audit-pii cron and the manual "Scrub PII" button on the
// Audit Log page, so the two always agree.
export function AuditRetentionForm({ initialDays }: { initialDays: string }) {
  const t = useT();
  const [days, setDays] = useState(initialDays);
  // Only the "Saved" tick fades (after 4s). A validation error (the 7–3650 day
  // range) is the whole guidance this form gives, so it stays until the next
  // edit or save.
  const { status, message, save, edited } = useSettingsSave(4000);

  async function handleSave(e: React.FormEvent) {
    e.preventDefault();
    await save({ auditPiiRetentionDays: days });
  }

  return (
    <form onSubmit={handleSave} className="space-y-4">
      <div className="space-y-1.5">
        <Label htmlFor="audit-pii-retention-days">{t("settings.form.auditRetention.label")}</Label>
        <Input
          id="audit-pii-retention-days"
          type="number"
          min="7"
          max="3650"
          value={days}
          onChange={(e) => { setDays(e.target.value); edited(); }}
          placeholder="90"
          className="bg-zinc-800 border-zinc-700 max-w-48"
        />
        <p className="text-xs text-zinc-500">
          {t("settings.form.auditRetention.help")}
        </p>
      </div>
      <div className="flex items-center gap-3 flex-wrap">
        <Button type="submit" size="sm" disabled={status === "saving"}>
          {status === "saving" ? <Loader2 className="w-4 h-4 animate-spin" /> : t("settings.form.common.save")}
        </Button>
        <SaveStatusMessage status={status} errorLabel={message || t("settings.form.common.saveFailed")} />
      </div>
    </form>
  );
}
