"use client";

import { useState } from "react";
import { EyeOff, Loader2 } from "@/components/icons";
import { withBasePath } from "@/lib/base-path";

// "Not interested" toggle on movie/TV detail pages. Hidden titles are removed from
// the user's discovery lists (attachAllAvailability filters them). Optimistic with
// rollback, mirroring the watchlist/request buttons.
export function HideButton({
  tmdbId,
  mediaType,
  title,
  posterPath,
  initialHidden,
}: {
  tmdbId: number;
  mediaType: "MOVIE" | "TV";
  title: string;
  posterPath?: string | null;
  initialHidden: boolean;
}) {
  const [hidden, setHidden] = useState(initialHidden);
  const [loading, setLoading] = useState(false);
  const [msg, setMsg] = useState("");

  async function toggle() {
    if (loading) return;
    const next = !hidden;
    setHidden(next); // optimistic
    setLoading(true);
    setMsg("");
    try {
      const res = next
        ? await fetch(withBasePath("/api/hidden"), {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ tmdbId, mediaType, title, posterPath }),
          })
        : await fetch(withBasePath(`/api/hidden?tmdbId=${tmdbId}&mediaType=${mediaType}`), {
            method: "DELETE",
          });
      // 409 on hide means it's already hidden — desired end state is still "hidden".
      if (!res.ok && res.status !== 409) {
        const data = await res.json().catch(() => ({}));
        setHidden(!next); // rollback
        setMsg(data.error ?? "Something went wrong");
      }
    } catch {
      setHidden(!next); // rollback
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
        aria-pressed={hidden}
        aria-label={hidden ? "Show in discovery again" : "Hide from my discovery"}
        title={hidden ? "Hidden from your discovery — click to un-hide" : "Not interested — hide from your discovery"}
        style={{
          ...base,
          background: hidden ? "var(--ds-bg-3)" : "var(--ds-bg-2)",
          color: hidden ? "var(--ds-fg-muted)" : "var(--ds-fg)",
          border: "1px solid var(--ds-border)",
        }}
      >
        {loading ? (
          <Loader2 className="animate-spin" style={{ width: 14, height: 14 }} />
        ) : (
          <EyeOff style={{ width: 14, height: 14 }} />
        )}
        {hidden ? "Hidden" : "Not interested"}
      </button>
      {msg && (
        <span className="ds-mono" style={{ fontSize: 11, color: "var(--ds-danger)" }}>
          {msg}
        </span>
      )}
    </div>
  );
}
