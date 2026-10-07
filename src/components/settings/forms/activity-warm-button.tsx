"use client";

import { useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { CheckCircle, Loader2, RefreshCw } from "@/components/icons";
import { withBasePath } from "@/lib/base-path";
import { useT } from "@/components/i18n/i18n-provider";

export function ActivityWarmButton() {
  const t = useT();
  const [status, setStatus] = useState<"idle" | "loading" | "done" | "error">("idle");
  const [result, setResult] = useState<string | null>(null);
  // Timer that resets the button 10s after a run. Kept in a ref so a new run
  // can cancel the previous one — otherwise an old timer could reset the
  // button to "idle" (re-enabling it) while a newer run is still loading.
  const resetTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => () => { if (resetTimer.current) clearTimeout(resetTimer.current); }, []);

  async function handleWarm() {
    if (resetTimer.current) clearTimeout(resetTimer.current);
    setStatus("loading");
    setResult(null);
    try {
      const res = await fetch(withBasePath("/api/admin/activity-warm"), { method: "POST" });
      const data: { warmed?: number; error?: string } = await res.json();
      if (!res.ok || data.error) {
        setStatus("error");
        setResult(data.error ?? t("settings.form.common.requestFailed"));
      } else {
        setStatus("done");
        setResult(t("settings.form.activityWarm.result", { count: data.warmed ?? 0 }));
      }
    } catch {
      setStatus("error");
      setResult(t("settings.form.common.requestFailed"));
    }
    resetTimer.current = setTimeout(() => { setStatus("idle"); setResult(null); }, 10000);
  }

  return (
    <div className="flex items-center gap-3">
      <Button
        type="button"
        variant="outline"
        size="sm"
        onClick={handleWarm}
        disabled={status === "loading"}
        className="border-zinc-700 text-zinc-300 hover:text-zinc-100 gap-2"
      >
        {status === "loading"
          ? <><Loader2 className="w-4 h-4 animate-spin" />{t("settings.form.activityWarm.warming")}</>
          : <><RefreshCw className="w-4 h-4" />{t("settings.form.activityWarm.button")}</>
        }
      </Button>
      {result && (
        <span role={status === "error" ? "alert" : "status"} aria-live={status === "error" ? "assertive" : "polite"} className={`text-xs ${status === "error" ? "text-red-400" : "text-green-400"}`}>
          {result}
        </span>
      )}
      {/* `status` already says whether the run succeeded — never sniff the
          translated result text for the word "error" (it is not English in
          every locale). */}
      {status === "done" && (
        <CheckCircle className="w-4 h-4 text-green-400" aria-hidden />
      )}
    </div>
  );
}
