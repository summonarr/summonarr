"use client";

import { useState } from "react";
import {
  Plus,
  Check,
  Loader2,
  PlayCircle,
  Tv2,
  Clock,
  MessageSquare,
  X,
  ExternalLink,
  AlertCircle,
} from "lucide-react";
import Link from "next/link";

type State =
  | "idle"
  | "confirm"
  | "note"
  | "loading"
  | "requested"
  | "duplicate"
  | "error";

interface RequestButtonProps {
  tmdbId: number;
  mediaType: "MOVIE" | "TV";
  title: string;
  posterPath?: string | null;
  releaseYear?: string;
  plexAvailable?: boolean;
  jellyfinAvailable?: boolean;
  arrPending?: boolean;
  requested?: boolean;
  showPlex?: boolean;
  showJellyfin?: boolean;

  // CSRF token generated server-side; the API rejects mutation requests that lack it
  requestToken?: string;
}

const btnBase: React.CSSProperties = {
  display: "inline-flex",
  alignItems: "center",
  justifyContent: "center",
  gap: 6,
  padding: "6px 14px",
  height: 34,
  borderRadius: 6,
  fontSize: 13,
  fontWeight: 500,
  transition: "background 120ms var(--ds-ease), border-color 120ms var(--ds-ease)",
  cursor: "pointer",
  whiteSpace: "nowrap",
};

const primaryStyle: React.CSSProperties = {
  ...btnBase,
  background: "var(--ds-accent)",
  color: "var(--ds-accent-fg)",
  border: "1px solid transparent",
};

const secondaryStyle: React.CSSProperties = {
  ...btnBase,
  background: "var(--ds-bg-2)",
  color: "var(--ds-fg)",
  border: "1px solid var(--ds-border)",
};

const ghostStyle: React.CSSProperties = {
  ...btnBase,
  background: "transparent",
  color: "var(--ds-fg-muted)",
  border: "1px solid var(--ds-border)",
};

