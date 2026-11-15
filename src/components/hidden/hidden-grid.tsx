"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import Image from "next/image";
import { posterUrl } from "@/lib/tmdb-types";
import { X, Film, Tv2, EyeOff } from "@/components/icons";
import { hiddenFailureText, unhideTitle } from "@/lib/client/hidden-items";
import { EmptyState } from "@/components/ui/design";
import { useLocale, useT } from "@/components/i18n/i18n-provider";

export interface HiddenGridItem {
  tmdbId: number;
  mediaType: "MOVIE" | "TV";
  title: string;
  posterPath: string | null;
}

const itemKey = (x: HiddenGridItem) => `${x.tmdbId}:${x.mediaType}`;

function ErrorLine({ error }: { error: string | null }) {
  if (!error) return null;
  return (
    <p role="alert" className="text-red-400" style={{ fontSize: 13, marginBottom: 12 }}>
      {error}
    </p>
  );
}

// A drained capped slice is NOT a true empty list — older rows remain and this
// page is the only bulk un-hide UI. Matches the Library/Issues cap-banner tone
// and offers a reload so the next slice can appear.
function CappedEmptyNotice({ cap, pending, onReload }: { cap: number; pending: boolean; onReload: () => void }) {
  const t = useT();
  const locale = useLocale();
  return (
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
        onClick={onReload}
        disabled={pending}
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
          cursor: pending ? "progress" : undefined,
        }}
      >
        {pending ? t("personal.common.loading") : t("personal.common.reload")}
      </button>
    </div>
  );
}

function HiddenCard({ it, onUnhide }: { it: HiddenGridItem; onUnhide: () => void }) {
  const t = useT();
  const href = it.mediaType === "MOVIE" ? `/movie/${it.tmdbId}` : `/tv/${it.tmdbId}`;
  const poster = posterUrl(it.posterPath, "w342");
  return (
    <div className="relative">
      <Link href={href} className="block group">
        <div
          className="ds-card-lift relative overflow-hidden border border-[var(--ds-border)]"
          style={{ aspectRatio: "2 / 3", borderRadius: 8, background: "var(--ds-bg-3)", opacity: 0.75 }}
        >
          {poster ? (
            // Decorative: the title below is the link's label, so a named
            // poster read the title twice.
            <Image src={poster} alt="" fill className="object-cover" sizes="140px" />
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
        onClick={onUnhide}
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
        }}
      >
        <X style={{ width: 14, height: 14 }} />
      </button>
    </div>
  );
}

// Client grid for the /hidden page. Lists the user's "not interested" titles with
// an optimistic un-hide (X) that DELETEs the entry (restoring it to discovery).
// `cap` is the server page's `take`; `truncated` says the server had more rows
// than that (it reads cap + 1), so older titles exist that this page cannot
// show (and this is the only un-hide UI): a footer says so, and a drained slice
// offers a reload instead of the empty state.
export function HiddenGrid({
  initialItems,
  cap,
  truncated = false,
}: {
  initialItems: HiddenGridItem[];
  cap?: number;
  truncated?: boolean;
}) {
  const [error, setError] = useState<string | null>(null);
  const t = useT();
  const locale = useLocale();
  const router = useRouter();
  const [isPending, startTransition] = useTransition();
  // The titles this page un-hid (in flight or done). The grid is always the
  // server's latest list minus these, so a router.refresh() — the reload
  // below, or any other in the tree — shows what changed elsewhere while
  // keeping this page's optimistic un-hides. A failed un-hide leaves the set
  // and the tile is back at its own place in the server's order.
  const [removed, setRemoved] = useState<ReadonlySet<string>>(() => new Set());
  // A refreshed list is the new truth: drop the keys it no longer holds, so a
  // title hidden again elsewhere is not kept invisible by an old un-hide.
  const [seenItems, setSeenItems] = useState(initialItems);
  if (seenItems !== initialItems) {
    setSeenItems(initialItems);
    const present = new Set(initialItems.map(itemKey));
    const kept = [...removed].filter((k) => present.has(k));
    if (kept.length !== removed.size) setRemoved(new Set(kept));
  }
  const visible = initialItems.filter((x) => !removed.has(itemKey(x)));
  const capped = cap != null && truncated;

  async function unhide(it: HiddenGridItem) {
    const key = itemKey(it);
    setError(null);
    setRemoved((cur) => new Set(cur).add(key)); // optimistic
    // The shared /api/hidden client: the route's own reason (or the rate-limit
    // notice) when it gave one, else this title's sentence. Undo only THIS
    // item, so another whose concurrent DELETE already succeeded stays gone.
    const res = await unhideTitle(it);
    if (!res.ok) {
      setRemoved((cur) => {
        const next = new Set(cur);
        next.delete(key);
        return next;
      });
      const fallback = t("personal.hidden.unhideError", { title: it.title });
      setError(hiddenFailureText(res.failure, t, fallback, fallback) || fallback);
    }
  }

  if (visible.length === 0) {
    // A drained capped slice is NOT a true empty list — older rows remain
    // and this page is the only bulk un-hide UI. Match the Library/Issues
    // cap-banner tone and offer a reload so the next slice can appear.
    if (capped && cap != null) {
      return (
        <>
          <ErrorLine error={error} />
          <CappedEmptyNotice
            cap={cap}
            pending={isPending}
            onReload={() => {
              setError(null);
              startTransition(() => {
                router.refresh();
              });
            }}
          />
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
    <ErrorLine error={error} />
    <div className="grid gap-3" style={{ gridTemplateColumns: "repeat(auto-fill, minmax(140px, 1fr))" }}>
      {visible.map((it) => (
        <HiddenCard key={itemKey(it)} it={it} onUnhide={() => unhide(it)} />
      ))}
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
