"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { EyeOff, Loader2 } from "@/components/icons";
import { withBasePath } from "@/lib/base-path";
import { useToast } from "@/components/ui/toast";
import { useT } from "@/components/i18n/i18n-provider";

// Compact "not interested" control for a MediaCard corner, used by /for-you so a
// bad pick can be tuned away where it appears rather than only from the title's
// detail page (which is where the full-size HideButton lives).
//
// Same endpoint and same effect as HideButton: /api/hidden writes a HiddenItem,
// and attachAllAvailability removes hidden titles from EVERY discovery surface
// at once. router.refresh() re-renders the server component so the card drops
// out of the grid — no client-side list state, matching house style.
export function NotInterestedButton({
  tmdbId,
  mediaType,
  title,
  posterPath,
}: {
  tmdbId: number;
  mediaType: "MOVIE" | "TV";
  title: string;
  posterPath?: string | null;
}) {
  const router = useRouter();
  const { toast } = useToast();
  const t = useT();
  const [loading, setLoading] = useState(false);

  // The button is always visible on touch, in the poster corner, so a stray tap
  // is easy — and the card leaves the grid on the refresh that follows. Undo is
  // the same DELETE the /hidden page's un-hide button sends.
  async function undo() {
    try {
      const qs = new URLSearchParams({ tmdbId: String(tmdbId), mediaType });
      const res = await fetch(withBasePath(`/api/hidden?${qs}`), { method: "DELETE" });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        toast({ title: data.error ?? t("media.notInterested.undoFailed"), variant: "error" });
        return;
      }
      router.refresh();
    } catch {
      toast({ title: t("media.notInterested.undoNetworkError"), variant: "error" });
    }
  }

  async function hide(e: React.MouseEvent) {
    // The whole card is a click target that navigates to the detail page; without
    // this the hide would also push a route.
    e.stopPropagation();
    if (loading) return;
    setLoading(true);
    try {
      const res = await fetch(withBasePath("/api/hidden"), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ tmdbId, mediaType, title, posterPath }),
      });
      // 409 = already hidden. The desired end state holds either way, so it is
      // a success for this button (same reading as HideButton).
      if (res.ok || res.status === 409) {
        toast({
          title: t("media.notInterested.hidden", { title }),
          variant: "success",
          action: { label: t("media.undo"), onClick: () => void undo() },
        });
        router.refresh();
      } else {
        const data = await res.json().catch(() => ({}));
        toast({ title: data.error ?? t("media.notInterested.failed"), variant: "error" });
      }
    } catch {
      toast({ title: t("media.networkError"), variant: "error" });
    } finally {
      setLoading(false);
    }
  }

  return (
    <button
      type="button"
      onClick={hide}
      disabled={loading}
      aria-label={t("media.notInterested.label", { title })}
      title={t("media.notInterested.title")}
      className="ds-tap ds-hover-tint relative inline-flex items-center justify-center"
      style={{
        width: 26,
        height: 26,
        borderRadius: 6,
        background: "color-mix(in oklab, var(--ds-bg-inset) 80%, transparent)",
        backdropFilter: "blur(6px)",
        border: "1px solid var(--ds-border)",
        color: "var(--ds-fg-muted)",
        cursor: loading ? "progress" : undefined,
      }}
    >
      {/* Extends the hit area to 36×36 while the visual stays 26px: this is
          always visible on touch (see the overlay wrapper in media-card.tsx),
          where 26px is under the platform minimum. A tap on the span targets
          the button. */}
      <span aria-hidden="true" style={{ position: "absolute", inset: -5 }} />
      {loading ? (
        <Loader2 className="animate-spin" style={{ width: 13, height: 13 }} />
      ) : (
        <EyeOff style={{ width: 13, height: 13 }} />
      )}
    </button>
  );
}
