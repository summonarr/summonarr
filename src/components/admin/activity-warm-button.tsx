"use client";

import { useState, useEffect } from "react";
import { Zap } from "@/components/icons";
import { withBasePath } from "@/lib/base-path";
import { useT } from "@/components/i18n/i18n-provider";

export function ActivityWarmButton() {
  const t = useT();
  const [loading, setLoading] = useState(false);
  const [message, setMessage] = useState<{ text: string; type: "success" | "error" } | null>(null);
  const [cooldown, setCooldown] = useState(0);

  const handleWarm = async () => {
    if (loading || cooldown > 0) return;
    setLoading(true);
    setMessage(null);

    try {
      const res = await fetch(withBasePath("/api/admin/activity-warm"), { method: "POST" });
      // Tolerate a non-JSON body (e.g. a proxy's HTML error page) so the
      // status-based message below still shows instead of a parse error.
      const data = (await res.json().catch(() => ({}))) as {
        warmed?: number;
        error?: string;
        retryAfter?: number;
      };

      if (res.ok) {
        setMessage({ text: typeof data.warmed === "number" ? t("adminActivity.warm.warmedEntries", { count: data.warmed }) : t("adminActivity.warm.warmed"), type: "success" });
        setCooldown(120);
      } else {
        setMessage({
          text: data.error || t("adminActivity.warm.failed"),
          type: "error",
        });
        if (data.retryAfter) setCooldown(data.retryAfter);
      }
    } catch {
      setMessage({
        text: t("adminActivity.warm.unreachable"),
        type: "error",
      });
    } finally {
      setLoading(false);
    }
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
