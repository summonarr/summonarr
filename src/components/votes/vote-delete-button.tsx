"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Trash2, Loader2, Check } from "lucide-react";

interface Props {
  tmdbId: number;
  mediaType: "MOVIE" | "TV";
  requestToken: string;
  alreadyVoted: boolean;
}

export function VoteDeleteButton({ tmdbId, mediaType, requestToken, alreadyVoted }: Props) {
  const router = useRouter();
  const [state, setState] = useState<"idle" | "reason" | "loading" | "voted">(alreadyVoted ? "voted" : "idle");
  const [reason, setReason] = useState("");

  async function handleVote() {

    setState("voted");
    try {
      const res = await fetch("/api/votes", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ tmdbId, mediaType, reason: reason.trim() || undefined, _token: requestToken }),
      });
      if (res.ok || res.status === 409) {
        router.refresh();
      } else {
        setState("idle");
      }
    } catch {
      setState("idle");
    }
  }

  async function handleUnvote() {

    setState("idle");
    try {
      const res = await fetch(`/api/votes/${tmdbId}?mediaType=${mediaType}`, { method: "DELETE" });
      if (res.ok) {
        router.refresh();
      } else {
        setState("voted");
      }
    } catch {
      setState("voted");
    }
  }

  if (state === "voted") {
    return (
      <button
        onClick={handleUnvote}
        className="flex items-center gap-1.5 text-sm px-3 py-1.5 rounded-lg border border-red-500/50 bg-red-600/20 text-red-300 hover:bg-red-600/30 transition-colors"
      >
        <Check className="w-4 h-4" />
        Voted to Delete
      </button>
    );
  }

  if (state === "reason") {
    return (
      <div className="flex items-center gap-2">
        <input
          type="text"
          value={reason}
          onChange={(e) => setReason(e.target.value.slice(0, 200))}
          placeholder="Reason (optional)"
          className="text-sm px-2 py-1.5 rounded-lg border border-zinc-700 bg-zinc-800 text-white focus:outline-none focus:ring-2 focus:ring-red-500 w-48"
          autoFocus
          onKeyDown={(e) => { if (e.key === "Enter") handleVote(); if (e.key === "Escape") setState("idle"); }}
        />
        <button
          onClick={handleVote}
          className="text-sm px-3 py-1.5 rounded-lg bg-red-600 text-white hover:bg-red-500 transition-colors"
        >
          Vote
        </button>
        <button
          onClick={() => setState("idle")}
          className="text-sm px-2 py-1.5 text-zinc-400 hover:text-white transition-colors"
        >
          Cancel
        </button>
      </div>
    );
  }

  if (state === "loading") {
    return (
      <button disabled className="flex items-center gap-1.5 text-sm px-3 py-1.5 rounded-lg border border-zinc-700 bg-zinc-800 text-zinc-400">
        <Loader2 className="w-4 h-4 animate-spin" />
      </button>
    );
  }

  return (
    <button
      onClick={() => setState("reason")}
      className="flex items-center gap-1.5 text-sm px-3 py-1.5 rounded-lg border border-zinc-700 bg-zinc-800 text-zinc-400 hover:text-red-300 hover:border-red-500/50 transition-colors"
    >
      <Trash2 className="w-4 h-4" />
      Vote to Delete
    </button>
  );
}
