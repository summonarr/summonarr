"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";
import { Loader2, Flame } from "lucide-react";

interface WarmCacheButtonProps {
  uncachedCount: number;
}

export function WarmCacheButton({ uncachedCount }: WarmCacheButtonProps) {
  const router = useRouter();
  const [status, setStatus] = useState<"idle" | "loading" | "done" | "error">("idle");
  const [result, setResult] = useState<string | null>(null);

  async function handleWarm() {
    setStatus("loading");
    setResult(null);
    try {
      const res = await fetch("/api/admin/library-warm", { method: "POST" });
      const data: { fetched?: number; skipped?: number; total?: number; failed?: number; error?: string } = await res.json();
      if (data.error) {
        setStatus("error");
        setResult(data.error);
      } else {
        setStatus("done");
        setResult(`Fetched ${data.fetched ?? 0}, skipped ${data.skipped ?? 0} fresh`);
        router.refresh();
      }
    } catch {
      setStatus("error");
      setResult("Request failed");
    }
    setTimeout(() => setStatus("idle"), 8000);
  }

  if (uncachedCount === 0 && status === "idle") {
    return (
      <span className="text-xs text-green-400 flex items-center gap-1.5">
        <Flame className="w-3.5 h-3.5" />
        Cache warm
      </span>
    );
  }

  return (
    <div className="flex items-center gap-3">
      <Button
        variant="outline"
        size="sm"
        onClick={handleWarm}
        disabled={status === "loading"}
        className="border-zinc-700 text-zinc-300 hover:text-white gap-2"
      >
        {status === "loading"
          ? <><Loader2 className="w-4 h-4 animate-spin" />Warming…</>
          : <><Flame className="w-4 h-4" />Warm Cache{uncachedCount > 0 ? ` (${uncachedCount})` : ""}</>
        }
      </Button>
      {result && (
        <span className={`text-xs ${status === "error" ? "text-red-400" : "text-zinc-400"}`}>
          {result}
        </span>
      )}
    </div>
  );
}
