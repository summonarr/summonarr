"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { RefreshCw } from "@/components/icons";
import { withBasePath } from "@/lib/base-path";

// Admin-only shortcut on /for-you to the same job the cron loop runs every
// WARM_RECOMMENDATIONS_INTERVAL (12h). The shelf is PRECOMPUTED, so without
// this the only way to see a change — after editing the seed weights, or after
// watching something new — was to wait out the cycle or find the Run button in
// Settings -> System, a tab away from the thing it changes.
//
// It deliberately posts the real cron endpoint rather than a per-user variant:
// guardrail 40's whole guarantee is the ORDER (select every seed, build the
// graph for exactly that union, then compute), and warmRecommendationsCache is
// the one place that order lives. A single-user refresh would have to reproduce
// it, and a second copy of that sequence is how the guarantee gets broken.
//
// Consequence, stated on the button itself: this rebuilds EVERY active user's
// shelf, not just the viewer's. That is the honest label for what it does.
export function RebuildRecommendationsButton() {
  const router = useRouter();
  const [loading, setLoading] = useState(false);
  const [message, setMessage] = useState<{ text: string; type: "success" | "error" } | null>(null);
  const [cooldown, setCooldown] = useState(0);

  useEffect(() => {
    if (cooldown <= 0) return;
    const timer = setTimeout(() => setCooldown((prev) => Math.max(0, prev - 1)), 1000);
    return () => clearTimeout(timer);
  }, [cooldown]);

  async function handleRebuild() {
    if (loading || cooldown > 0) return;
    setLoading(true);
    setMessage(null);
    try {
      const res = await fetch(withBasePath("/api/cron/warm-recommendations"), { method: "POST" });
      const data = (await res.json()) as {
        error?: string;
        skipped?: boolean;
        reason?: string;
        usersUpdated?: number;
        usersEligible?: number;
      };

      // The advisory lock answers {skipped, reason} with a 200 and no `error`,
      // so judging on res.ok alone would report a rebuild that never started as
      // a success. Checked BEFORE the error branch because a skip is not a
      // failure — the job is already running, which is what the operator wanted.
      if (res.ok && data.skipped) {
        setMessage({ text: data.reason ?? "Already running", type: "success" });
        setCooldown(30);
        return;
      }
      if (!res.ok || data.error) {
        setMessage({ text: data.error ?? "Rebuild failed", type: "error" });
        setCooldown(30);
        return;
      }

      const updated = data.usersUpdated ?? 0;
      const eligible = data.usersEligible ?? 0;
      setMessage({
        text: `Rebuilt ${updated} of ${eligible} ${eligible === 1 ? "shelf" : "shelves"}`,
        type: "success",
      });
      setCooldown(60);
      // The picks are read from UserRecommendation by a server component, so the
      // grid only changes on a server re-render. Nothing else on the page would
      // trigger one — LiveRefresh listens for request events, not this.
      router.refresh();
    } catch (err) {
      // A rebuild on a large library can outlive a reverse proxy's timeout
      // (~60-100s) while still completing server-side, so a transport failure
      // must not claim the job failed — say what is actually known.
      setMessage({
        text: err instanceof Error ? `Lost contact: ${err.message}` : "Lost contact with the server",
        type: "error",
      });
      setCooldown(60);
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="flex items-center gap-2">
      <button
        type="button"
        onClick={handleRebuild}
        disabled={loading || cooldown > 0}
        aria-label={cooldown > 0 ? `Rebuild picks — wait ${cooldown}s` : "Rebuild picks"}
        title={
          cooldown > 0
            ? `Wait ${cooldown}s`
            : "Re-run the recommendation build now. Rebuilds every active user's shelf, not just yours, and can take a few minutes on a cold graph."
        }
        className="ds-tap inline-flex items-center gap-1.5 font-medium transition-colors"
        style={{
          padding: "5px 12px",
          borderRadius: 6,
          fontSize: 12,
          background: "var(--ds-bg-2)",
          color: "var(--ds-fg-muted)",
          border: "1px solid var(--ds-border)",
          opacity: loading || cooldown > 0 ? 0.5 : 1,
          whiteSpace: "nowrap",
        }}
      >
        <RefreshCw
          style={{ width: 13, height: 13 }}
          className={loading ? "animate-spin" : undefined}
          aria-hidden="true"
        />
        {loading ? "Rebuilding…" : "Rebuild picks"}
      </button>
      {message && (
        <span
          className="ds-mono"
          style={{
            fontSize: 11,
            color: message.type === "success" ? "var(--ds-success)" : "var(--ds-danger)",
          }}
        >
          {message.text}
        </span>
      )}
    </div>
  );
}
