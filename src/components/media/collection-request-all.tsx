"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Plus, Check, Loader2 } from "@/components/icons";
import type { TmdbMedia } from "@/lib/tmdb-types";
import { withBasePath } from "@/lib/base-path";

// "Request all (N missing)" for a TMDB collection. The items arrive already
// enriched with availability flags (attachAllAvailability ran upstream), so the
// missing set is computed here; the server re-checks authoritatively.
export function CollectionRequestAllButton({
  items,
  canRequest = true,
}: {
  items: TmdbMedia[];
  canRequest?: boolean;
}) {
  const router = useRouter();
  const [state, setState] = useState<"idle" | "loading" | "done" | "error">("idle");
  const [msg, setMsg] = useState("");

  // Excludes only library items, the CALLER's own requests, and blacklisted
  // titles. Items queued/requested by other users are included on purpose: the
  // bulk route mirrors their approved status so this user is tracked for the
  // "now available" notification.
  const missing = items.filter(
    (m) => !m.plexAvailable && !m.jellyfinAvailable && !m.requestedByMe && !m.blacklisted,
  );

  if (!canRequest || missing.length === 0) return null;

  async function requestAll() {
    setState("loading");
    setMsg("");
    try {
      const res = await fetch(withBasePath("/api/requests/bulk"), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          items: missing.map((m) => ({
            tmdbId: m.id,
            mediaType: m.mediaType === "movie" ? "MOVIE" : "TV",
          })),
        }),
      });
      const data: { created?: number; error?: string } = await res.json().catch(() => ({}));
      if (!res.ok) {
        setMsg(data.error ?? "Something went wrong");
        setState("error");
        return;
      }
      setMsg(`Requested ${data.created ?? 0} of ${missing.length}`);
      setState("done");
      router.refresh();
    } catch {
      setMsg("Network error — please try again");
      setState("error");
    }
  }

  return (
    <div className="flex items-center gap-2">
      <button
        type="button"
        onClick={requestAll}
        disabled={state === "loading" || state === "done"}
        className="inline-flex items-center gap-1.5 rounded-md px-3 h-8 text-xs font-medium transition-colors disabled:opacity-70"
        style={{
          background: state === "done" ? "var(--ds-accent-soft)" : "var(--ds-accent)",
          color: state === "done" ? "var(--ds-accent)" : "var(--ds-accent-fg)",
          border: "1px solid transparent",
          cursor: state === "loading" ? "progress" : state === "done" ? "default" : "pointer",
        }}
      >
        {state === "loading" ? (
          <Loader2 className="animate-spin" style={{ width: 13, height: 13 }} />
        ) : state === "done" ? (
          <Check style={{ width: 13, height: 13 }} />
        ) : (
          <Plus style={{ width: 13, height: 13 }} />
        )}
        {state === "done" ? "Requested" : `Request all (${missing.length})`}
      </button>
      {(state === "done" || state === "error") && msg && (
        <span
          className="ds-mono"
          style={{ fontSize: 11, color: state === "error" ? "var(--ds-danger)" : "var(--ds-fg-subtle)" }}
        >
          {msg}
        </span>
      )}
    </div>
  );
}
