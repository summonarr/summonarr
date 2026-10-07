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

interface SessionFormProps {
  initialDefaultDuration: string;
  initialMobileDuration: string;
  initialMaxDuration: string;
}

export function SessionForm({ initialDefaultDuration, initialMobileDuration, initialMaxDuration }: SessionFormProps) {
  const t = useT();
  const [defaultDuration, setDefaultDuration] = useState(initialDefaultDuration);
  const [mobileDuration,  setMobileDuration]  = useState(initialMobileDuration);
  const [maxDuration,     setMaxDuration]     = useState(initialMaxDuration);
  const [status, setStatus] = useState<SaveStatus>("idle");
  // The route's own reason (a 400 for an out-of-range duration, a 429 cooldown)
  // — shown in place of the bare "Failed to save".
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
        body: JSON.stringify({
          sessionDefaultDuration: defaultDuration,
          sessionMobileDuration:  mobileDuration,
          sessionMaxDuration:     maxDuration,
        }),
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
    idleTimer.current = setTimeout(() => setStatus((s) => (s === "ok" ? "idle" : s)), 3000);
  }

  // The route refuses anything outside 60..7776000 s (90 days) with a 400; the
  // native max lets the browser say so before the request, and the help text
  // names the cap so the limit isn't a surprise.
  const MAX_SESSION_SECONDS = 7_776_000;

  return (
    <form onSubmit={handleSave} className="space-y-4">
      <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
        <div className="space-y-1.5">
          <Label htmlFor="session-default">{t("settings.form.session.desktop")} <span className="text-zinc-500 font-normal">{t("settings.form.session.seconds")}</span></Label>
          <Input
            id="session-default"
            type="number"
            min="60"
            max={MAX_SESSION_SECONDS}
            value={defaultDuration}
            onChange={(e) => { setDefaultDuration(e.target.value); setStatus("idle"); }}
            placeholder="3600"
            className="bg-zinc-800 border-zinc-700"
          />
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="session-mobile">{t("settings.form.session.mobile")} <span className="text-zinc-500 font-normal">{t("settings.form.session.seconds")}</span></Label>
          <Input
            id="session-mobile"
            type="number"
            min="60"
            max={MAX_SESSION_SECONDS}
            value={mobileDuration}
            onChange={(e) => { setMobileDuration(e.target.value); setStatus("idle"); }}
            placeholder="604800"
            className="bg-zinc-800 border-zinc-700"
          />
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="session-max">{t("settings.form.session.rememberMe")} <span className="text-zinc-500 font-normal">{t("settings.form.session.seconds")}</span></Label>
          <Input
            id="session-max"
            type="number"
            min="60"
            max={MAX_SESSION_SECONDS}
            value={maxDuration}
            onChange={(e) => { setMaxDuration(e.target.value); setStatus("idle"); }}
            placeholder="2592000"
            className="bg-zinc-800 border-zinc-700"
          />
        </div>
      </div>
      <p className="text-xs text-zinc-500">
        {t("settings.form.session.help")}
      </p>
      <div className="flex items-center gap-3">
        <Button type="submit" disabled={status === "saving"} className="bg-indigo-600 hover:bg-indigo-500">
          {status === "saving" ? <><Loader2 className="w-4 h-4 mr-2 animate-spin" />{t("settings.form.common.saving")}</> : t("settings.form.common.save")}
        </Button>
        <SaveStatusMessage status={status} errorLabel={message || t("settings.form.common.saveFailed")} />
      </div>
    </form>
  );
}
