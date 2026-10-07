"use client";

import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";
import { Loader2, Flame } from "@/components/icons";
import { withBasePath } from "@/lib/base-path";
import { useT } from "@/components/i18n/i18n-provider";

interface WarmCacheButtonProps {
  uncachedCount: number;
}

// Admin control that POSTs to /api/admin/library-warm to fetch TMDB metadata
// for uncached library items; shows "Cache warm" when nothing is uncached.
export function WarmCacheButton({ uncachedCount }: WarmCacheButtonProps) {
  const t = useT();
  const router = useRouter();
  const [status, setStatus] = useState<"idle" | "loading" | "done" | "error">("idle");
  const [result, setResult] = useState<string | null>(null);
  // Cancellable end-of-run reset (same shape as the sibling sync buttons): a
  // prior run's timer landing mid-run flipped "loading" back to "idle", so the
  // spinner vanished and the button re-enabled while the warm was still going.
  const resetTimer = useRef<ReturnType<typeof setTimeout>>(undefined);
  useEffect(() => () => clearTimeout(resetTimer.current), []);

  async function handleWarm() {
    clearTimeout(resetTimer.current);
    setStatus("loading");
    setResult(null);
    try {
      const res = await fetch(withBasePath("/api/admin/library-warm"), { method: "POST" });
      const data = (await res.json().catch(() => null)) as { fetched?: number; skipped?: number; total?: number; failed?: number; error?: string } | null;
      if (!res.ok || data?.error) {
        setStatus("error");
        setResult(data?.error ?? t("adminManage.users.error.requestFailed", { status: res.status }));
      } else {
        setStatus("done");
        setResult(t("adminManage.library.btn.warmResult", { fetched: data?.fetched ?? 0, skipped: data?.skipped ?? 0 }));
        router.refresh();
      }
    } catch {
      setStatus("error");
      setResult(t("adminManage.library.btn.requestFailed"));
    }
    clearTimeout(resetTimer.current);
    // Clear the result WITH the status (as the sibling sync buttons do) — a
    // "Fetched 120, skipped 4" line otherwise stayed on screen indefinitely in
    // neutral grey once the button had returned to idle.
    resetTimer.current = setTimeout(() => { setStatus("idle"); setResult(null); }, 8000);
  }

  if (uncachedCount === 0 && status === "idle") {
    return (
      <span className="text-xs text-green-400 flex items-center gap-1.5">
        <Flame className="w-3.5 h-3.5" />
        {t("adminManage.library.btn.cacheWarm")}
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
        className="border-zinc-700 text-zinc-300 hover:text-zinc-100 gap-2"
      >
        {status === "loading"
          ? <><Loader2 className="w-4 h-4 animate-spin" />{t("adminManage.library.btn.warming")}</>
          : <><Flame className="w-4 h-4" />{uncachedCount > 0 ? t("adminManage.library.btn.warmCacheCount", { count: uncachedCount }) : t("adminManage.library.btn.warmCache")}</>
        }
      </Button>
      {result && (
        <span
          role={status === "error" ? "alert" : "status"}
          aria-live={status === "error" ? "assertive" : "polite"}
          className={`text-xs ${status === "error" ? "text-red-400" : "text-zinc-400"}`}
        >
          {result}
        </span>
      )}
    </div>
  );
}
