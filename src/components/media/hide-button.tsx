"use client";

import { useState } from "react";
import { EyeOff, Loader2 } from "@/components/icons";
import { hideTitle, hiddenFailureText, unhideTitle } from "@/lib/client/hidden-items";
import { useAsyncAction } from "@/hooks/use-async-action";
import { useToast } from "@/components/ui/toast";
import { useT } from "@/components/i18n/i18n-provider";
import { DetailActionButton } from "./detail-action-button";

interface HideButtonProps {
  tmdbId: number;
  mediaType: "MOVIE" | "TV";
  title: string;
  posterPath?: string | null;
  initialHidden: boolean;
}

// "Not Interested" toggle on movie/TV detail pages. Hidden titles are removed from
// the user's discovery lists (attachAllAvailability filters them). Optimistic with
// rollback, mirroring the watchlist/request buttons.
//
// Keyed on the title: client navigation from one title to another remounts the
// button, so nothing — an override, an error, a request still in flight (aborted
// with the old instance, its answer dropped) — carries across to the next title.
export function HideButton(props: HideButtonProps) {
  return <HideButtonForTitle key={`${props.mediaType}:${props.tmdbId}`} {...props} />;
}

function HideButtonForTitle({ tmdbId, mediaType, title, posterPath, initialHidden }: HideButtonProps) {
  const { toast } = useToast();
  const t = useT();
  const action = useAsyncAction();
  const [msg, setMsg] = useState("");
  // Local override until the parent catches up. `initialHidden` is otherwise
  // live — a mount-only useState painted the next title as already hidden.
  const [override, setOverride] = useState<boolean | null>(null);
  if (override !== null && override === initialHidden) setOverride(null);
  const hidden = override ?? initialHidden;
  const loading = action.busy("toggle");

  async function toggle() {
    if (loading) return;
    const next = !hidden;
    setOverride(next); // optimistic
    setMsg("");
    const item = { tmdbId, mediaType };
    const res = await action.run(
      "toggle",
      (signal) => (next ? hideTitle({ ...item, title, posterPath }, { signal }) : unhideTitle(item, { signal })),
      { ifBusy: "skip" },
    );
    if (!res) return; // the button went away with its title
    if (res.ok) {
      toast({ title: next ? t("detail.hide.hiddenToast") : t("detail.hide.shownToast"), variant: "success" });
      return;
    }
    // Roll back to the pre-click state, NOT the prop: after an earlier
    // successful toggle the prop is stale (nothing refreshes it here). Every
    // failure — a refusal, a timeout, no answer — lands here.
    setOverride(!next);
    setMsg(hiddenFailureText(res.failure, t, t("request.somethingWrong"), t("request.networkError")));
  }

  // flex-col: the error renders UNDER the button (as RequestButton's does), never
  // squeezed beside a 34px control in the wrapping action row.
  return (
    <div className="flex flex-col items-start gap-2">
      <DetailActionButton
        variant={hidden ? "muted" : "secondary"}
        onClick={toggle}
        disabled={loading}
        busy={loading}
        aria-pressed={hidden}
        aria-label={hidden ? t("detail.hide.showLabel") : t("detail.hide.hideLabel")}
        title={hidden ? t("detail.hide.hiddenTitle") : t("detail.hide.hideTitle")}
        // The hidden state sits one surface deeper than the idle one.
        style={hidden ? { background: "var(--ds-bg-3)" } : undefined}
      >
        {loading ? (
          <Loader2 className="animate-spin" style={{ width: 14, height: 14 }} />
        ) : (
          <EyeOff style={{ width: 14, height: 14 }} />
        )}
        {hidden ? t("detail.hide.hidden") : t("detail.hide.notInterested")}
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
