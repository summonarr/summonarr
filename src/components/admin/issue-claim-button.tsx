"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";
import { Loader2, UserCheck, UserX } from "lucide-react";

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

  const isClaimedByMe = claimedBy === currentUserId;
  const isClaimedByOther = claimedBy !== null && !isClaimedByMe;

  async function toggle() {
    if (isClaimedByOther && !confirm(`This issue is claimed by ${claimerName ?? "another admin"}. Take it over?`)) {
      return;
    }
    setBusy(true);
    setError(null);
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

  const label = isClaimedByMe
    ? "Release"
    : isClaimedByOther
      ? "Take over"
      : "Claim";
  const Icon = isClaimedByMe ? UserX : UserCheck;

  return (
    <div className="flex flex-col gap-1">
      <Button
        type="button"
        size="sm"
        variant={isClaimedByMe ? "secondary" : "default"}
        onClick={toggle}
        disabled={busy}
        className="h-7 px-2.5 text-xs gap-1.5"
      >
        {busy ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Icon className="w-3.5 h-3.5" />}
        {label}
      </Button>
      {error && <p className="text-[10px] text-red-400">{error}</p>}
    </div>
  );
}
