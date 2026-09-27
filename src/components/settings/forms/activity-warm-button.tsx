"use client";

import { useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { CheckCircle, Loader2, RefreshCw } from "@/components/icons";
import { withBasePath } from "@/lib/base-path";

export function ActivityWarmButton() {
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
        setResult(data.error ?? "Request failed");
      } else {
        setStatus("done");
        setResult(`Warmed ${data.warmed ?? 0} entries`);
      }
    } catch {
      setStatus("error");
      setResult("Request failed");
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
          ? <><Loader2 className="w-4 h-4 animate-spin" />Warming…</>
          : <><RefreshCw className="w-4 h-4" />Warm Activity</>
        }
      </Button>
      {result && (
        <span role={status === "error" ? "alert" : "status"} aria-live={status === "error" ? "assertive" : "polite"} className={`text-xs ${status === "error" ? "text-red-400" : "text-zinc-400"}`}>
          {result}
        </span>
      )}
      {status === "done" && !result?.includes("error") && (
        <CheckCircle className="w-4 h-4 text-green-400" />
      )}
    </div>
  );
}
