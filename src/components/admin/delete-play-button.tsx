"use client";

import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { Trash2, Loader2 } from "@/components/icons";
import { withBasePath } from "@/lib/base-path";
import { fetchJson } from "@/lib/client/fetch-json";
import { useT } from "@/components/i18n/i18n-provider";

// Confirm-then-DELETE control for a single play-history record; on success
// navigates back to the activity history tab.
//
// Each step swaps the focused button out of the tree, so keyboard focus is
// moved by hand: into the confirm UI (its Cancel — never straight onto the
// destructive Delete) when it opens, and back to the trigger after Cancel.
// Never on mount: only a step the user took moves focus.
export function DeletePlayButton({ id }: { id: string }) {
  const t = useT();
  const router = useRouter();
  const [confirming, setConfirming] = useState(false);
  const [deleting, setDeleting] = useState(false);
  // The message to show: the route's own (translated) text, such as its
  // rate-limit answer, else the generic failure.
  const [error, setError] = useState<string | null>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const cancelRef = useRef<HTMLButtonElement>(null);
  const stepped = useRef(false);

  useEffect(() => {
    if (!stepped.current) return;
    (confirming ? cancelRef : triggerRef).current?.focus();
  }, [confirming]);

  // Each step starts clean: a failure belongs to the attempt that made it, so
  // Cancel and a fresh confirm never show the previous one's message.
  function step(next: boolean) {
    stepped.current = true;
    setError(null);
    setConfirming(next);
  }

  // `deleting` is cleared on the failure path only. After a success both
  // buttons stay disabled until the navigation lands: re-enabled, a second
  // click sent a DELETE for the row that was already gone and showed "failed".
  async function handleDelete() {
    setDeleting(true);
    setError(null);
    const res = await fetchJson(withBasePath(`/api/play-history/${encodeURIComponent(id)}`), {
      init: { method: "DELETE" },
      fallbackError: t("adminActivity.deletePlay.failed"),
    });
    // 404: another tab or admin already removed it, which is the goal met.
    if (!res.ok && !(res.kind === "http" && res.status === 404)) {
      // A route refusal already says why (its rate-limit text, say); anything
      // else (no answer, a proxy page) is for the console.
      if (res.kind !== "http") console.error("[delete-play] delete failed:", res.detail);
      setError(res.error);
      setDeleting(false);
      return;
    }
    router.push("/admin/activity/history");
    router.refresh();
  }

  if (!confirming) {
    return (
      <button
        ref={triggerRef}
        onClick={() => step(true)}
        className="flex items-center gap-1.5 px-3 py-1.5 text-xs text-zinc-500 hover:text-red-400 border border-zinc-700 hover:border-red-500/50 rounded-lg transition-colors"
      >
        <Trash2 className="w-3.5 h-3.5" />
        {t("adminActivity.deletePlay.button")}
      </button>
    );
  }

  return (
    <div className="flex items-center gap-2">
      <span className="text-xs text-zinc-400">{t("adminActivity.deletePlay.confirm")}</span>
      <button
        ref={cancelRef}
        onClick={() => step(false)}
        disabled={deleting}
        className="px-3 py-1.5 text-xs rounded-lg bg-zinc-800 text-zinc-300 hover:bg-zinc-700 transition-colors"
      >
        {t("adminActivity.common.cancel")}
      </button>
      <button
        onClick={handleDelete}
        disabled={deleting}
        className="flex items-center gap-1.5 px-3 py-1.5 text-xs rounded-lg bg-red-600 text-[var(--ds-on-status)] hover:bg-[var(--ds-danger-hover)] transition-colors disabled:opacity-50"
      >
        {deleting && <Loader2 className="w-3.5 h-3.5 animate-spin" />}
        {t("adminActivity.common.delete")}
      </button>
      {error && <span role="alert" className="text-xs text-red-400">{error}</span>}
    </div>
  );
}
