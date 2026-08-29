"use client";

import { useState, useEffect } from "react";
import { Zap } from "@/components/icons";
import { withBasePath } from "@/lib/base-path";

export function ActivityWarmButton() {
  const [loading, setLoading] = useState(false);
  const [message, setMessage] = useState<{ text: string; type: "success" | "error" } | null>(null);
  const [cooldown, setCooldown] = useState(0);

  const handleWarm = async () => {
    if (loading || cooldown > 0) return;
    setLoading(true);
    setMessage(null);

    try {
      const res = await fetch(withBasePath("/api/admin/activity-warm"), { method: "POST" });
      const data = await res.json();

      if (res.ok) {
        setMessage({ text: `Warmed ${data.warmed} entries`, type: "success" });
        setCooldown(120);
      } else {
        setMessage({
          text: data.error || "Failed to warm cache",
          type: "error",
        });
        if (data.retryAfter) setCooldown(data.retryAfter);
      }
    } catch (err) {
      setMessage({
        text: err instanceof Error ? err.message : "Unknown error",
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
      {/* This control POSTs on first click — it runs a cache warm immediately,
          with no confirm step. An unlabelled icon is the wrong affordance for
          that, so the button now says what it does. The `title` was already
          here but a native tooltip is a hover-only, screen-reader-last-resort
          hint; `aria-label` gives it a real accessible name, and the visible
          text means nobody has to click to find out. */}
      <button
        onClick={handleWarm}
        disabled={loading || cooldown > 0}
        aria-label={cooldown > 0 ? `Warm activity cache — wait ${cooldown}s` : "Warm activity cache"}
        title={cooldown > 0 ? `Wait ${cooldown}s` : "Rebuild the cached play-history stats behind this dashboard"}
        className="inline-flex items-center gap-1.5 px-2.5 py-2 rounded-lg bg-zinc-800 hover:bg-zinc-700 disabled:bg-zinc-800 disabled:opacity-50 transition-colors"
      >
        <Zap className="w-4 h-4 text-amber-500 shrink-0" aria-hidden="true" />
        <span className="text-xs font-medium text-zinc-200">
          {loading ? "Warming…" : "Warm cache"}
        </span>
      </button>
      {message && (
        <span className={`text-xs ${message.type === "success" ? "text-green-400" : "text-red-400"}`}>
          {message.text}
        </span>
      )}
      {cooldown > 0 && <span className="text-xs text-zinc-500">{cooldown}s</span>}
    </div>
  );
}
