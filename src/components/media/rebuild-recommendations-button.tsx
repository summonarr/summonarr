"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { RefreshCw } from "@/components/icons";
import { withBasePath } from "@/lib/base-path";
import { fetchJson } from "@/lib/client/fetch-json";
import { useT } from "@/components/i18n/i18n-provider";
import { rebuildOutcome, type RebuildOutcome } from "./rebuild-recommendations-outcome";

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
  const t = useT();
  const [loading, setLoading] = useState(false);
  const [message, setMessage] = useState<Pick<RebuildOutcome, "text" | "type" | "detail"> | null>(null);
  const [cooldown, setCooldown] = useState(0);

  // The outcome is a one-off report, not state: clear it once it has been
  // read rather than leaving "Rebuilt 3 of 3 shelves" beside the button for
  // the rest of the visit.
  useEffect(() => {
    if (!message) return;
    const timer = setTimeout(() => setMessage(null), message.type === "success" ? 8000 : 15000);
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
    // A rebuild runs for as long as the build takes, so no client timeout:
    // giving up early would read as a failure while the job finishes anyway.
    const res = await fetchJson(withBasePath("/api/cron/warm-recommendations"), {
      init: { method: "POST" },
      timeoutMs: Infinity,
    });
    const outcome = rebuildOutcome(res, t);
    setMessage({ text: outcome.text, type: outcome.type, detail: outcome.detail });
    setCooldown(outcome.cooldown);
    // Nothing else on the page would re-render the shelves — LiveRefresh
    // listens for request events, not this.
    if (outcome.refresh) router.refresh();
    setLoading(false);
  }

  const busy = loading || cooldown > 0;

  return (
    <span className="inline-flex items-center gap-2 flex-wrap align-middle">
      <button
        type="button"
        onClick={handleRebuild}
        disabled={busy}
        // A fixed name: one that counted down every second was re-announced on
        // each tick by some screen readers. The wait is in the title.
        aria-label={t("browse.forYou.rebuild.label")}
        title={
          cooldown > 0
            ? t("browse.forYou.rebuild.wait", { seconds: cooldown })
            : t("browse.forYou.rebuild.title")
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
        {loading ? t("browse.forYou.rebuild.running") : t("browse.forYou.rebuild.button")}
      </button>
      <span role="status" className="ds-mono" style={{ fontSize: 11 }}>
        {message && (
          <span
            // The server's own (English) words, when it sent any.
            title={message.detail}
            style={{
              color:
                message.type === "success" ? "var(--ds-success)"
                : message.type === "warning" ? "var(--ds-warning)"
                : "var(--ds-danger)",
            }}
          >
            {message.text}
          </span>
        )}
      </span>
    </span>
  );
}
