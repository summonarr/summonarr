"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";
import { Loader2, UserCheck, UserX, X } from "@/components/icons";

interface IssueClaimButtonProps {
  issueId: string;
  claimedBy: string | null;
  claimerName: string | null;
  currentUserId: string;
}

export function IssueClaimButton({ issueId, claimedBy, claimerName, currentUserId }: IssueClaimButtonProps) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [confirmingTakeover, setConfirmingTakeover] = useState(false);

  const isClaimedByMe = claimedBy === currentUserId;
  const isClaimedByOther = claimedBy !== null && !isClaimedByMe;

  async function performToggle() {
    setBusy(true);
    setError(null);
    setConfirmingTakeover(false);
    try {
      const res = await fetch(`/api/issues/${issueId}/claim`, { method: "POST" });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        setError(data.error ?? "Failed");
        return;
      }
      router.refresh();
    } finally {
      setBusy(false);
    }
  }

  function onPrimaryClick() {
    if (isClaimedByOther) {
      setConfirmingTakeover(true);
      return;
    }
    void performToggle();
  }

  const label = isClaimedByMe
    ? "Release"
    : isClaimedByOther
      ? "Take over"
      : "Claim";
  const Icon = isClaimedByMe ? UserX : UserCheck;

  return (
    <div className="flex flex-col gap-1">
      {!confirmingTakeover && (
        <Button
          type="button"
          size="sm"
          variant={isClaimedByMe ? "secondary" : "default"}
          onClick={onPrimaryClick}
          disabled={busy}
          className="h-7 px-2.5 text-xs gap-1.5"
        >
          {busy ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Icon className="w-3.5 h-3.5" />}
          {label}
        </Button>
      )}
      {confirmingTakeover && (
        <div className="flex items-center gap-1.5">
          <Button
            type="button"
            size="sm"
            aria-label={`Confirm take over from ${claimerName ?? "another admin"}`}
            className="h-7 px-2.5 text-xs gap-1.5 bg-red-600 text-white hover:bg-red-500"
            onClick={performToggle}
            disabled={busy}
            autoFocus
          >
            {busy ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <UserCheck className="w-3.5 h-3.5" />}
            Take over from {claimerName ?? "admin"}
          </Button>
          <Button
            type="button"
            size="sm"
            variant="ghost"
            aria-label="Cancel take over"
            className="h-7 w-7 p-0 text-zinc-400 hover:text-zinc-200"
            onClick={() => setConfirmingTakeover(false)}
            disabled={busy}
          >
            <X className="w-3.5 h-3.5" />
          </Button>
        </div>
      )}
      {error && <p className="text-[10px] text-red-400">{error}</p>}
    </div>
  );
}
