"use client";

import { useState } from "react";
import { Button } from "@/components/ui/button";
import { CheckCircle, Loader2, RefreshCw } from "@/components/icons";
import { withBasePath } from "@/lib/base-path";
import { fetchJson } from "@/lib/client/fetch-json";
import { v } from "@/lib/validate";
import { useDelayed } from "@/hooks/use-delayed";
import { useT } from "@/components/i18n/i18n-provider";

// The warm's answer; a field of the wrong type fails the check rather than
// reaching the translator.
const WarmAnswer = v.object({ warmed: v.optional(v.number()) });

// The warm runs the stats aggregates before it answers: a slow success is
// still a success, not a timeout (guardrail 37a's failure mode).
const WARM_TIMEOUT_MS = 10 * 60_000;

export function ActivityWarmButton() {
  const t = useT();
  const [status, setStatus] = useState<"idle" | "loading" | "done" | "error">("idle");
  const [result, setResult] = useState<string | null>(null);
  // Resets the button 10s after a run. A new run cancels the previous reset —
  // otherwise an old timer could reset the button to "idle" (re-enabling it)
  // while a newer run is still loading — and nothing fires after unmount.
  const later = useDelayed();

  async function handleWarm() {
    later.cancel();
    setStatus("loading");
    setResult(null);
    const res = await fetchJson(withBasePath("/api/admin/activity-warm"), {
      init: { method: "POST" },
      schema: WarmAnswer,
      timeoutMs: WARM_TIMEOUT_MS,
    });
    if (res.ok) {
      setStatus("done");
      setResult(t("settings.form.activityWarm.result", { count: res.data.warmed ?? 0 }));
    } else {
      setStatus("error");
      // The route's own reason (a 429 names its wait), else the HTTP status.
      setResult(res.error || (res.status > 0
        ? t("settings.form.common.requestFailedHttp", { status: res.status })
        : t("settings.form.common.requestFailed")));
    }
    later(() => { setStatus("idle"); setResult(null); }, 10000);
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
