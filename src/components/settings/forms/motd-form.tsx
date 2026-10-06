"use client";

import { useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Loader2 } from "@/components/icons";
import { SaveStatusMessage } from "./save-status";
import { withBasePath } from "@/lib/base-path";
import type { SaveStatus } from "./shared";
import { Switch } from "@/components/ui/switch";
import { useT } from "@/components/i18n/i18n-provider";

interface MotdFormProps {
  initialEnabled: boolean;
  initialTitle: string;
  initialBody: string;
}

export function MotdForm({ initialEnabled, initialTitle, initialBody }: MotdFormProps) {
  const t = useT();
  const [enabled, setEnabled] = useState(initialEnabled);
  const [title,  setTitle]  = useState(initialTitle);
  const [body,   setBody]   = useState(initialBody);
  const [motdStatus, setMotdStatus] = useState<SaveStatus>("idle");
  // The route's own reason (too long, a 429 cooldown) — shown in place of the
  // bare "Failed to save".
  const [errorMessage, setErrorMessage] = useState("");
  // An earlier save's idle timer must not fire into a later save (it would
  // re-enable Save mid-flight or hide the new result early).
  const idleTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => () => {
    if (idleTimer.current) clearTimeout(idleTimer.current);
  }, []);

  async function handleSave(e: React.FormEvent) {
    e.preventDefault();
    if (idleTimer.current) clearTimeout(idleTimer.current);
    setMotdStatus("saving");
    setErrorMessage("");
    try {
      const res = await fetch(withBasePath("/api/settings"), {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ motdEnabled: enabled ? "true" : "false", motdTitle: title, motdBody: body }),
      });
      const data = (await res.json().catch(() => ({}))) as { ok?: boolean; error?: string };
      if (res.ok && data.ok !== false) {
        setMotdStatus("ok");
      } else {
        setErrorMessage(data.error ?? t("settings.form.common.saveFailed"));
        setMotdStatus("error");
      }
    } catch {
      setMotdStatus("error");
    }
    // Only an "ok" fades; an error stays until the next edit or save.
    idleTimer.current = setTimeout(() => setMotdStatus((s) => (s === "ok" ? "idle" : s)), 3000);
  }

  return (
    <form onSubmit={handleSave} className="space-y-4">
      <div className="flex items-center justify-between gap-4 pb-4 border-b border-zinc-800">
        <div className="min-w-0">
          <p id="motd-enabled-label" className="text-sm font-medium text-zinc-200">{t("settings.form.motd.showTitle")}</p>
          <p id="motd-enabled-desc" className="text-xs text-zinc-500 mt-0.5">{t("settings.form.motd.showHelp")}</p>
        </div>
        <Switch
          checked={enabled}
          onCheckedChange={() => { setEnabled(!enabled); setMotdStatus("idle"); }}
          aria-labelledby="motd-enabled-label"
          aria-describedby="motd-enabled-desc"
          className="shrink-0"
        />
      </div>
      <div className="space-y-1.5">
        <Label htmlFor="motd-title">{t("settings.form.motd.titleLabel")} <span className="text-zinc-500 font-normal">{t("settings.form.common.optional")}</span></Label>
        <Input
          id="motd-title"
          value={title}
          onChange={(e) => { setTitle(e.target.value); setMotdStatus("idle"); }}
          placeholder={t("settings.form.motd.titlePlaceholder")}
          className="bg-zinc-800 border-zinc-700"
        />
      </div>
      <div className="space-y-1.5">
        <Label htmlFor="motd-body">{t("settings.form.motd.messageLabel")}</Label>
        <Textarea
          id="motd-body"
          value={body}
          onChange={(e) => { setBody(e.target.value); setMotdStatus("idle"); }}
          placeholder={t("settings.form.motd.messagePlaceholder")}
          rows={4}
          className="resize-none"
        />
      </div>
      <div className="flex items-center gap-3">
        <Button type="submit" disabled={motdStatus === "saving"} className="bg-indigo-600 hover:bg-indigo-500">
          {motdStatus === "saving" ? <><Loader2 className="w-4 h-4 mr-2 animate-spin" />{t("settings.form.common.saving")}</> : t("settings.form.common.save")}
        </Button>
        <SaveStatusMessage status={motdStatus} errorLabel={errorMessage || t("settings.form.common.saveFailed")} />
      </div>
    </form>
  );
}