export function RequestButton({
  tmdbId,
  mediaType,
  title,
  plexAvailable,
  jellyfinAvailable,
  arrPending,
  requested,
  showPlex = true,
  showJellyfin = true,
  requestToken,
}: RequestButtonProps) {
  const [state, setState] = useState<State>(requested ? "duplicate" : "idle");
  const [note, setNote] = useState("");
  const [errorMsg, setErrorMsg] = useState("");

  async function submitRequest() {
    setState("loading");
    setErrorMsg("");
    try {
      const res = await fetch("/api/requests", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          tmdbId,
          mediaType,
          ...(note.trim() ? { note: note.trim() } : {}),
          _token: requestToken,
        }),
      });
      if (res.status === 409) {
        setState("duplicate");
        return;
      }
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        setErrorMsg(data.error ?? "Something went wrong");
        setState("error");
        return;
      }
      setState("requested");
    } catch {
      setErrorMsg("Network error — please try again");
      setState("error");
    }
  }

  const isAvailable =
    (showPlex && plexAvailable) || (showJellyfin && jellyfinAvailable);
  const isDone = state === "requested" || state === "duplicate";
  const showViewRequest = isDone || arrPending;
  const label = mediaType === "MOVIE" ? "Movie" : "TV Show";

  return (
    <div className="flex flex-col gap-2">
      {showPlex && plexAvailable && (
        <div
          className="flex items-center font-medium"
          style={{ gap: 6, fontSize: 13, color: "var(--ds-plex)" }}
        >
          <PlayCircle style={{ width: 14, height: 14 }} />
          Available on Plex
        </div>
      )}
      {showJellyfin && jellyfinAvailable && (
        <div
          className="flex items-center font-medium"
          style={{ gap: 6, fontSize: 13, color: "var(--ds-jellyfin)" }}
        >
          <Tv2 style={{ width: 14, height: 14 }} />
          Available on Jellyfin
        </div>
      )}
      {arrPending && (
        <div
          className="flex items-center font-medium"
          style={{ gap: 6, fontSize: 13, color: "var(--ds-warning)" }}
        >
          <Clock style={{ width: 14, height: 14 }} />
          Approved — In Queue
        </div>
      )}

      {showViewRequest && (
        <Link
          href="/requests"
          style={{
            ...btnBase,
            background: "var(--ds-accent-soft)",
            color: "var(--ds-accent)",
            border: "1px solid var(--ds-accent-ring)",
            width: "fit-content",
          }}
        >
          <Check style={{ width: 14, height: 14 }} />
          View Request
          <ExternalLink style={{ width: 12, height: 12, opacity: 0.6 }} />
        </Link>
      )}

      {!isAvailable && !showViewRequest && (
        <>
          {state === "confirm" && (
            <div className="flex flex-col gap-2 w-full max-w-sm">
              <div
                className="flex items-center"
                style={{
                  gap: 8,
                  padding: "10px 12px",
                  borderRadius: 8,
                  border: "1px solid var(--ds-border)",
                  background: "var(--ds-bg-2)",
                }}
              >
                <AlertCircle
                  className="shrink-0"
                  style={{ width: 14, height: 14, color: "var(--ds-accent)" }}
                />
                <p style={{ fontSize: 13, color: "var(--ds-fg)", margin: 0 }}>
                  Request{" "}
                  <span className="font-semibold">{title}</span>?
                </p>
              </div>
              <div className="flex items-center gap-2">
                <button type="button" onClick={submitRequest} style={primaryStyle}>
                  <Check style={{ width: 14, height: 14 }} />
                  Confirm
                </button>
                <button
                  type="button"
                  onClick={() => setState("idle")}
                  style={ghostStyle}
                >
                  <X style={{ width: 14, height: 14 }} />
                  Cancel
                </button>
              </div>
            </div>
          )}

          {state === "note" && (
            <div className="flex flex-col gap-2 w-full max-w-sm">
              <textarea
                value={note}
                onChange={(e) => setNote(e.target.value.slice(0, 500))}
                placeholder="Add a note for the admin (optional)"
                rows={3}
                autoFocus
                className="w-full resize-none focus:outline-none"
                style={{
                  padding: "8px 12px",
                  fontSize: 13,
                  color: "var(--ds-fg)",
                  background: "var(--ds-bg-1)",
                  border: "1px solid var(--ds-border)",
                  borderRadius: 6,
                }}
              />
              <div className="flex items-center gap-2">
                <button type="button" onClick={submitRequest} style={primaryStyle}>
                  <Plus style={{ width: 14, height: 14 }} />
                  Request {label}
                </button>
                <button
                  type="button"
                  onClick={() => {
                    setState("idle");
                    setNote("");
                  }}
                  style={ghostStyle}
                >
                  <X style={{ width: 14, height: 14 }} />
                  Cancel
                </button>
              </div>
              <p
                className="ds-mono"
                style={{
                  fontSize: 10.5,
                  color: "var(--ds-fg-subtle)",
                  margin: 0,
                }}
              >
                {note.length}/500
              </p>
            </div>
          )}

          {state !== "note" && state !== "confirm" && (
            <div className="flex items-center gap-2 flex-wrap">
              <button
                type="button"
                onClick={() => setState("confirm")}
                disabled={state === "loading"}
                style={{
                  ...primaryStyle,
                  opacity: state === "loading" ? 0.7 : 1,
                  cursor: state === "loading" ? "progress" : "pointer",
                }}
              >
                {state === "loading" ? (
                  <Loader2
                    className="animate-spin"
                    style={{ width: 14, height: 14 }}
                  />
                ) : (
                  <Plus style={{ width: 14, height: 14 }} />
                )}
                {state === "loading" ? "Submitting..." : `Request ${label}`}
              </button>

              {(state === "idle" || state === "error") && (
                <button
                  type="button"
                  onClick={() => setState("note")}
                  title="Add a note to your request"
                  style={secondaryStyle}
                >
                  <MessageSquare style={{ width: 14, height: 14 }} />
                  Add note
                </button>
              )}
            </div>
          )}

          {state === "error" && (
            <p
              className="ds-mono"
              style={{ fontSize: 11, color: "var(--ds-danger)", margin: 0 }}
            >
              {errorMsg}
            </p>
          )}
        </>
      )}
    </div>
  );
}
