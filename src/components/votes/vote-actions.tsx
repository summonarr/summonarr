"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { ThumbsUp, Trash2, Loader2 } from "lucide-react";

interface Props {
  tmdbId: number;
  mediaType: "MOVIE" | "TV";
  userVoted: boolean;
  isAdmin: boolean;
}

export function VoteActions({ tmdbId, mediaType, userVoted, isAdmin }: Props) {
  const router = useRouter();
  const [loading, setLoading] = useState(false);

  const [voted, setVoted] = useState(userVoted);
  const [dismissed, setDismissed] = useState(false);

  async function handleUnvote() {
    if (loading) return;
    setLoading(true);
    setVoted(false);
    try {
      const res = await fetch(`/api/votes/${tmdbId}?mediaType=${mediaType}`, { method: "DELETE" });
      if (res.ok) router.refresh();
      else setVoted(true);
    } catch {
      setVoted(true);
    } finally {
      setLoading(false);
    }
  }

  async function handleDismiss() {
    if (loading) return;
    if (!confirm("Dismiss all votes for this item?")) return;
    setLoading(true);
    setDismissed(true);
    try {
      const res = await fetch(`/api/votes/${tmdbId}?mediaType=${mediaType}`, { method: "PATCH" });
      if (res.ok) router.refresh();
      else setDismissed(false);
    } catch {
      setDismissed(false);
    } finally {
      setLoading(false);
    }
  }

  if (dismissed) return null;

  return (
    <div className="flex flex-col gap-2 shrink-0">
      {voted && (
        <button
          onClick={handleUnvote}
          disabled={loading}
          className="flex items-center gap-1.5 text-xs px-3 py-1.5 rounded-lg border border-indigo-500/50 bg-indigo-600/20 text-indigo-300 hover:bg-indigo-600/30 transition-colors disabled:opacity-50"
        >
          {loading ? <Loader2 className="w-3 h-3 animate-spin" /> : <ThumbsUp className="w-3 h-3" />}
          Voted
        </button>
      )}
      {isAdmin && (
        <button
          onClick={handleDismiss}
          disabled={loading}
          className="flex items-center gap-1.5 text-xs px-3 py-1.5 rounded-lg border border-red-500/50 bg-red-600/10 text-red-400 hover:bg-red-600/20 transition-colors disabled:opacity-50"
        >
          {loading ? <Loader2 className="w-3 h-3 animate-spin" /> : <Trash2 className="w-3 h-3" />}
          Dismiss
        </button>
      )}
    </div>
  );
}
