"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Trash2, Loader2, Check } from "@/components/icons";
import { DetailActionButton } from "@/components/media/detail-action-button";
import { useToast } from "@/components/ui/toast";
import { useT } from "@/components/i18n/i18n-provider";
import { castDeletionVote, writeDeletionVote, type VoteWriteOutcome } from "@/lib/client/vote-write";
import { useAsyncAction } from "@/hooks/use-async-action";

interface Props {
  tmdbId: number;
  mediaType: "MOVIE" | "TV";
  requestToken: string;
  alreadyVoted: boolean;
}

// Server cap on DeletionVote.reason (VarChar(200)); the counter appears once a
// reason is within 20 characters of it so the silent slice below isn't a surprise.
const REASON_MAX = 200;
const REASON_COUNTER_AT = 180;

export function VoteDeleteButton({ tmdbId, mediaType, requestToken, alreadyVoted }: Props) {
  const router = useRouter();
  const { toast } = useToast();
  const t = useT();
  const action = useAsyncAction();
  const [state, setState] = useState<"idle" | "reason" | "loading" | "voted">(alreadyVoted ? "voted" : "idle");
  const [reason, setReason] = useState("");
  // Set by a user-initiated change of control (submit, cancel): the focused
  // input or button unmounts, so the root button that replaces it takes focus
  // (autoFocus acts on mount only) instead of focus falling to <body>.
  const [refocus, setRefocus] = useState(false);
  // A new title is a new instance (the action row keys this button by the
  // title). Within one title `alreadyVoted` is live, so a refresh after voting
  // (this button already router.refresh()es) or a change elsewhere matches.
  const [seenVoted, setSeenVoted] = useState(alreadyVoted);
  if (alreadyVoted !== seenVoted && state !== "loading" && state !== "reason") {
    setSeenVoted(alreadyVoted);
    setState(alreadyVoted ? "voted" : "idle");
  }

  function closeReason() {
    setState("idle");
    setReason("");
    setRefocus(true);
  }

  type Outcome = VoteWriteOutcome;

  async function handleVote() {
    if (action.busy("vote")) return;
    setState("loading");
    setRefocus(true);
    const out = await action.run(
      "vote",
      (signal): Promise<Outcome> =>
        castDeletionVote({
          tmdbId, mediaType, reason: reason.trim() || undefined, pageToken: requestToken,
          failed: t("request.vote.recordFailed"), signal, t,
        }),
      { ifBusy: "skip" },
    );
    if (!out) return;
    if (out.ok) {
      setState("voted");
      setReason("");
      router.refresh();
    } else {
      setState("idle");
      toast({ title: out.message, variant: "error" });
    }
  }

  async function handleUnvote() {
    if (action.busy("vote")) return;
    setState("loading");
    // The "Voted" button unmounts for the spinner: the button that replaces it
    // takes focus.
    setRefocus(true);
    // 404: the vote is already gone (removed in another tab, or dismissed by
    // an admin), which is what was asked for. Treating it as a failure kept
    // the button on "Voted" and every retry 404'd again.
    const out = await action.run(
      "vote",
      (signal) => writeDeletionVote({ method: "DELETE", tmdbId, mediaType, okOn404: true, failed: t("request.vote.removeFailed"), signal, t }),
      { ifBusy: "skip" },
    );
    if (!out) return;
    if (out.ok) {
      setState("idle");
      toast({ title: t("request.vote.removed"), variant: "success" });
      router.refresh();
    } else {
      setState("voted");
      toast({ title: out.message, variant: "error" });
    }
  }

  if (state === "voted") {
    return (
      <DetailActionButton
        variant="danger-soft"
        onClick={handleUnvote}
        title={t("request.vote.removeTitle")}
        aria-label={t("request.vote.votedLabel")}
        autoFocus={refocus}
      >
        <Check style={{ width: 14, height: 14 }} />
        {t("request.vote.voted")}
      </DetailActionButton>
    );
  }

  if (state === "reason") {
    return (
      <div className="flex items-center gap-2 flex-wrap">
        <input
          type="text"
          value={reason}
          onChange={(e) => setReason(e.target.value.slice(0, REASON_MAX))}
          placeholder={t("request.vote.reasonPlaceholder")}
          aria-label={t("request.vote.reason")}
          // 16px below md: iOS Safari zooms the page when a control under 16px
          // takes focus (same rule as Input and StyledSelect).
          className="h-[34px] w-48 rounded-md border border-zinc-700 bg-zinc-800 px-3 text-base md:text-[13px] text-zinc-100 focus:outline-none focus:ring-2 focus:ring-red-500"
          autoFocus
          onKeyDown={(e) => {
            // An Enter (or Escape) that commits or cancels an IME composition
            // belongs to the composition: voting on it posted a partial reason.
            // keyCode 229 is Safari, which reports isComposing false on that key.
            if (e.nativeEvent.isComposing || e.keyCode === 229) return;
            if (e.key === "Enter") handleVote();
            if (e.key === "Escape") closeReason();
          }}
        />
        {reason.length > REASON_COUNTER_AT && (
          <span className="ds-mono text-[10px] tabular-nums text-zinc-500" aria-live="polite">
            {reason.length}/{REASON_MAX}
          </span>
        )}
        <DetailActionButton variant="danger" onClick={handleVote}>
          {t("request.vote.vote")}
        </DetailActionButton>
        <DetailActionButton variant="ghost" onClick={closeReason}>
          {t("request.cancel")}
        </DetailActionButton>
      </div>
    );
  }

  if (state === "loading") {
    // aria-disabled, not disabled: the same <button> carries the idle, loading
    // and voted states, and disabling it would drop its focus to <body>. It has
    // no onClick, so a click while loading does nothing.
    return (
      <DetailActionButton
        variant="secondary"
        aria-disabled
        busy
        aria-label={t("request.vote.updating")}
        autoFocus={refocus}
        style={{ opacity: 0.7 }}
      >
        <Loader2 className="animate-spin" style={{ width: 14, height: 14 }} />
      </DetailActionButton>
    );
  }

  return (
    <DetailActionButton variant="secondary" onClick={() => setState("reason")} autoFocus={refocus}>
      <Trash2 style={{ width: 14, height: 14 }} />
      {t("request.vote.voteToDelete")}
    </DetailActionButton>
  );
}
