"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { ThumbsUp, Trash2, Loader2 } from "@/components/icons";
import { withBasePath } from "@/lib/base-path";
import { useToast } from "@/components/ui/toast";

interface Props {
  tmdbId: number;
  mediaType: "MOVIE" | "TV";
  userVoted: boolean;
  isAdmin: boolean;
}

export function VoteActions({ tmdbId, mediaType, userVoted, isAdmin }: Props) {
  const router = useRouter();
  const { toast } = useToast();
  // Which action is in flight: both buttons disable, only the clicked one spins.
  const [pending, setPending] = useState<"unvote" | "dismiss" | null>(null);
  const loading = pending !== null;

  const [voted, setVoted] = useState(userVoted);
  const [dismissed, setDismissed] = useState(false);
  const [confirmingDismiss, setConfirmingDismiss] = useState(false);

  async function handleUnvote() {
    if (loading) return;
    setPending("unvote");
    setVoted(false);
    try {
      const res = await fetch(withBasePath(`/api/votes/${tmdbId}?mediaType=${mediaType}`), { method: "DELETE" });
      if (res.ok) {
        toast({ title: "Vote removed", variant: "success" });
        router.refresh();
      } else {
        setVoted(true);
        toast({ title: "Couldn't remove your vote", variant: "error" });
      }
    } catch {
      setVoted(true);
      toast({ title: "Couldn't remove your vote", variant: "error" });
    } finally {
      setPending(null);
    }
  }

  async function handleDismiss() {
    if (loading) return;
    setPending("dismiss");
    setDismissed(true);
    setConfirmingDismiss(false);
    try {
      const res = await fetch(withBasePath(`/api/votes/${tmdbId}?mediaType=${mediaType}`), { method: "PATCH" });
      if (res.ok) {
        toast({ title: "Votes dismissed", variant: "success" });
        router.refresh();
      } else {
        setDismissed(false);
        toast({ title: "Couldn't dismiss the votes", variant: "error" });
      }
    } catch {
      setDismissed(false);
      toast({ title: "Couldn't dismiss the votes", variant: "error" });
    } finally {
      setPending(null);
    }
  }

  if (dismissed) return null;
  // Nothing to render: an empty basis-full wrapper would still claim its own
  // flex-wrap line (plus the row gap) under every non-admin, unvoted row.
  if (!voted && !isAdmin) return null;

  // Below `sm` the actions take a full row under the text column (the row is
  // flex-wrap) — at 375px the confirm state (~180px) otherwise crushed the title.
  return (
    <div className="flex flex-row flex-wrap gap-2 basis-full sm:basis-auto sm:flex-col sm:shrink-0">
      {voted && (
        <button
          onClick={handleUnvote}
          disabled={loading}
          className="flex items-center gap-1.5 text-xs px-3 py-1.5 rounded-lg border border-indigo-500/50 bg-indigo-600/20 text-indigo-300 hover:bg-indigo-600/30 transition-colors disabled:opacity-50"
        >
          {pending === "unvote" ? <Loader2 className="w-3 h-3 animate-spin" /> : <ThumbsUp className="w-3 h-3" />}
          Voted
        </button>
      )}
      {isAdmin && !confirmingDismiss && (
        <button
          onClick={() => setConfirmingDismiss(true)}
          disabled={loading}
          className="flex items-center gap-1.5 text-xs px-3 py-1.5 rounded-lg border border-red-500/50 bg-red-600/10 text-red-400 hover:bg-red-600/20 transition-colors disabled:opacity-50"
        >
          {pending === "dismiss" ? <Loader2 className="w-3 h-3 animate-spin" /> : <Trash2 className="w-3 h-3" />}
          Dismiss
        </button>
      )}
      {isAdmin && confirmingDismiss && (
        <div className="flex items-center gap-1.5">
          <button
            onClick={handleDismiss}
            disabled={loading}
            className="flex items-center gap-1.5 text-xs px-3 py-1.5 rounded-lg bg-red-600 text-[var(--ds-on-status)] hover:bg-[var(--ds-danger-hover)] transition-colors disabled:opacity-50"
            autoFocus
          >
            {pending === "dismiss" ? <Loader2 className="w-3 h-3 animate-spin" /> : <Trash2 className="w-3 h-3" />}
            Confirm dismiss
          </button>
          <button
            onClick={() => setConfirmingDismiss(false)}
            disabled={loading}
            className="text-xs px-2 py-1.5 text-zinc-400 hover:text-zinc-100 transition-colors"
          >
            Cancel
          </button>
        </div>
      )}
    </div>
  );
}
