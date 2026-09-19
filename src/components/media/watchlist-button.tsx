"use client";

import { useState } from "react";
import { Bookmark, BookmarkCheck, Loader2 } from "@/components/icons";
import { withBasePath } from "@/lib/base-path";
import { useToast } from "@/components/ui/toast";
import { DetailActionButton } from "./detail-action-button";

// "Add to Watchlist" toggle for movie/TV detail pages. Personal save-for-later,
// independent of availability or request permissions. Optimistic with rollback
// on error, mirroring the request buttons' UX.
export function WatchlistButton({
  tmdbId,
  mediaType,
  initialOnWatchlist,
}: {
  tmdbId: number;
  mediaType: "MOVIE" | "TV";
  initialOnWatchlist: boolean;
}) {
  const { toast } = useToast();
  const [on, setOn] = useState(initialOnWatchlist);
  const [loading, setLoading] = useState(false);
  const [msg, setMsg] = useState("");

  async function toggle() {
    if (loading) return;
    const next = !on;
    setOn(next); // optimistic
    setLoading(true);
    setMsg("");
    try {
      const res = next
        ? await fetch(withBasePath("/api/watchlist"), {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ tmdbId, mediaType }),
          })
        : await fetch(withBasePath(`/api/watchlist?tmdbId=${tmdbId}&mediaType=${mediaType}`), {
            method: "DELETE",
          });
      // 409 on add means it's already there — the desired end state is still "on".
      if (!res.ok && res.status !== 409) {
        const data = await res.json().catch(() => ({}));
        setOn(!next); // rollback
        setMsg(data.error ?? "Something went wrong");
      } else {
        toast({ title: next ? "Added to watchlist" : "Removed from watchlist", variant: "success" });
      }
    } catch {
      setOn(!next); // rollback
      setMsg("Network error — please try again");
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="flex items-center gap-2">
      <DetailActionButton
        variant={on ? "accent-soft" : "secondary"}
        onClick={toggle}
        disabled={loading}
        busy={loading}
        aria-pressed={on}
        aria-label={on ? "Remove from watchlist" : "Add to watchlist"}
      >
        {loading ? (
          <Loader2 className="animate-spin" style={{ width: 14, height: 14 }} />
        ) : on ? (
          <BookmarkCheck style={{ width: 14, height: 14 }} />
        ) : (
          <Bookmark style={{ width: 14, height: 14 }} />
        )}
        {on ? "On Watchlist" : "Add to Watchlist"}
      </DetailActionButton>
      {msg && (
        <span className="ds-mono" style={{ fontSize: 11, color: "var(--ds-danger)" }}>
          {msg}
        </span>
      )}
    </div>
  );
}
