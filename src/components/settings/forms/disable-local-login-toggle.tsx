"use client";

import { useEffect, useId, useRef, useState } from "react";
import { CheckCircle, XCircle, Loader2 } from "@/components/icons";
import { withBasePath } from "@/lib/base-path";
import type { SaveStatus } from "./shared";
import { Switch } from "@/components/ui/switch";
import { useT } from "@/components/i18n/i18n-provider";

export function DisableLocalLoginToggle({ initialDisabled }: { initialDisabled: boolean }) {
  const t = useT();
  const [disabled, setDisabled] = useState(initialDisabled);
  const [status, setStatus] = useState<SaveStatus>("idle");
  const [error, setError] = useState<string | null>(null);
  const resetTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const titleId = useId();
  const descId = useId();

  useEffect(() => () => {
    if (resetTimer.current) clearTimeout(resetTimer.current);
  }, []);

  async function toggle() {
    const next = !disabled;
    const prev = disabled;
    setDisabled(next);
    setStatus("saving");
    setError(null);
    if (resetTimer.current) clearTimeout(resetTimer.current);
    try {
      const res = await fetch(withBasePath("/api/settings"), {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ disableLocalLogin: next ? "true" : "false" }),
      });
      const data: { ok?: boolean; error?: string } = await res.json().catch(() => ({}));
      if (!res.ok || !data.ok) {
        // The switch was flipped before the server answered. Flip it back so it
        // doesn't show a setting the server rejected or never saved.
        setDisabled(prev);
        setError(data.error ?? t("settings.form.common.saveFailed"));
        setStatus("error");
      } else {
        setStatus("ok");
        resetTimer.current = setTimeout(() => setStatus("idle"), 3000);
      }
    } catch {
      setDisabled(prev);
      setError(t("settings.form.common.saveFailed"));
      setStatus("error");
    }
  }

  // The toggle rows share one recipe: the parent card owns the dividers
  // (divide-y), each row owns its vertical padding, and a server error wraps
  // onto its own full-width line instead of pushing the switch off-card at
  // 375px (the old error+switch group was shrink-0 and wider than the card).
  return (
    <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2 py-3 first:pt-0 last:pb-0">
      <div className="min-w-0 flex-1">
        <p id={titleId} className="text-sm font-medium text-zinc-200">{t("settings.form.disableLocalLogin.title")}</p>
        <p id={descId} className="text-xs text-zinc-500 mt-0.5">
          {t("settings.form.disableLocalLogin.help")}
        </p>
      </div>
      <div className="flex items-center gap-2">
        {status === "saving" && <Loader2 className="w-3.5 h-3.5 animate-spin text-zinc-500" />}
        {status === "ok"     && <CheckCircle className="w-3.5 h-3.5 text-green-400" />}
        <Switch
          checked={disabled}
          onCheckedChange={toggle}
          disabled={status === "saving"}
          aria-labelledby={titleId}
          aria-describedby={descId}
          className="shrink-0"
        />
      </div>
      {status === "error" && (
        <span role="alert" className="basis-full flex items-center gap-1 text-xs text-red-400">
          <XCircle className="w-3.5 h-3.5 shrink-0" aria-hidden />
          {error}
        </span>
      )}
    </div>
  );
}
