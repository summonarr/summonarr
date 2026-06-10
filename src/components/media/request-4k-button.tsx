"use client";

import { useState } from "react";
import { Plus, Check, Loader2 } from "@/components/icons";

// Secondary "Request in 4K" action shown on movie/TV detail pages when a 4K
// Radarr/Sonarr instance is configured and the viewer holds REQUEST_4K. Posts to
// the single request route with is4k:true; the server re-checks permission + that
// a 4K instance exists. Kept separate from RequestButton so the HD and 4K request
// states don't entangle.
export function Request4kButton({
  tmdbId,
  mediaType,
  requestToken,
  requested,
  available,
}: {
  tmdbId: number;
  mediaType: "MOVIE" | "TV";
  requestToken?: string;
  requested?: boolean;
  // The 4K instance already has the file — show an "Available in 4K" state instead of a CTA.
  available?: boolean;
}) {
  const [state, setState] = useState<"idle" | "loading" | "requested" | "error">(
    requested ? "requested" : "idle",
  );
  const [msg, setMsg] = useState("");

  async function submit() {
    setState("loading");
    setMsg("");
    try {
      const res = await fetch("/api/requests", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ tmdbId, mediaType, is4k: true, _token: requestToken }),
      });
      if (res.status === 409) {
        setState("requested");
        return;
      }
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        setMsg(data.error ?? "Something went wrong");
        setState("error");
        return;
      }
      setState("requested");
    } catch {
      setMsg("Network error — please try again");
      setState("error");
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
  };

  // Availability wins over request state — once the 4K copy is fetched there's nothing to request.
  if (available) {
    return (
      <span
        style={{
          ...base,
          background: "var(--ds-accent-soft)",
          color: "var(--ds-accent)",
          border: "1px solid var(--ds-accent-ring)",
        }}
      >
        <Check style={{ width: 14, height: 14 }} />
        Available in 4K
      </span>
    );
  }

  if (state === "requested") {
    return (
      <span
        style={{
          ...base,
          background: "var(--ds-accent-soft)",
          color: "var(--ds-accent)",
          border: "1px solid var(--ds-accent-ring)",
        }}
      >
        <Check style={{ width: 14, height: 14 }} />
        4K Requested
      </span>
    );
  }

  return (
    <div className="flex items-center gap-2">
      <button
        type="button"
        onClick={submit}
        disabled={state === "loading"}
        style={{
          ...base,
          background: "var(--ds-bg-2)",
          color: "var(--ds-fg)",
          border: "1px solid var(--ds-border)",
          cursor: state === "loading" ? "progress" : "pointer",
        }}
      >
        {state === "loading" ? (
          <Loader2 className="animate-spin" style={{ width: 14, height: 14 }} />
        ) : (
          <Plus style={{ width: 14, height: 14 }} />
        )}
        Request in 4K
      </button>
      {state === "error" && msg && (
        <span className="ds-mono" style={{ fontSize: 11, color: "var(--ds-danger)" }}>
          {msg}
        </span>
      )}
    </div>
  );
}
