"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { ThumbsUp, Trash2, Loader2 } from "@/components/icons";
import { withBasePath } from "@/lib/base-path";
import { rateLimitMessage } from "@/lib/client/rate-limit";
import { useToast } from "@/components/ui/toast";
import { useT } from "@/components/i18n/i18n-provider";

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

  async function handleUnvote() {
    if (loading) return;
    setPending("unvote");
    setOverride(false);
    try {
      const res = await fetch(withBasePath(`/api/votes/${tmdbId}?mediaType=${mediaType}`), { method: "DELETE" });
      if (res.ok) {
        toast({ title: t("personal.votes.removed"), variant: "success" });
        router.refresh();
      } else {
        // Back to the PRE-CLICK state (voted), never the possibly stale prop.
        setOverride(true);
        toast({ title: rateLimitMessage(res, t) ?? t("personal.votes.removeFailed"), variant: "error" });
      }
    } catch {
      setOverride(true);
      toast({ title: t("personal.votes.removeFailed"), variant: "error" });
    } finally {
      setPending(null);
    }
  }

  async function handleDismiss() {
    if (loading) return;
    setPending("dismiss");
    try {
      const res = await fetch(withBasePath(`/api/votes/${tmdbId}?mediaType=${mediaType}`), { method: "PATCH" });
      if (res.ok) {
        setDismissed(true);
        toast({ title: t("personal.votes.dismissed"), variant: "success" });
        router.refresh();
      } else {
        setConfirmingDismiss(false);
        toast({ title: rateLimitMessage(res, t) ?? t("personal.votes.dismissFailed"), variant: "error" });
      }
    } catch {
      setConfirmingDismiss(false);
      toast({ title: t("personal.votes.dismissFailed"), variant: "error" });
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
          onClick={() => setConfirmingDismiss(true)}
          disabled={loading}
          className="flex items-center gap-1.5 min-h-[32px] text-xs px-3 py-1.5 rounded-lg border border-red-500/50 bg-red-600/10 text-red-400 hover:bg-red-600/20 transition-colors disabled:opacity-50"
        >
          <Trash2 className="w-3 h-3" />
          {t("personal.votes.dismiss")}
        </button>
      )}
      {isAdmin && confirmingDismiss && (
        <div className="flex items-center gap-1.5">
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
            onClick={() => setConfirmingDismiss(false)}
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
