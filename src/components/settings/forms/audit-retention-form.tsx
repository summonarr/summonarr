"use client";

import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { CheckCircle, XCircle, Loader2 } from "@/components/icons";
import { withBasePath } from "@/lib/base-path";
import type { SaveStatus } from "./shared";

// PII retention window for audit rows. Read by getAuditPiiRetentionDays(),
// which drives BOTH the daily scrub-audit-pii cron and the manual "Scrub PII"
// button on the Audit Log page — one knob, one promise.
export function AuditRetentionForm({ initialDays }: { initialDays: string }) {
  const [days, setDays] = useState(initialDays);
  const [status, setStatus] = useState<SaveStatus>("idle");
  const [error, setError] = useState("");

  async function handleSave(e: React.FormEvent) {
    e.preventDefault();
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
      } else {
        setError(data.error ?? "Failed to save");
        setStatus("error");
      }
    } catch {
      setError("Failed to save");
      setStatus("error");
    }
    setTimeout(() => setStatus("idle"), 4000);
  }

  return (
    <form onSubmit={handleSave} className="space-y-4">
      <div className="space-y-1.5">
        <Label htmlFor="audit-pii-retention-days">PII retention (days)</Label>
        <Input
          id="audit-pii-retention-days"
          type="number"
          min="7"
          max="3650"
          value={days}
          onChange={(e) => { setDays(e.target.value); setStatus("idle"); }}
          placeholder="90"
          className="bg-zinc-800 border-zinc-700 text-sm max-w-48"
        />
        <p className="text-xs text-zinc-500">
          Audit rows older than this have their IP address, device, and user name redacted
          (and login-event details cleared) by the daily scrub job. The rows themselves are
          kept. Leave blank for the default of 90 days; minimum 7.
        </p>
      </div>
      <div className="flex items-center gap-3">
        <Button type="submit" size="sm" disabled={status === "saving"}>
          {status === "saving" ? <Loader2 className="w-4 h-4 animate-spin" /> : "Save"}
        </Button>
        {status === "ok" && <CheckCircle className="w-4 h-4 text-green-400" />}
        {status === "error" && (
          <span className="flex items-center gap-1.5 text-sm text-red-400">
            <XCircle className="w-4 h-4" />{error}
          </span>
        )}
      </div>
    </form>
  );
}
