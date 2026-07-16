"use client";

import { useState } from "react";
import { Button } from "@/components/ui/button";
import { CheckCircle, Loader2, RefreshCw } from "@/components/icons";
import { withBasePath } from "@/lib/base-path";

export function ActivityWarmButton() {
  const [status, setStatus] = useState<"idle" | "loading" | "done" | "error">("idle");
  const [result, setResult] = useState<string | null>(null);

  async function handleWarm() {
    setStatus("loading");
    setResult(null);
    try {
      const res = await fetch(withBasePath("/api/admin/activity-warm"), { method: "POST" });
      const data: { warmed?: number; error?: string } = await res.json();
      if (data.error) {
        setStatus("error");
        setResult(data.error);
      } else {
        setStatus("done");
        setResult(`Warmed ${data.warmed ?? 0} entries`);
      }
    } catch {
      setStatus("error");
      setResult("Request failed");
    }
    setTimeout(() => setStatus("idle"), 10000);
  }

  return (
    <div className="flex items-center gap-3">
      <Button
        type="button"
        variant="outline"
        size="sm"
        onClick={handleWarm}
        disabled={status === "loading"}
        className="border-zinc-700 text-zinc-300 hover:text-white gap-2"
      >
        {status === "loading"
          ? <><Loader2 className="w-4 h-4 animate-spin" />Warming…</>
          : <><RefreshCw className="w-4 h-4" />Warm Activity</>
        }
      </Button>
      {result && (
        <span className={`text-xs ${status === "error" ? "text-red-400" : "text-zinc-400"}`}>
          {result}
        </span>
      )}
      {status === "done" && !result?.includes("error") && (
        <CheckCircle className="w-4 h-4 text-green-400" />
      )}
    </div>
  );
}
