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
//
// It renders INLINE — the page places it in the header subtitle, right after
// "updated N ago", which is the fact it changes. As a header action it wrapped
// onto its own row on phones, a row the shared loading skeleton can't reserve
// (it doesn't know the role), so admins saw the page jump on every load. So:
// every element here is phrasing content (the host is a <p>), and the hit area
// comes from padding cancelled by a negative margin so the line box doesn't grow.
export function RebuildRecommendationsButton() {
  const router = useRouter();
  const [loading, setLoading] = useState(false);
  const [message, setMessage] = useState<{ text: string; type: "success" | "error" } | null>(null);
  const [cooldown, setCooldown] = useState(0);

  // The outcome is a one-off report, not state: clear it once it has been
  // read rather than leaving "Rebuilt 3 of 3 shelves" beside the button for
  // the rest of the visit.
  useEffect(() => {
    if (!message) return;
    const timer = setTimeout(() => setMessage(null), message.type === "error" ? 15000 : 8000);
    return () => clearTimeout(timer);
  }, [message]);

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
      // A reverse proxy can answer a slow rebuild with an HTML 502/504 page, so
      // a body that isn't JSON must not surface as a parser error.
      const data = (await res.json().catch(() => ({}))) as {
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
        // A gateway timeout (502/504 from the proxy, not our JSON) says nothing
        // about the job itself, which may still be running server-side.
        const gatewayTimeout = !data.error && (res.status === 502 || res.status === 504);
        setMessage({
          text:
            data.error ??
            (gatewayTimeout
              ? "Lost contact with the server; the rebuild may still be running"
              : `Rebuild failed (HTTP ${res.status})`),
          type: "error",
        });
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
    } catch {
      // A rebuild on a large library can outlive a reverse proxy's timeout
      // (~60-100s) while still completing server-side, so a transport failure
      // must not claim the job failed — say what is actually known.
      setMessage({
        text: "Lost contact with the server; the rebuild may still be running",
        type: "error",
      });
      setCooldown(60);
    } finally {
      setLoading(false);
    }
  }

  const busy = loading || cooldown > 0;

  return (
    <span className="inline-flex items-center gap-2 flex-wrap align-middle">
      <button
        type="button"
        onClick={handleRebuild}
        disabled={busy}
        aria-label={cooldown > 0 ? `Rebuild picks — wait ${cooldown}s` : "Rebuild picks"}
        title={
          cooldown > 0
            ? `Wait ${cooldown}s`
            : "Re-run the recommendation build now. Rebuilds every active user’s shelf, not just yours, and can take a few minutes on a cold graph."
        }
        // No hover tint while disabled — a dimmed control that still lights up
        // under the cursor reads as clickable.
        className={`ds-tap inline-flex items-center gap-1 font-medium${busy ? "" : " ds-hover-tint"}`}
        style={{
          // 28px tall hit box; the -6px margins keep the subtitle's 18px line.
          padding: "6px 8px",
          margin: "-6px -2px",
          borderRadius: 6,
          fontSize: 12,
          lineHeight: "16px",
          background: "transparent",
          color: "var(--ds-accent-text)",
          border: 0,
          opacity: busy ? 0.5 : 1,
          whiteSpace: "nowrap",
        }}
      >
        <RefreshCw
          style={{ width: 12, height: 12 }}
          className={loading ? "animate-spin" : undefined}
          aria-hidden="true"
        />
        {loading ? "Rebuilding…" : "Rebuild"}
      </button>
      <span role="status" className="ds-mono" style={{ fontSize: 11 }}>
        {message && (
          <span style={{ color: message.type === "success" ? "var(--ds-success)" : "var(--ds-danger)" }}>
            {message.text}
          </span>
        )}
      </span>
    </span>
  );
}
