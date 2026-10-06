"use client";

import { useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Loader2 } from "@/components/icons";
import { SaveStatusMessage } from "./save-status";
import { withBasePath } from "@/lib/base-path";
import type { SaveStatus } from "./shared";
import { useT } from "@/components/i18n/i18n-provider";

// How many days audit-log rows keep personal data (PII, e.g. IP addresses)
// before it is scrubbed. getAuditPiiRetentionDays() reads this one setting for
// BOTH the daily scrub-audit-pii cron and the manual "Scrub PII" button on the
// Audit Log page, so the two always agree.
export function AuditRetentionForm({ initialDays }: { initialDays: string }) {
  const t = useT();
  const [days, setDays] = useState(initialDays);
  const [status, setStatus] = useState<SaveStatus>("idle");
  const [error, setError] = useState("");
  // Only the "Saved" tick fades. A validation error (the 7–3650 day range) is
  // the whole guidance this form gives, so it stays until the next edit or
  // save. Kept in a ref so a second save cancels the first save's timer
  // (otherwise it could reset "saving" to "idle" mid-flight) and unmount
  // clears it.
  const resetTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => () => { if (resetTimer.current) clearTimeout(resetTimer.current); }, []);

  async function handleSave(e: React.FormEvent) {
    e.preventDefault();
    if (resetTimer.current) clearTimeout(resetTimer.current);
    setStatus("saving");
    setError("");
    try {
      const res = await fetch(withBasePath("/api/settings"), {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ auditPiiRetentionDays: days }),
      });
      const data = (await res.json().catch(() => ({}))) as { ok?: boolean; error?: string };
      if (res.ok && data.ok !== false) {
        setStatus("ok");
        resetTimer.current = setTimeout(() => setStatus("idle"), 4000);
      } else {
        setError(data.error ?? t("settings.form.common.saveFailed"));
        setStatus("error");
      }
    } catch {
      setError(t("settings.form.common.saveFailed"));
      setStatus("error");
    }
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
          onChange={(e) => { setDays(e.target.value); setStatus("idle"); }}
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
        <SaveStatusMessage status={status} errorLabel={error} />
      </div>
    </form>
  );
}
