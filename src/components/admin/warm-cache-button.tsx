"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";
import { Loader2, Flame } from "@/components/icons";
import { withBasePath } from "@/lib/base-path";
import { isNoAnswer, jobAnswerError } from "@/lib/client/library-sync";
import { runReplaceFileJob } from "@/lib/client/replace-file-job";
import { check, v } from "@/lib/validate";
import { useAsyncAction } from "@/hooks/use-async-action";
import { useDelayed } from "@/hooks/use-delayed";
import { useT } from "@/components/i18n/i18n-provider";
import type { Translator } from "@/lib/i18n/translate";

interface WarmCacheButtonProps {
  uncachedCount: number;
}

// "partial": the run finished but some TMDB fetches failed — a warning, not a
// success, or a run where most fetches failed reads as a clean one. "pending":
// no answer came yet; the warm may still be running on the server.
type Status = "idle" | "loading" | "done" | "partial" | "pending" | "error";

// A cold warm of a large library outlasts a reverse proxy's hold, so it runs
// as a background job polled every 3 s, for up to 30 minutes (guardrail 37a);
// running out is "no answer", never a failure.
const WARM_POLL_MS = 3_000;
const WARM_MAX_POLLS = 600;
// How long a finished run's line stays before the button goes back to idle.
const RESULT_MS = 8_000;

// The warm's counts (POST /api/admin/library-warm); a field it left out counts 0.
const WarmCounts = v.object({
  fetched: v.optional(v.number()),
  skipped: v.optional(v.number()),
  failed: v.optional(v.number()),
});

function warmOutcome(answer: { status: number; data: unknown }, t: Translator): { status: Status; text: string } {
  if (isNoAnswer(answer)) return { status: "pending", text: t("adminManage.library.fill.warmNoAnswer") };
  const error = jobAnswerError(answer);
  if (answer.status < 200 || answer.status >= 300 || error) {
    return { status: "error", text: error ?? t("adminManage.users.error.requestFailed", { status: answer.status }) };
  }
  const read = check(WarmCounts, answer.data);
  const counts: { fetched?: number; skipped?: number; failed?: number } = read.ok ? read.value : {};
  const { fetched = 0, skipped = 0, failed = 0 } = counts;
  return failed > 0
    ? { status: "partial", text: t("adminManage.library.btn.warmResultFailed", { fetched, skipped, failed }) }
    : { status: "done", text: t("adminManage.library.btn.warmResult", { fetched, skipped }) };
}

// Admin control that warms the TMDB metadata of uncached library items
// (/api/admin/library-warm); shows "Cache warm" when nothing is uncached.
export function WarmCacheButton({ uncachedCount }: WarmCacheButtonProps) {
  const t = useT();
  const router = useRouter();
  const action = useAsyncAction();
  const [outcome, setOutcome] = useState<{ status: Status; text: string } | null>(null);
  // The end-of-run reset is one cancellable slot (cleared on unmount): a prior
  // run's timer landing mid-run flipped the button back to idle while the warm
  // was still going.
  const later = useDelayed();
  const loading = action.busy("warm");
  const status: Status = loading ? "loading" : outcome?.status ?? "idle";

  async function handleWarm() {
    later.cancel();
    setOutcome(null);
    let answer: { status: number; data: unknown } | null | undefined;
    try {
      answer = await action.run("warm", (signal) =>
        runReplaceFileJob(fetch, withBasePath("/api/admin/library-warm"), {}, {
          intervalMs: WARM_POLL_MS,
          maxPolls: WARM_MAX_POLLS,
          // Leaving the page stops the polls (the warm itself goes on).
          isAlive: () => !signal.aborted,
        }), { ifBusy: "skip" });
    } catch {
      // The start request itself got no answer: nothing was started.
      setOutcome({ status: "error", text: t("adminManage.library.btn.requestFailed") });
      later(() => setOutcome(null), RESULT_MS);
      return;
    }
    if (!answer) return;
    const next = warmOutcome(answer, t);
    setOutcome(next);
    if (next.status === "done" || next.status === "partial") router.refresh();
    // The line clears WITH the status, as on the sibling sync buttons.
    later(() => setOutcome(null), RESULT_MS);
  }

  if (uncachedCount === 0 && status === "idle") {
    return (
      <span className="text-xs text-green-400 flex items-center gap-1.5">
        <Flame className="w-3.5 h-3.5" />
        {t("adminManage.library.btn.cacheWarm")}
      </span>
    );
  }

  const result = loading ? null : outcome?.text ?? null;
  return (
    <div className="flex items-center gap-3">
      <Button
        variant="outline"
        size="sm"
        onClick={() => void handleWarm()}
        disabled={loading}
        className="border-zinc-700 text-zinc-300 hover:text-zinc-100 gap-2"
      >
        {loading
          ? <><Loader2 className="w-4 h-4 animate-spin" />{t("adminManage.library.btn.warming")}</>
          : <><Flame className="w-4 h-4" />{uncachedCount > 0 ? t("adminManage.library.btn.warmCacheCount", { count: uncachedCount }) : t("adminManage.library.btn.warmCache")}</>
        }
      </Button>
      {result && (
        <span
          role={status === "error" ? "alert" : "status"}
          aria-live={status === "error" ? "assertive" : "polite"}
          className={`text-xs ${status === "error" ? "text-red-400" : status === "partial" ? "text-[var(--ds-warning)]" : "text-zinc-400"}`}
        >
          {result}
        </span>
      )}
    </div>
  );
}
