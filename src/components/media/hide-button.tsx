"use client";

import { useState } from "react";
import { EyeOff, Loader2 } from "@/components/icons";
import { withBasePath } from "@/lib/base-path";
import { rateLimitMessage } from "@/lib/client/rate-limit";
import { useToast } from "@/components/ui/toast";
import { useT } from "@/components/i18n/i18n-provider";
import { DetailActionButton } from "./detail-action-button";

// "Not Interested" toggle on movie/TV detail pages. Hidden titles are removed from
// the user's discovery lists (attachAllAvailability filters them). Optimistic with
// rollback, mirroring the watchlist/request buttons.
export function HideButton({
  tmdbId,
  mediaType,
  title,
  posterPath,
  initialHidden,
}: {
  tmdbId: number;
  mediaType: "MOVIE" | "TV";
  title: string;
  posterPath?: string | null;
  initialHidden: boolean;
}) {
  const { toast } = useToast();
  const t = useT();
  const [loading, setLoading] = useState(false);
  const [msg, setMsg] = useState("");
  // Local override until the parent catches up. `initialHidden` is otherwise
  // live — a mount-only useState painted the next title as already hidden.
  const [override, setOverride] = useState<boolean | null>(null);
  const [seenTmdbId, setSeenTmdbId] = useState(tmdbId);
  const titleChanged = seenTmdbId !== tmdbId;
  if (titleChanged) {
    setSeenTmdbId(tmdbId);
    setOverride(null);
    setLoading(false);
    setMsg("");
  } else if (override !== null && override === initialHidden) {
    setOverride(null);
  }
  const hidden = titleChanged ? initialHidden : (override ?? initialHidden);

  async function toggle() {
    if (loading) return;
    const next = !hidden;
    setOverride(next); // optimistic
    setLoading(true);
    setMsg("");
    try {
      const res = next
        ? await fetch(withBasePath("/api/hidden"), {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ tmdbId, mediaType, title, posterPath }),
          })
        : await fetch(withBasePath(`/api/hidden?tmdbId=${tmdbId}&mediaType=${mediaType}`), {
            method: "DELETE",
          });
      // 409 on hide means it's already hidden — desired end state is still "hidden".
      if (!res.ok && res.status !== 409) {
        const data = await res.json().catch(() => ({}));
        // Roll back to the pre-click state, NOT the prop: after an earlier
        // successful toggle the prop is stale (nothing refreshes it here).
        setOverride(!next);
        setMsg(rateLimitMessage(res, t) ?? data.error ?? t("request.somethingWrong"));
      } else {
        toast({ title: next ? t("detail.hide.hiddenToast") : t("detail.hide.shownToast"), variant: "success" });
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
        variant={hidden ? "muted" : "secondary"}
        onClick={toggle}
        disabled={loading && !titleChanged}
        busy={loading && !titleChanged}
        aria-pressed={hidden}
        aria-label={hidden ? t("detail.hide.showLabel") : t("detail.hide.hideLabel")}
        title={hidden ? t("detail.hide.hiddenTitle") : t("detail.hide.hideTitle")}
        // The hidden state sits one surface deeper than the idle one.
        style={hidden ? { background: "var(--ds-bg-3)" } : undefined}
      >
        {loading && !titleChanged ? (
          <Loader2 className="animate-spin" style={{ width: 14, height: 14 }} />
        ) : (
          <EyeOff style={{ width: 14, height: 14 }} />
        )}
        {hidden ? t("detail.hide.hidden") : t("detail.hide.notInterested")}
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
