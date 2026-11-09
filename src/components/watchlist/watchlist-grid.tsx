"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import Image from "next/image";
import { posterUrl } from "@/lib/tmdb-types";
import { mediaHref } from "@/lib/media-href";
import { X, Film, Tv2, Bookmark } from "@/components/icons";
import { withBasePath } from "@/lib/base-path";
import { EmptyState } from "@/components/ui/design";
import { useLocale, useT } from "@/components/i18n/i18n-provider";
import { timedFetch } from "@/lib/client/fetch-json";
import { rateLimitMessage } from "@/lib/client/rate-limit";
import { useAsyncAction } from "@/hooks/use-async-action";

export interface WatchlistGridItem {
  tmdbId: number;
  mediaType: "MOVIE" | "TV";
  title: string;
  posterPath: string | null;
}

const itemKey = (x: WatchlistGridItem) => `${x.tmdbId}:${x.mediaType}`;

/** Every title on this slice was removed but the server holds more: offer a
 *  reload instead of the "empty" state. */
function CappedEmptyNotice({ cap, onReload }: { cap: number; onReload: () => void }) {
  const t = useT();
  const locale = useLocale();
  const router = useRouter();
  const [isPending, startTransition] = useTransition();
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
        onClick={() => {
          onReload();
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
  );
}

// Client grid for the /watchlist page. Renders poster cards linking to the detail
// page, each with an optimistic remove (X) control that DELETEs the entry.
// `cap` is the server page's `take`; `truncated` says the server had more rows
// than that (it reads cap + 1), so older titles exist that this page cannot
// show and a footer says so.
export function WatchlistGrid({
  initialItems,
  cap,
  truncated = false,
}: {
  initialItems: WatchlistGridItem[];
  cap?: number;
  truncated?: boolean;
}) {
  const t = useT();
  const locale = useLocale();
  const [error, setError] = useState<string | null>(null);
  // The titles this page removed (in flight or done). The grid is always the
  // server's latest list minus these, so a router.refresh() — the reload
  // below, or any other in the tree — shows what changed elsewhere while
  // keeping this page's optimistic removes. A failed remove leaves the set
  // and the tile is back at its own place in the server's order.
  const action = useAsyncAction();
  const [removed, setRemoved] = useState<ReadonlySet<string>>(() => new Set());
  const visible = initialItems.filter((x) => !removed.has(itemKey(x)));
  const capped = cap != null && truncated;

  async function remove(it: WatchlistGridItem) {
    const key = itemKey(it);
    setError(null);
    setRemoved((cur) => new Set(cur).add(key)); // optimistic
    // Undo only THIS item, so another item whose concurrent DELETE already
    // succeeded stays gone.
    const restore = (limited: string | null) => {
      setRemoved((cur) => {
        const next = new Set(cur);
        next.delete(key);
        return next;
      });
      setError(limited ?? t("personal.watchlist.removeError", { title: it.title }));
    };
    const outcome = await action.run(
      `remove:${key}`,
      async (signal) => {
        try {
          const res = await timedFetch(
            withBasePath(`/api/watchlist?tmdbId=${it.tmdbId}&mediaType=${it.mediaType}`),
            { method: "DELETE", signal },
          );
          return res.ok ? { ok: true as const } : { ok: false as const, limited: rateLimitMessage(res, t) };
        } catch {
          return { ok: false as const, limited: null };
        }
      },
      { ifBusy: "skip" },
    );
    if (outcome && !outcome.ok) restore(outcome.limited);
  }

  const errorLine = error && (
    <p role="alert" className="text-red-400" style={{ fontSize: 13, marginBottom: 12 }}>
      {error}
    </p>
  );

  if (visible.length === 0) {
    // A drained capped slice is NOT a true empty list — older rows remain
    // and this page is the only bulk remove UI. Match the Library/Issues
    // cap-banner tone and offer a reload so the next slice can appear.
    if (capped && cap != null) {
      return (
        <>
          {errorLine}
          <CappedEmptyNotice cap={cap} onReload={() => setError(null)} />
        </>
      );
    }
    return (
      <EmptyState
        icon={Bookmark}
        title={t("personal.watchlist.emptyTitle")}
        description={t("personal.watchlist.emptyDescription")}
        cta={{ href: "/movies", label: t("personal.common.browseMovies") }}
      />
    );
  }

  return (
    <>
    {errorLine}
    <div className="grid gap-3" style={{ gridTemplateColumns: "repeat(auto-fill, minmax(140px, 1fr))" }}>
      {visible.map((it) => (
        <WatchlistCard key={itemKey(it)} item={it} onRemove={remove} />
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

function WatchlistCard({
  item: it,
  onRemove,
}: {
  item: WatchlistGridItem;
  onRemove: (it: WatchlistGridItem) => void;
}) {
  const t = useT();
  // mediaType is always MOVIE or TV here, so the link always exists.
  const href = mediaHref(it.tmdbId, it.mediaType) ?? "#";
  const poster = posterUrl(it.posterPath, "w342");
  return (
    <div className="relative">
      <Link href={href} className="block group">
        <div
          className="ds-card-lift relative overflow-hidden border border-[var(--ds-border)]"
          style={{ aspectRatio: "2 / 3", borderRadius: 8, background: "var(--ds-bg-3)" }}
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
          poster link, so a near-miss navigates instead of removing. */}
      <button
        type="button"
        onClick={() => onRemove(it)}
        aria-label={t("personal.watchlist.removeAria", { title: it.title })}
        title={t("personal.watchlist.remove")}
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
