"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Bookmark, BookmarkCheck, Loader2 } from "@/components/icons";
import { withBasePath } from "@/lib/base-path";
import { rateLimitMessage } from "@/lib/client/rate-limit";
import { readApiError } from "@/lib/client/api-error";
import { check, v } from "@/lib/validate";
import { useToast } from "@/components/ui/toast";
import { useT } from "@/components/i18n/i18n-provider";
import { DetailActionButton } from "./detail-action-button";
import { timedFetch } from "@/lib/client/fetch-json";
import { useAsyncAction } from "@/hooks/use-async-action";

// "Add to Watchlist" toggle for movie/TV detail pages. Personal save-for-later,
// independent of availability or request permissions. Optimistic with rollback
// on error, mirroring the request buttons' UX. Callers key it by title
// (detail-actions.tsx), so no state carries across a client navigation.

// A 201 add's body: the item plus `autoRequest` when watchlist auto-request
// applied (src/app/api/watchlist/route.ts).
const AddAnswer = v.object({
  autoRequest: v.optional(
    v.object({
      requested: v.optional(v.boolean()),
      outcome: v.optional(v.string()),
      message: v.optional(v.string()),
    }),
  ),
});

type Translate = ReturnType<typeof useT>;

// The toast for an add that also tried to file a request: success when it
// did, nothing when there was nothing to do (already requested or available),
// otherwise why it didn't. Never fails the add itself.
function autoRequestToast(
  ar: { requested?: boolean; outcome?: string; message?: string } | undefined,
  t: Translate,
): { title: string; variant?: "success" } | null {
  if (!ar) return null;
  if (ar.requested) {
    return { title: t("detail.watchlist.autoRequested", { message: ar.message ?? t("detail.watchlist.requested") }), variant: "success" };
  }
  if (ar.outcome === "already-requested" || ar.outcome === "already-available") return null;
  return { title: t("detail.watchlist.notAutoRequested", { message: ar.message ?? t("request.somethingWrong") }) };
}

export function WatchlistButton({
  tmdbId,
  mediaType,
  initialOnWatchlist,
}: {
  tmdbId: number;
  mediaType: "MOVIE" | "TV";
  initialOnWatchlist: boolean;
}) {
  const { toast } = useToast();
  const t = useT();
  const router = useRouter();
  const action = useAsyncAction();
  const loading = action.busy("toggle");
  const [msg, setMsg] = useState("");
  // Local override until the parent catches up (router.refresh after a toggle
  // that also auto-requested). `initialOnWatchlist` is otherwise live — a
  // mount-only useState painted the next title with this title's bookmark.
  const [override, setOverride] = useState<boolean | null>(null);
  if (override !== null && override === initialOnWatchlist) {
    setOverride(null);
  }
  const on = override ?? initialOnWatchlist;

  async function toggle() {
    if (action.busy("toggle")) return;
    const next = !on;
    setOverride(next); // optimistic
    setMsg("");
    type Outcome =
      | { kind: "failed"; message: string }
      | { kind: "done"; added: unknown };
    const out = await action.run(
      "toggle",
      async (signal): Promise<Outcome> => {
        try {
          const res = next
            ? await timedFetch(withBasePath("/api/watchlist"), {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ tmdbId, mediaType }),
                signal,
              })
            : await timedFetch(withBasePath(`/api/watchlist?tmdbId=${tmdbId}&mediaType=${mediaType}`), { method: "DELETE", signal });
          // 409 on add means it's already there — the desired end state is still "on".
          if (!res.ok && res.status !== 409) {
            return { kind: "failed", message: rateLimitMessage(res, t) ?? (await readApiError(res, t("request.somethingWrong"))) };
          }
          return { kind: "done", added: next && res.status === 201 ? await res.json().catch(() => null) : undefined };
        } catch {
          return { kind: "failed", message: t("request.networkError") };
        }
      },
      { ifBusy: "skip" },
    );
    if (!out) return;
    if (out.kind === "failed") {
      // Roll back to the pre-click state, NOT the prop: after an earlier
      // successful toggle the prop is stale until something refreshes it.
      setOverride(!next);
      setMsg(out.message);
      return;
    }
    toast({ title: next ? t("detail.watchlist.added") : t("detail.watchlist.removed"), variant: "success" });
    // Watchlist auto-request: the add may also have filed a request. The
    // field is present only when auto-request applied; a refusal (quota,
    // blacklisted, already available…) never fails the add itself.
    if (next && out.added !== undefined) {
      const parsed = check(AddAnswer, out.added);
      const ar = parsed.ok ? parsed.value.autoRequest : undefined;
      const follow = autoRequestToast(ar, t);
      if (follow) toast(follow);
      // The HD RequestButton ORs the live `requested` prop — refresh so
      // it re-reads and does not stay on "Request" (a second click 409s).
      if (ar?.requested) router.refresh();
    }
  }

  // flex-col: the error renders UNDER the button (as RequestButton's does), never
  // squeezed beside a 34px control in the wrapping action row.
  return (
    <div className="flex flex-col items-start gap-2">
      <DetailActionButton
        variant={on ? "accent-soft" : "secondary"}
        onClick={toggle}
        disabled={loading}
        busy={loading}
        aria-pressed={on}
        aria-label={on ? t("detail.watchlist.removeLabel") : t("detail.watchlist.addLabel")}
      >
        {loading ? (
          <Loader2 className="animate-spin" style={{ width: 14, height: 14 }} />
        ) : on ? (
          <BookmarkCheck style={{ width: 14, height: 14 }} />
        ) : (
          <Bookmark style={{ width: 14, height: 14 }} />
        )}
        {on ? t("detail.watchlist.on") : t("detail.watchlist.add")}
      </DetailActionButton>
      {msg && (
        <p
          className="ds-mono max-w-sm"
          role="alert"
          style={{ fontSize: 11, color: "var(--ds-danger)", margin: 0 }}
        >
          {msg}
        </p>
      )}
    </div>
  );
}
