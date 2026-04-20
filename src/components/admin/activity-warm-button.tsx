"use client";

import { useState, useEffect } from "react";
import { Zap } from "lucide-react";

export function ActivityWarmButton() {
  const [loading, setLoading] = useState(false);
  const [message, setMessage] = useState<{ text: string; type: "success" | "error" } | null>(null);
  const [cooldown, setCooldown] = useState(0);

  const handleWarm = async () => {
    if (loading || cooldown > 0) return;
    setLoading(true);
    setMessage(null);

    try {
      const res = await fetch("/api/admin/activity-warm", { method: "POST" });
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
      <button
        onClick={handleWarm}
        disabled={loading || cooldown > 0}
        title={cooldown > 0 ? `Wait ${cooldown}s` : "Warm activity cache"}
        className="p-2 rounded-lg bg-zinc-800 hover:bg-zinc-700 disabled:bg-zinc-800 disabled:opacity-50 transition-colors"
      >
        <Zap className="w-4 h-4 text-amber-500" />
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
