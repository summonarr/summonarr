"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";
import { Loader2, UserCheck, UserX, X } from "@/components/icons";
import { withBasePath } from "@/lib/base-path";
import { useT } from "@/components/i18n/i18n-provider";
import { requestPageRefresh } from "@/lib/client/refresh-hold";
import { readApiError } from "@/lib/client/api-error";

interface IssueClaimButtonProps {
  issueId: string;
  claimedBy: string | null;
  claimerName: string | null;
  currentUserId: string;
}

export function IssueClaimButton({ issueId, claimedBy, claimerName, currentUserId }: IssueClaimButtonProps) {
  const router = useRouter();
  const t = useT();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [confirmingTakeover, setConfirmingTakeover] = useState(false);
  // The claim as this button last knew it. The page's refresh is debounced
  // (and deferred while a dialog holds it), so after a toggle the prop stays
  // stale for a while; a second click sent the OLD expectation and drew a 409
  // naming the admin themself. A new prop from the server always wins.
  const [localClaimedBy, setLocalClaimedBy] = useState(claimedBy);
  const [prevClaimedBy, setPrevClaimedBy] = useState(claimedBy);
  if (claimedBy !== prevClaimedBy) {
    setPrevClaimedBy(claimedBy);
    setLocalClaimedBy(claimedBy);
  }

  const isClaimedByMe = localClaimedBy === currentUserId;
  const isClaimedByOther = localClaimedBy !== null && !isClaimedByMe;

  async function performToggle() {
    setBusy(true);
    setError(null);
    setConfirmingTakeover(false);
    try {
      // The claim state this button shows. The server refuses the toggle when
      // the row has moved on, so a Claim clicked on stale state can no longer
      // take another admin's claim over without the confirmation.
      const expectedClaimedBy = localClaimedBy;
      const res = await fetch(withBasePath(`/api/issues/${issueId}/claim`), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ expectedClaimedBy }),
      });
      if (!res.ok) {
        // `message` first (readApiError) — a claim CAS miss answers { error:
        // "claim-conflict", message: "<who claimed it>" }, and showing the slug
        // hid the useful half.
        setError(await readApiError(res, t("adminQueue.claim.failed")));
        // 409 means this state is stale: fall back to the server-rendered claim
        // and pull the real one, so the button re-renders as "Take over from
        // <name>" instead of "Claim".
        if (res.status === 409) {
          setLocalClaimedBy(claimedBy);
          requestPageRefresh(() => router.refresh());
        }
        return;
      }
      // The route answers the updated row; without it, the toggle's own result.
      const updated = (await res.json().catch(() => null)) as { claimedBy?: unknown } | null;
      setLocalClaimedBy(
        updated && (typeof updated.claimedBy === "string" || updated.claimedBy === null)
          ? updated.claimedBy
          : expectedClaimedBy === currentUserId ? null : currentUserId,
      );
      // The claim is announced over SSE too; the shared refresh makes the two one.
      requestPageRefresh(() => router.refresh());
    } catch {
      setError(t("adminQueue.claim.networkError"));
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
    ? t("adminQueue.claim.release")
    : isClaimedByOther
      ? t("adminQueue.claim.takeOver")
      : t("adminQueue.claim.claim");
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
            aria-label={t("adminQueue.claim.confirmAria", { name: claimerName ?? t("adminQueue.claim.anotherAdmin") })}
            className="h-7 px-2.5 text-xs gap-1.5 bg-red-600 text-[var(--ds-on-status)] hover:bg-[var(--ds-danger-hover)]"
            onClick={performToggle}
            disabled={busy}
            autoFocus
          >
            {busy ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <UserCheck className="w-3.5 h-3.5" />}
            {t("adminQueue.claim.takeOverFrom", { name: claimerName ?? t("adminQueue.claim.admin") })}
          </Button>
          <Button
            type="button"
            size="sm"
            variant="ghost"
            aria-label={t("adminQueue.claim.cancelAria")}
            className="h-7 w-7 px-0 text-zinc-400 hover:text-zinc-200"
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
