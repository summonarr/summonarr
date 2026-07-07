"use client";

import { useState } from "react";
import { Bookmark, BookmarkCheck, Loader2 } from "@/components/icons";
import { withBasePath } from "@/lib/base-path";

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
      }
    } catch {
      setOn(!next); // rollback
      setMsg("Network error — please try again");
    } finally {
      setLoading(false);
    }
  }

  const base: React.CSSProperties = {
    display: "inline-flex",
    alignItems: "center",
    justifyContent: "center",
    gap: 6,
    padding: "6px 14px",
    height: 34,
    borderRadius: 6,
    fontSize: 13,
    fontWeight: 500,
    whiteSpace: "nowrap",
    cursor: loading ? "progress" : "pointer",
  };

  return (
    <div className="flex items-center gap-2">
      <button
        type="button"
        onClick={toggle}
        disabled={loading}
        aria-pressed={on}
        aria-label={on ? "Remove from watchlist" : "Add to watchlist"}
        style={
          on
            ? { ...base, background: "var(--ds-accent-soft)", color: "var(--ds-accent)", border: "1px solid var(--ds-accent-ring)" }
            : { ...base, background: "var(--ds-bg-2)", color: "var(--ds-fg)", border: "1px solid var(--ds-border)" }
        }
      >
        {loading ? (
          <Loader2 className="animate-spin" style={{ width: 14, height: 14 }} />
        ) : on ? (
          <BookmarkCheck style={{ width: 14, height: 14 }} />
        ) : (
          <Bookmark style={{ width: 14, height: 14 }} />
        )}
        {on ? "On Watchlist" : "Watchlist"}
      </button>
      {msg && (
        <span className="ds-mono" style={{ fontSize: 11, color: "var(--ds-danger)" }}>
          {msg}
        </span>
      )}
    </div>
  );
}
