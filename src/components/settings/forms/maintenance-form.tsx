"use client";

import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Loader2 } from "@/components/icons";
import { SaveStatusMessage } from "./save-status";
import { withBasePath } from "@/lib/base-path";
import type { SaveStatus } from "./shared";
import { Switch } from "@/components/ui/switch";
import { useT } from "@/components/i18n/i18n-provider";

interface MaintenanceFormProps {
  initialEnabled: boolean;
  initialMessage: string;
}

export function MaintenanceForm({ initialEnabled, initialMessage }: MaintenanceFormProps) {
  const t = useT();
  const [enabled, setEnabled] = useState(initialEnabled);
  const [message, setMessage] = useState(initialMessage);
  const [status, setStatus] = useState<SaveStatus>("idle");

  async function handleSave(e: React.FormEvent) {
    e.preventDefault();
    setStatus("saving");
    try {
      const res = await fetch(withBasePath("/api/settings"), {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          maintenanceEnabled: enabled ? "true" : "false",
          maintenanceMessage: message,
        }),
      });
      const data = (await res.json().catch(() => ({}))) as { ok?: boolean };
      setStatus(res.ok && data.ok !== false ? "ok" : "error");
    } catch {
      setStatus("error");
    }
    setTimeout(() => setStatus("idle"), 3000);
  }

  return (
    <form onSubmit={handleSave} className="space-y-4">
      <div className="flex items-center gap-3">
        <Switch size="lg" variant="warning" checked={enabled} onCheckedChange={() => { setEnabled(!enabled); setStatus("idle"); }} />
        <span className="text-sm text-zinc-300">{enabled ? t("settings.form.maintenance.on") : t("settings.form.maintenance.off")}</span>
      </div>
      <div className="space-y-1.5">
        <Label htmlFor="maintenance-message">{t("settings.form.maintenance.messageLabel")} <span className="text-zinc-500 font-normal">{t("settings.form.common.optional")}</span></Label>
        <textarea
          id="maintenance-message"
          value={message}
          onChange={(e) => { setMessage(e.target.value); setStatus("idle"); }}
          placeholder={t("settings.form.maintenance.messagePlaceholder")}
          rows={3}
          className="w-full rounded-lg border border-zinc-700 bg-zinc-800 px-3 py-2 text-sm text-zinc-100 placeholder-zinc-500 focus:outline-none focus:ring-2 focus:ring-indigo-500 resize-none"
        />
      </div>
      <div className="flex items-center gap-3">
        <Button type="submit" disabled={status === "saving"} className="bg-indigo-600 hover:bg-indigo-500">
          {status === "saving" ? <><Loader2 className="w-4 h-4 mr-2 animate-spin" />{t("settings.form.common.saving")}</> : t("settings.form.common.save")}
        </Button>
        <SaveStatusMessage status={status} />
      </div>
    </form>
  );
}
