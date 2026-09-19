"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Trash2, Loader2, Check } from "@/components/icons";
import { withBasePath } from "@/lib/base-path";
import { DetailActionButton } from "@/components/media/detail-action-button";

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
    setState("loading");
    try {
      const res = await fetch(withBasePath("/api/votes"), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ tmdbId, mediaType, reason: reason.trim() || undefined, _token: requestToken }),
      });
      if (res.ok || res.status === 409) {
        setState("voted");
        router.refresh();
      } else {
        setState("idle");
      }
    } catch {
      setState("idle");
    }
  }

  async function handleUnvote() {
    setState("loading");
    try {
      const res = await fetch(withBasePath(`/api/votes/${tmdbId}?mediaType=${mediaType}`), { method: "DELETE" });
      if (res.ok) {
        setState("idle");
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
      <DetailActionButton variant="danger-soft" onClick={handleUnvote}>
        <Check style={{ width: 14, height: 14 }} />
        Voted to Delete
      </DetailActionButton>
    );
  }

  if (state === "reason") {
    return (
      <div className="flex items-center gap-2 flex-wrap">
        <input
          type="text"
          value={reason}
          onChange={(e) => setReason(e.target.value.slice(0, 200))}
          placeholder="Reason (optional)"
          aria-label="Reason"
          className="h-[34px] w-48 rounded-md border border-zinc-700 bg-zinc-800 px-3 text-[13px] text-zinc-100 focus:outline-none focus:ring-2 focus:ring-red-500"
          autoFocus
          onKeyDown={(e) => { if (e.key === "Enter") handleVote(); if (e.key === "Escape") setState("idle"); }}
        />
        <DetailActionButton variant="danger" onClick={handleVote}>
          Vote
        </DetailActionButton>
        <DetailActionButton variant="ghost" onClick={() => setState("idle")}>
          Cancel
        </DetailActionButton>
      </div>
    );
  }

  if (state === "loading") {
    return (
      <DetailActionButton variant="secondary" disabled busy aria-label="Updating vote">
        <Loader2 className="animate-spin" style={{ width: 14, height: 14 }} />
      </DetailActionButton>
    );
  }

  return (
    <DetailActionButton variant="secondary" onClick={() => setState("reason")}>
      <Trash2 style={{ width: 14, height: 14 }} />
      Vote to Delete
    </DetailActionButton>
  );
}
