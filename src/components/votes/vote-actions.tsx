"use client";

import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { ThumbsUp, Trash2, Loader2 } from "@/components/icons";
import { useToast } from "@/components/ui/toast";
import { useT } from "@/components/i18n/i18n-provider";
import { writeDeletionVote } from "@/lib/client/vote-write";
import { useAsyncAction } from "@/hooks/use-async-action";

interface Props {
  tmdbId: number;
  mediaType: "MOVIE" | "TV";
  userVoted: boolean;
  isAdmin: boolean;
}

export function VoteActions({ tmdbId, mediaType, userVoted, isAdmin }: Props) {
  const router = useRouter();
  const { toast } = useToast();
  const t = useT();
  const action = useAsyncAction();
  // Which action is in flight: both buttons disable. The dismiss confirm spins
  // until the PATCH answers; an unvote hides its own button at once.
  const [pending, setPending] = useState<"unvote" | "dismiss" | null>(null);
  const loading = pending !== null;

  // `userVoted` is live: the rows are keyed by title, so a router.refresh()
  // (after another row's action, or a vote cast in another tab) re-renders
  // this instance with the server's answer. `override` is this row's own
  // optimistic state, dropped once the prop moves and nothing is in flight.
  const [override, setOverride] = useState<boolean | null>(null);
  const [seenUserVoted, setSeenUserVoted] = useState(userVoted);
  if (userVoted !== seenUserVoted && !loading) {
    setSeenUserVoted(userVoted);
    setOverride(null);
  }
  const voted = override ?? userVoted;
  const [dismissed, setDismissed] = useState(false);
  const [confirmingDismiss, setConfirmingDismiss] = useState(false);
  // Set when the confirm step closes by a user action (Cancel, Escape): the
  // Dismiss button it gave way to takes focus back (autoFocus acts on mount).
  const [refocusDismiss, setRefocusDismiss] = useState(false);
  // A non-admin's row loses its only control the moment an unvote starts;
  // focus moves to a hidden status note in its place instead of to <body>,
  // and back to the Voted button if the unvote fails.
  const [removedHere, setRemovedHere] = useState(false);
  const [refocusVoted, setRefocusVoted] = useState(false);
  const removedNoteRef = useRef<HTMLSpanElement>(null);
  const showRemovedNote = !voted && !isAdmin && (pending === "unvote" || removedHere);
  useEffect(() => {
    if (showRemovedNote) removedNoteRef.current?.focus();
  }, [showRemovedNote]);

  function cancelDismiss() {
    setConfirmingDismiss(false);
    setRefocusDismiss(true);
  }

  const send = (method: "DELETE" | "PATCH", okOn404: boolean, failed: string, signal: AbortSignal) =>
    writeDeletionVote({ method, tmdbId, mediaType, okOn404, failed, signal, t });

  async function handleUnvote() {
    if (action.busy("vote")) return;
    setPending("unvote");
    setOverride(false);
    setRefocusVoted(false);
    // 404: the vote is already gone (another tab, or an admin dismissed it),
    // which is what was asked. Rolling back to "Voted" left a control whose
    // every retry 404'd again.
    const out = await action.run("vote", (signal) => send("DELETE", true, t("personal.votes.removeFailed"), signal), { ifBusy: "skip" });
    setPending(null);
    if (!out) return;
    if (out.ok) {
      setRemovedHere(true);
      toast({ title: t("personal.votes.removed"), variant: "success" });
      router.refresh();
    } else {
      // Back to the PRE-CLICK state (voted), never the possibly stale prop.
      setOverride(true);
      setRefocusVoted(true);
      toast({ title: out.message, variant: "error" });
    }
  }

  async function handleDismiss() {
    if (action.busy("vote")) return;
    setPending("dismiss");
    const out = await action.run("vote", (signal) => send("PATCH", false, t("personal.votes.dismissFailed"), signal), { ifBusy: "skip" });
    setPending(null);
    if (!out) return;
    if (out.ok) {
      setDismissed(true);
      toast({ title: t("personal.votes.dismissed"), variant: "success" });
      router.refresh();
    } else {
      // The confirm button that had focus unmounts: hand focus to Dismiss.
      cancelDismiss();
      toast({ title: out.message, variant: "error" });
    }
  }

  if (dismissed) return null;
  // Nothing to render: an empty basis-full wrapper would still claim its own
  // flex-wrap line (plus the row gap) under every non-admin, unvoted row.
  if (!voted && !isAdmin) {
    // sr-only is absolutely positioned, so the note claims no flex line.
    return showRemovedNote ? (
      <span ref={removedNoteRef} tabIndex={-1} className="sr-only">
        {removedHere ? t("personal.votes.removed") : t("request.vote.updating")}
      </span>
    ) : null;
  }

  // Below `sm` the actions take a full row under the text column (the row is
  // flex-wrap) — at 375px the confirm state (~180px) otherwise crushed the title.
  return (
    <div className="flex flex-row flex-wrap gap-2 basis-full sm:basis-auto sm:flex-col sm:shrink-0">
      {voted && (
        <button
          onClick={handleUnvote}
          disabled={loading}
          autoFocus={refocusVoted}
          // Clicking removes the vote with no confirm, so say so (same hint as the
          // detail page's VoteDeleteButton). min-h matches the FilterPills' 32px
          // target in the same row; text-xs + py-1.5 alone was 28px.
          title={t("request.vote.removeTitle")}
          aria-label={t("request.vote.votedLabel")}
          className="flex items-center gap-1.5 min-h-[32px] text-xs px-3 py-1.5 rounded-lg border border-indigo-500/50 bg-indigo-600/20 text-indigo-300 hover:bg-indigo-600/30 transition-colors disabled:opacity-50"
        >
          <ThumbsUp className="w-3 h-3" />
          {t("personal.votes.voted")}
        </button>
      )}
      {isAdmin && !confirmingDismiss && (
        <button
          onClick={() => {
            setConfirmingDismiss(true);
            setRefocusDismiss(false);
          }}
          disabled={loading}
          autoFocus={refocusDismiss}
          className="flex items-center gap-1.5 min-h-[32px] text-xs px-3 py-1.5 rounded-lg border border-red-500/50 bg-red-600/10 text-red-400 hover:bg-red-600/20 transition-colors disabled:opacity-50"
        >
          <Trash2 className="w-3 h-3" />
          {t("personal.votes.dismiss")}
        </button>
      )}
      {isAdmin && confirmingDismiss && (
        <div
          className="flex items-center gap-1.5"
          onKeyDown={(e) => {
            if (e.key === "Escape" && !loading) {
              e.stopPropagation();
              cancelDismiss();
            }
          }}
        >
          <button
            onClick={handleDismiss}
            disabled={loading}
            className="flex items-center gap-1.5 min-h-[32px] text-xs px-3 py-1.5 rounded-lg bg-red-600 text-[var(--ds-on-status)] hover:bg-[var(--ds-danger-hover)] transition-colors disabled:opacity-50"
            autoFocus
          >
            {pending === "dismiss" ? <Loader2 className="w-3 h-3 animate-spin" /> : <Trash2 className="w-3 h-3" />}
            {t("personal.votes.confirmDismiss")}
          </button>
          <button
            onClick={cancelDismiss}
            disabled={loading}
            className="min-h-[32px] text-xs px-2 py-1.5 text-zinc-400 hover:text-zinc-100 transition-colors"
          >
            {t("personal.common.cancel")}
          </button>
        </div>
      )}
    </div>
  );
}
