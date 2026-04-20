"use client";

import { useState } from "react";
import { Plus, Check, Loader2, PlayCircle, Tv2, Clock, MessageSquare, X, ExternalLink, AlertCircle } from "lucide-react";
import { Button } from "@/components/ui/button";
import Link from "next/link";

type State = "idle" | "confirm" | "note" | "loading" | "requested" | "duplicate" | "error";

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

export function RequestButton({
  tmdbId,
  mediaType,
  title,
  posterPath,
  releaseYear,
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
          tmdbId, mediaType,
          ...(note.trim() ? { note: note.trim() } : {}),
          _token: requestToken,
        }),
      });
      if (res.status === 409) { setState("duplicate"); return; }
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

  // Three distinct tiers: library available → approved/queued → requested/not yet → not requested
  const isAvailable = (showPlex && plexAvailable) || (showJellyfin && jellyfinAvailable);
  const isDone = state === "requested" || state === "duplicate";
  const showViewRequest = isDone || arrPending;
  const label = mediaType === "MOVIE" ? "Movie" : "TV Show";

  return (
    <div className="flex flex-col gap-2">
      {showPlex && plexAvailable && (
        <div className="flex items-center gap-1.5 text-sm font-medium text-[#e5a00d]">
          <PlayCircle className="w-4 h-4" />
          Available on Plex
        </div>
      )}
      {showJellyfin && jellyfinAvailable && (
        <div className="flex items-center gap-1.5 text-sm font-medium text-[#00a4dc]">
          <Tv2 className="w-4 h-4" />
          Available on Jellyfin
        </div>
      )}
      {arrPending && (
        <div className="flex items-center gap-1.5 text-sm font-medium text-orange-400">
          <Clock className="w-4 h-4" />
          Approved — In Queue
        </div>
      )}

      {showViewRequest && (
        <Link href="/requests">
          <Button
            variant="outline"
            className="gap-2 border-indigo-500/50 text-indigo-400 hover:text-indigo-300 hover:border-indigo-400"
          >
            <Check className="w-4 h-4" />
            View Request
            <ExternalLink className="w-3.5 h-3.5 opacity-60" />
          </Button>
        </Link>
      )}

      {!isAvailable && !showViewRequest && (
        <>
          {state === "confirm" && (
            <div className="flex flex-col gap-2 w-full max-w-sm">
              <div className="flex items-center gap-2 rounded-lg border border-zinc-700 bg-zinc-800/60 px-3 py-2.5">
                <AlertCircle className="w-4 h-4 text-indigo-400 shrink-0" />
                <p className="text-sm text-zinc-200">
                  Request <span className="font-semibold text-white">{title}</span>?
                </p>
              </div>
              <div className="flex items-center gap-2">
                <Button onClick={submitRequest} className="gap-2 bg-indigo-600 hover:bg-indigo-500">
                  <Check className="w-4 h-4" />
                  Confirm
                </Button>
                <Button
                  variant="outline"
                  onClick={() => setState("idle")}
                  className="gap-1 border-zinc-700 text-zinc-400 hover:text-white"
                >
                  <X className="w-4 h-4" />
                  Cancel
                </Button>
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
                className="w-full rounded-lg border border-zinc-700 bg-zinc-800 px-3 py-2 text-sm text-white placeholder-zinc-500 focus:outline-none focus:ring-2 focus:ring-indigo-500 resize-none"
              />
              <div className="flex items-center gap-2">
                <Button onClick={submitRequest} className="gap-2 bg-indigo-600 hover:bg-indigo-500">
                  <Plus className="w-4 h-4" />
                  Request {label}
                </Button>
                <Button
                  variant="outline"
                  onClick={() => { setState("idle"); setNote(""); }}
                  className="gap-1 border-zinc-700 text-zinc-400 hover:text-white"
                >
                  <X className="w-4 h-4" />
                  Cancel
                </Button>
              </div>
              <p className="text-[11px] text-zinc-600">{note.length}/500</p>
            </div>
          )}

          {state !== "note" && state !== "confirm" && (
            <div className="flex items-center gap-2 flex-wrap">
              <Button
                onClick={() => setState("confirm")}
                disabled={state === "loading"}
                className="w-fit gap-2 bg-indigo-600 hover:bg-indigo-500"
              >
                {state === "loading" && <Loader2 className="w-4 h-4 animate-spin" />}
                {state !== "loading" && <Plus className="w-4 h-4" />}
                {state === "loading" ? "Submitting..." : `Request ${label}`}
              </Button>

              {(state === "idle" || state === "error") && (
                <Button
                  variant="outline"
                  onClick={() => setState("note")}
                  className="gap-1.5 border-zinc-700 text-zinc-400 hover:text-white"
                  title="Add a note to your request"
                >
                  <MessageSquare className="w-4 h-4" />
                  Add note
                </Button>
              )}
            </div>
          )}

          {state === "error" && (
            <p className="text-xs text-red-400">{errorMsg}</p>
          )}
        </>
      )}
    </div>
  );
}
