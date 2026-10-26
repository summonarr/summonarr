"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Bookmark, BookmarkCheck, Loader2 } from "@/components/icons";
import { withBasePath } from "@/lib/base-path";
import { rateLimitMessage } from "@/lib/client/rate-limit";
import { useToast } from "@/components/ui/toast";
import { useT } from "@/components/i18n/i18n-provider";
import { DetailActionButton } from "./detail-action-button";

// "Add to Watchlist" toggle for movie/TV detail pages. Personal save-for-later,
// independent of availability or request permissions. Optimistic with rollback
// on error, mirroring the request buttons' UX.
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
  const [loading, setLoading] = useState(false);
  const [msg, setMsg] = useState("");
  // Local override until the parent catches up (router.refresh after a toggle
  // that also auto-requested). `initialOnWatchlist` is otherwise live — a
  // mount-only useState painted the next title with this title's bookmark.
  const [override, setOverride] = useState<boolean | null>(null);
  const [seenTmdbId, setSeenTmdbId] = useState(tmdbId);
  const titleChanged = seenTmdbId !== tmdbId;
  if (titleChanged) {
    setSeenTmdbId(tmdbId);
    setOverride(null);
    setLoading(false);
    setMsg("");
  } else if (override !== null && override === initialOnWatchlist) {
    setOverride(null);
  }
  const on = titleChanged ? initialOnWatchlist : (override ?? initialOnWatchlist);

  async function toggle() {
    if (loading) return;
    const next = !on;
    setOverride(next); // optimistic
    setLoading(true);
    setMsg("");
    try {
      const res = next
        ? await fetch(withBasePath("/api/watchlist"), {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ tmdbId, mediaType }),
          })
        : await fetch(withBasePath(`/api/watchlist?tmdbId=${tmdbId}&mediaType=${mediaType}`), {
            method: "DELETE",
          });
      // 409 on add means it's already there — the desired end state is still "on".
      if (!res.ok && res.status !== 409) {
        const data = await res.json().catch(() => ({}));
        // Roll back to the pre-click state, NOT the prop: after an earlier
        // successful toggle the prop is stale until something refreshes it.
        setOverride(!next);
        setMsg(rateLimitMessage(res, t) ?? data.error ?? t("request.somethingWrong"));
      } else {
        toast({ title: next ? t("detail.watchlist.added") : t("detail.watchlist.removed"), variant: "success" });
        // Watchlist auto-request: the add may also have filed a request. The
        // field is present only when auto-request applied; a refusal (quota,
        // blacklisted, already available…) never fails the add itself.
        if (next && res.status === 201) {
          const data = (await res.json().catch(() => ({}))) as {
            autoRequest?: { requested?: boolean; outcome?: string; message?: string };
          };
          const ar = data.autoRequest;
          if (ar?.requested) {
            toast({ title: t("detail.watchlist.autoRequested", { message: ar.message ?? t("detail.watchlist.requested") }), variant: "success" });
            // The HD RequestButton ORs the live `requested` prop — refresh so
            // it re-reads and does not stay on "Request" (a second click 409s).
            router.refresh();
          } else if (ar && ar.outcome !== "already-requested" && ar.outcome !== "already-available") {
            toast({ title: t("detail.watchlist.notAutoRequested", { message: ar.message ?? t("request.somethingWrong") }) });
          }
        }
      }
    } catch {
      setOverride(!next); // rollback to the pre-click state
      setMsg(t("request.networkError"));
    } finally {
      setLoading(false);
    }
  }

  // flex-col: the error renders UNDER the button (as RequestButton's does), never
  // squeezed beside a 34px control in the wrapping action row.
  return (
    <div className="flex flex-col items-start gap-2">
      <DetailActionButton
        variant={on ? "accent-soft" : "secondary"}
        onClick={toggle}
        disabled={loading && !titleChanged}
        busy={loading && !titleChanged}
        aria-pressed={on}
        aria-label={on ? t("detail.watchlist.removeLabel") : t("detail.watchlist.addLabel")}
      >
        {loading && !titleChanged ? (
          <Loader2 className="animate-spin" style={{ width: 14, height: 14 }} />
        ) : on ? (
          <BookmarkCheck style={{ width: 14, height: 14 }} />
        ) : (
          <Bookmark style={{ width: 14, height: 14 }} />
        )}
        {on ? t("detail.watchlist.on") : t("detail.watchlist.add")}
      </DetailActionButton>
      {!titleChanged && msg && (
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
