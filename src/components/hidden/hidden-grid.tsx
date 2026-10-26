"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import Image from "next/image";
import { posterUrl } from "@/lib/tmdb-types";
import { X, Film, Tv2, EyeOff } from "@/components/icons";
import { withBasePath } from "@/lib/base-path";
import { EmptyState } from "@/components/ui/design";
import { useLocale, useT } from "@/components/i18n/i18n-provider";

export interface HiddenGridItem {
  tmdbId: number;
  mediaType: "MOVIE" | "TV";
  title: string;
  posterPath: string | null;
}

// Client grid for the /hidden page. Lists the user's "not interested" titles with
// an optimistic un-hide (X) that DELETEs the entry (restoring it to discovery).
// `cap` is the server page's `take` — when the initial list is exactly that
// long, older titles exist that this page cannot show (and this is the only
// un-hide UI), so a footer says so instead of failing silently.
export function HiddenGrid({
  initialItems,
  cap,
}: {
  initialItems: HiddenGridItem[];
  cap?: number;
}) {
  const [items, setItems] = useState(initialItems);
  const [removing, setRemoving] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const t = useT();
  const locale = useLocale();
  const router = useRouter();
  const [isPending, startTransition] = useTransition();
  const [reloadRequested, setReloadRequested] = useState(false);
  // After router.refresh(), adopt the new server slice when the user asked
  // for it (or when the visible list is already empty). Do not clobber an
  // in-progress optimistic un-hide of a non-empty grid.
  const [seenInitial, setSeenInitial] = useState(initialItems);
  let visible = items;
  if (initialItems !== seenInitial) {
    setSeenInitial(initialItems);
    if (reloadRequested || items.length === 0) {
      setItems(initialItems);
      setReloadRequested(false);
      setError(null);
      visible = initialItems;
    }
  }
  const capped = cap != null && initialItems.length >= cap;

  async function unhide(it: HiddenGridItem) {
    const key = `${it.tmdbId}:${it.mediaType}`;
    setRemoving(key);
    setError(null);
    setItems((cur) => cur.filter((x) => `${x.tmdbId}:${x.mediaType}` !== key)); // optimistic
    // Roll back only THIS item — restoring a stale whole-list snapshot would
    // resurrect other items whose concurrent DELETE already succeeded.
    // Re-insert at its original position (relative to the initial order) rather
    // than appending, so a failed unhide doesn't look like a reorder.
    const order = (x: HiddenGridItem) =>
      initialItems.findIndex((y) => y.tmdbId === x.tmdbId && y.mediaType === x.mediaType);
    const restore = () => {
      setItems((cur) => {
        if (cur.some((x) => `${x.tmdbId}:${x.mediaType}` === key)) return cur;
        const at = order(it);
        const idx = cur.findIndex((x) => order(x) > at);
        return idx === -1 ? [...cur, it] : [...cur.slice(0, idx), it, ...cur.slice(idx)];
      });
      setError(t("personal.hidden.unhideError", { title: it.title }));
    };
    try {
      const res = await fetch(
        withBasePath(`/api/hidden?tmdbId=${it.tmdbId}&mediaType=${it.mediaType}`),
        { method: "DELETE" },
      );
      if (!res.ok) restore();
    } catch {
      restore();
    } finally {
      setRemoving(null);
    }
  }

  if (visible.length === 0) {
    // A drained capped slice is NOT a true empty list — older rows remain
    // and this page is the only bulk un-hide UI. Match the Library/Issues
    // cap-banner tone and offer a reload so the next slice can appear.
    if (capped && cap != null) {
      return (
        <>
          {error && (
            <p role="alert" className="text-red-400" style={{ fontSize: 13, marginBottom: 12 }}>
              {error}
            </p>
          )}
          <div
            role="status"
            style={{
              marginBottom: 16,
              padding: "10px 14px",
              borderRadius: 8,
              background: "color-mix(in oklab, var(--ds-warning) 12%, transparent)",
              border: "1px solid color-mix(in oklab, var(--ds-warning) 30%, transparent)",
              color: "var(--ds-warning)",
              fontSize: 12.5,
            }}
          >
            <p className="m-0">{t("personal.common.cappedEmpty", { n: cap.toLocaleString(locale) })}</p>
            <button
              type="button"
              onClick={() => {
                setReloadRequested(true);
                startTransition(() => {
                  router.refresh();
                });
              }}
              disabled={isPending}
              className="ds-hover-tint"
              style={{
                marginTop: 10,
                padding: "6px 12px",
                borderRadius: 6,
                border: "1px solid color-mix(in oklab, var(--ds-warning) 40%, transparent)",
                background: "color-mix(in oklab, var(--ds-warning) 8%, transparent)",
                color: "var(--ds-warning)",
                fontSize: 12.5,
                fontWeight: 500,
                cursor: isPending ? "progress" : undefined,
              }}
            >
              {isPending ? t("personal.common.loading") : t("personal.common.reload")}
            </button>
          </div>
        </>
      );
    }
    return (
      <EmptyState
        icon={EyeOff}
        title={t("personal.hidden.emptyTitle")}
        description={t("personal.hidden.emptyDescription")}
      />
    );
  }

  return (
    <>
    {error && (
      <p role="alert" className="text-red-400" style={{ fontSize: 13, marginBottom: 12 }}>
        {error}
      </p>
    )}
    <div className="grid gap-3" style={{ gridTemplateColumns: "repeat(auto-fill, minmax(140px, 1fr))" }}>
      {visible.map((it) => {
        const key = `${it.tmdbId}:${it.mediaType}`;
        const href = it.mediaType === "MOVIE" ? `/movie/${it.tmdbId}` : `/tv/${it.tmdbId}`;
        const poster = posterUrl(it.posterPath, "w342");
        return (
          <div key={key} className="relative">
            <Link href={href} className="block group">
              <div
                className="ds-card-lift relative overflow-hidden border border-[var(--ds-border)]"
                style={{ aspectRatio: "2 / 3", borderRadius: 8, background: "var(--ds-bg-3)", opacity: 0.75 }}
              >
                {poster ? (
                  <Image src={poster} alt={it.title} fill className="object-cover" sizes="140px" />
                ) : (
                  <div className="flex items-center justify-center h-full" style={{ color: "var(--ds-fg-subtle)" }}>
                    {it.mediaType === "MOVIE" ? <Film style={{ width: 28, height: 28 }} /> : <Tv2 style={{ width: 28, height: 28 }} />}
                  </div>
                )}
              </div>
              <div
                className="line-clamp-2 font-medium"
                style={{ fontSize: 12.5, color: "var(--ds-fg)", marginTop: 8, lineHeight: 1.3 }}
              >
                {it.title}
              </div>
            </Link>
            {/* 40px hit area (the icon stays 14px): the control sits over the
                poster link, so a near-miss navigates instead of un-hiding. */}
            <button
              type="button"
              onClick={() => unhide(it)}
              disabled={removing === key}
              aria-label={t("personal.hidden.unhideAria", { title: it.title })}
              title={t("personal.hidden.unhide")}
              className="ds-hover-tint absolute"
              style={{
                top: 6,
                right: 6,
                width: 40,
                height: 40,
                display: "inline-flex",
                alignItems: "center",
                justifyContent: "center",
                borderRadius: 6,
                background: "color-mix(in oklab, var(--ds-bg) 70%, transparent)",
                color: "var(--ds-fg)",
                border: "1px solid var(--ds-border)",
                cursor: removing === key ? "progress" : undefined,
              }}
            >
              <X style={{ width: 14, height: 14 }} />
            </button>
          </div>
        );
      })}
    </div>
    {capped && (
      <p
        className="ds-mono"
        style={{ fontSize: 11.5, color: "var(--ds-fg-subtle)", marginTop: 14, marginBottom: 0 }}
      >
        {t("personal.common.showingMostRecent", { n: cap.toLocaleString(locale) })}
      </p>
    )}
    </>
  );
}
