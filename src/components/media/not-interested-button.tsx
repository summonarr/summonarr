"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { EyeOff, Loader2 } from "@/components/icons";
import { withBasePath } from "@/lib/base-path";
import { useToast } from "@/components/ui/toast";

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
  const [loading, setLoading] = useState(false);

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
        toast({ title: `Hidden — "${title}" won't be suggested again`, variant: "success" });
        router.refresh();
      } else {
        const data = await res.json().catch(() => ({}));
        toast({ title: data.error ?? "Couldn't hide that — try again", variant: "error" });
      }
    } catch {
      toast({ title: "Network error — please try again", variant: "error" });
    } finally {
      setLoading(false);
    }
  }

  return (
    <button
      type="button"
      onClick={hide}
      disabled={loading}
      aria-label={`Not interested in ${title}`}
      title="Not interested — stop suggesting this"
      className="ds-tap inline-flex items-center justify-center transition-opacity"
      style={{
        width: 26,
        height: 26,
        borderRadius: 6,
        background: "color-mix(in oklab, var(--ds-bg-inset) 80%, transparent)",
        backdropFilter: "blur(6px)",
        border: "1px solid var(--ds-border)",
        color: "var(--ds-fg-muted)",
        cursor: loading ? "progress" : "pointer",
      }}
    >
      {loading ? (
        <Loader2 className="animate-spin" style={{ width: 13, height: 13 }} />
      ) : (
        <EyeOff style={{ width: 13, height: 13 }} />
      )}
    </button>
  );
}
