"use client";

import Link from "next/link";
import { useState } from "react";
import { useT } from "@/components/i18n/i18n-provider";
import { Dialog, DialogBackdrop, DialogClose, DialogPopup, DialogPortal, DialogTitle } from "@/components/ui/dialog";
import type { TmdbMedia } from "@/lib/tmdb-types";

type Seeds = NonNullable<NonNullable<TmdbMedia["recommendedBecause"]>["seeds"]>;

// The "+ N more of yours" line under a For You card, turned into a way to see
// them: every title of the viewer's that surfaced this pick, strongest first,
// each linking to its own page. The list is capped server-side
// (MAX_REASON_SEEDS); `seedCount` is the true total, so the remainder past the
// cap is still stated rather than silently dropped.
export function RecommendationSeedsButton({
  pickTitle,
  seeds,
  seedCount,
}: {
  pickTitle: string;
  seeds: Seeds;
  seedCount: number;
}) {
  const t = useT();
  const [open, setOpen] = useState(false);
  const others = seedCount - 1;
  const beyondCap = seedCount - seeds.length;

  const sourceLabel = (source: Seeds[number]["source"]) =>
    source === "WATCHLIST"
      ? t("browse.forYou.seeds.source.watchlist")
      : source === "REQUEST"
        ? t("browse.forYou.seeds.source.request")
        : t("browse.forYou.seeds.source.watched");

  // ONE containment for every click this component produces. The whole thing
  // renders inside MediaCard, whose root onClick navigates to the pick's page.
  // The dialog is portalled to <body>, but React still bubbles its synthetic
  // clicks through the REACT tree — i.e. through this wrapper and on to the
  // card. That covers the trigger (opening must not navigate), the popup (a
  // click on a seed link or Close must not ALSO navigate to the pick), and the
  // backdrop: Base UI closes on the backdrop's `click` itself, so with only the
  // popup guarded, click-outside-to-dismiss closed the list AND left the page.
  // Containing it once here, above the portal, is what makes it impossible to
  // leave one of the three out again. `display: contents` keeps the wrapper
  // out of the card footer's flex layout; the Dialog root renders no DOM, so
  // the span's only box-bearing child is the trigger.
  return (
    <span style={{ display: "contents" }} onClick={(e) => e.stopPropagation()}>
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="ds-mono m-0 text-left underline decoration-dotted underline-offset-2 rounded-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--ds-accent-ring)]"
        style={{ fontSize: 11.5, color: "var(--ds-accent-text)", lineHeight: 1.4, background: "none", border: 0, padding: 0 }}
        aria-haspopup="dialog"
      >
        {t("browse.forYou.moreOfYours", { count: others })}
      </button>

      <Dialog open={open} onOpenChange={setOpen}>
        <DialogPortal>
          <DialogBackdrop />
          <DialogPopup className="max-w-md">
            <div className="flex items-start justify-between gap-3 px-5 pt-5 pb-3">
              <div className="min-w-0">
                <DialogTitle className="text-base">{t("browse.forYou.seeds.title")}</DialogTitle>
                <p className="mt-1 text-sm" style={{ color: "var(--ds-fg-muted)" }}>
                  {t("browse.forYou.seeds.intro", { count: seedCount, title: pickTitle })}
                </p>
              </div>
              <DialogClose
                className="shrink-0 rounded-md px-2 py-1 text-sm"
                style={{ color: "var(--ds-fg-muted)" }}
              >
                {t("request.close")}
              </DialogClose>
            </div>
            <ul className="overflow-y-auto px-5 pb-5 flex flex-col gap-1">
              {seeds.map((seed) => (
                <li key={`${seed.mediaType}-${seed.tmdbId}`}>
                  <Link
                    href={`/${seed.mediaType}/${seed.tmdbId}`}
                    className="flex items-baseline justify-between gap-3 rounded-md px-2 py-1.5 hover:bg-[var(--ds-bg-inset)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--ds-accent-ring)]"
                  >
                    <span className="min-w-0 truncate" style={{ color: "var(--ds-fg)" }}>
                      {seed.title}
                    </span>
                    <span className="ds-mono shrink-0" style={{ fontSize: 11, color: "var(--ds-fg-subtle)" }}>
                      {sourceLabel(seed.source)}
                    </span>
                  </Link>
                </li>
              ))}
              {beyondCap > 0 && (
                <li className="px-2 pt-1 text-xs" style={{ color: "var(--ds-fg-subtle)" }}>
                  {t("browse.forYou.seeds.andMore", { count: beyondCap })}
                </li>
              )}
            </ul>
          </DialogPopup>
        </DialogPortal>
      </Dialog>
    </span>
  );
}
