"use client";

import { useState } from "react";
import { Bookmark, BookmarkCheck, Loader2 } from "@/components/icons";
import { withBasePath } from "@/lib/base-path";
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
  const [on, setOn] = useState(initialOnWatchlist);
  const [loading, setLoading] = useState(false);
  const [msg, setMsg] = useState("");

  async function toggle() {
    if (loading) return;
    const next = !on;
    setOn(next); // optimistic
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
        setOn(!next); // rollback
        setMsg(data.error ?? t("request.somethingWrong"));
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
          } else if (ar && ar.outcome !== "already-requested" && ar.outcome !== "already-available") {
            toast({ title: t("detail.watchlist.notAutoRequested", { message: ar.message ?? t("request.somethingWrong") }) });
          }
        }
      }
    } catch {
      setOn(!next); // rollback
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
