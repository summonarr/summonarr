"use client";

import { useState, useEffect } from "react";
import { Zap } from "@/components/icons";
import { withBasePath } from "@/lib/base-path";
import { fetchJson } from "@/lib/client/fetch-json";
import { check, v } from "@/lib/validate";
import { useAsyncAction } from "@/hooks/use-async-action";
import { useT } from "@/components/i18n/i18n-provider";

// What the warm route answers: on success how many entries it warmed, and on
// success or a 429 how long until the next warm may start (`retryAfter`,
// seconds) — the button counts down the server's own cooldown.
const WarmAnswer = v.object({
  warmed: v.optional(v.number()),
  retryAfter: v.optional(v.number()),
});

// The warm runs the stats aggregates, the calendar and the rewatch queries
// before it answers: a slow success is still a success (guardrail 37a's
// failure mode is reading it as a failure).
const WARM_TIMEOUT_MS = 10 * 60_000;

/** Whole seconds to wait, or 0 when the answer named none worth showing. */
function cooldownSeconds(retryAfter: number | undefined): number {
  return retryAfter !== undefined && retryAfter > 0 ? Math.ceil(retryAfter) : 0;
}

export function ActivityWarmButton() {
  const t = useT();
  const warm = useAsyncAction();
  const loading = warm.busy("warm");
  const [message, setMessage] = useState<{ text: string; type: "success" | "error" } | null>(null);
  const [cooldown, setCooldown] = useState(0);

  const handleWarm = async () => {
    if (loading || cooldown > 0) return;
    setMessage(null);
    const res = await warm.run(
      "warm",
      (signal) => fetchJson(withBasePath("/api/admin/activity-warm"), {
        init: { method: "POST" },
        schema: WarmAnswer,
        signal,
        timeoutMs: WARM_TIMEOUT_MS,
        fallbackError: t("adminActivity.warm.failed"),
      }),
      { ifBusy: "skip" },
    );
    if (!res) return;
    if (res.ok) {
      setMessage({
        text: typeof res.data.warmed === "number"
          ? t("adminActivity.warm.warmedEntries", { count: res.data.warmed })
          : t("adminActivity.warm.warmed"),
        type: "success",
      });
      setCooldown(cooldownSeconds(res.data.retryAfter));
      return;
    }
    if (res.kind === "aborted") return;
    // No answer at all (the server, or the path to it, is down) reads as such;
    // a refusal says the route's own reason (a 429 names its wait).
    const reached = res.kind === "http" || res.kind === "invalid";
    setMessage({ text: reached ? res.error : t("adminActivity.warm.unreachable"), type: "error" });
    const refused = check(WarmAnswer, res.body);
    if (refused.ok) setCooldown(cooldownSeconds(refused.value.retryAfter));
  };

  useEffect(() => {
    if (cooldown <= 0) return;
    const timer = setTimeout(() => {
      setCooldown((prev) => Math.max(0, prev - 1));
    }, 1000);
    return () => clearTimeout(timer);
  }, [cooldown]);

  return (
    <div className="flex items-center gap-2">
      {/* One click starts a cache warm right away (no confirm step), so the
          button shows visible text saying what it does. `aria-label` gives
          screen readers a proper name; `title` is only a hover hint. */}
      <button
        onClick={handleWarm}
        disabled={loading || cooldown > 0}
        aria-label={cooldown > 0 ? t("adminActivity.warm.ariaWait", { seconds: cooldown }) : t("adminActivity.warm.aria")}
        title={cooldown > 0 ? t("adminActivity.warm.wait", { seconds: cooldown }) : t("adminActivity.warm.title")}
        className="inline-flex items-center gap-1.5 px-2.5 py-2 rounded-lg bg-zinc-800 hover:bg-zinc-700 disabled:bg-zinc-800 disabled:opacity-50 transition-colors"
      >
        <Zap className="w-4 h-4 text-amber-500 shrink-0" aria-hidden="true" />
        <span className="text-xs font-medium text-zinc-200">
          {loading ? t("adminActivity.warm.warming") : t("adminActivity.warm.button")}
        </span>
      </button>
      <span
        role="status"
        aria-live="polite"
        className={`text-xs ${message?.type === "success" ? "text-green-400" : "text-red-400"}`}
      >
        {message?.text}
      </span>
      {cooldown > 0 && <span className="text-xs text-zinc-500">{cooldown}s</span>}
    </div>
  );
}
