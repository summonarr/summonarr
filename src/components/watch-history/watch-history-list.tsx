"use client";

// Self-service watch history list (the /watch-history page). Server-rendered
// first page arrives via props (the /notifications pattern) for the filters in
// the URL; filter changes and "Load more" refetch from /api/play-history/mine,
// which is scoped server-side to the caller's own linked media-server users.
// The filters are mirrored into the URL (?type=, ?q=) so a reload or a shared
// link keeps them. Relative-time cells are gated behind useHasMounted so SSR
// and hydration agree (guardrail 16).

import { memo, useEffect, useState } from "react";
import Link from "next/link";
import Image from "next/image";
import { Check, Clock, Film, Tv2 } from "@/components/icons";
import { useHasMounted } from "@/hooks/use-has-mounted";
import { formatRelativeTimeLocalized } from "@/lib/relative-time";
import { useLocale, useT } from "@/components/i18n/i18n-provider";
import { EmptyState, FilterBar, type FilterSegment } from "@/components/ui/design";
import { Button } from "@/components/ui/button";
import { ReportIssueButton } from "@/components/media/report-issue-button";
import { formatDurationHM } from "@/lib/format-duration";
import { episodeLabel } from "@/lib/episode-label";
import { mediaHref } from "@/lib/media-href";
import type { MyWatchHistoryItem, MyWatchHistoryPage } from "@/lib/my-watch-history";
import { useWatchHistory, type HistoryFailure, type TypeFilter } from "./use-watch-history";

export type { TypeFilter } from "./use-watch-history";

function episodeLine(item: MyWatchHistoryItem): string | null {
  const se = item.mediaType === "TV" ? episodeLabel(item.seasonNumber, item.episodeNumber) : null;
  if (!se) return null;
  return item.episodeTitle ? `${se} · ${item.episodeTitle}` : se;
}

const TYPE_SEGMENT_KEYS: readonly { value: TypeFilter; key: string }[] = [
  { value: "", key: "personal.common.all" },
  { value: "MOVIE", key: "personal.history.filter.movies" },
  { value: "TV", key: "personal.history.filter.tv" },
];

const SEARCH_DEBOUNCE_MS = 350;

type Translate = ReturnType<typeof useT>;

function failureText(f: HistoryFailure, fallback: string, t: Translate): string {
  if (!f.rateLimited) return fallback;
  return f.retryAfterSeconds === null
    ? t("shared.rateLimited.generic")
    : t("shared.rateLimited.seconds", { seconds: f.retryAfterSeconds });
}

/** Writes the filters into the address bar without a navigation: the list
 *  refetches on its own, and a replace adds no history entry per change. */
function syncFilterUrl(type: TypeFilter, search: string) {
  const url = new URL(window.location.href);
  if (type) url.searchParams.set("type", type);
  else url.searchParams.delete("type");
  if (search) url.searchParams.set("q", search);
  else url.searchParams.delete("q");
  if (url.href !== window.location.href) window.history.replaceState(window.history.state, "", url);
}

export function WatchHistoryList({
  initial,
  initialType = "",
  initialSearch = "",
  serverProvider,
  issuesEnabled,
}: {
  initial: MyWatchHistoryPage;
  /** The filters `initial` was read with (the URL's ?type= and ?q=). */
  initialType?: TypeFilter;
  initialSearch?: string;
  // True when the session's sign-in provider is Plex/Jellyfin — the account IS
  // a media-server identity, so an unlinked-empty state must never tell them
  // to "get linked"; there is simply no recorded history yet.
  serverProvider: boolean;
  // Row-level "Report issue" buttons render only when the issues feature is on.
  issuesEnabled: boolean;
}) {
  const t = useT();
  const [typeFilter, setTypeFilter] = useState<TypeFilter>(initialType);
  // The debounced, trimmed search; the text being typed lives in HistoryFilters.
  const [search, setSearch] = useState(initialSearch.trim());
  const history = useWatchHistory({ initial, initialType, initialSearch, typeFilter, search });
  // Stable for HistoryFilters' debounce effect, which lists it as a dependency.
  const [onSearch] = useState(() => (next: string) => setSearch(next));
  useEffect(() => {
    syncFilterUrl(typeFilter, search);
  }, [typeFilter, search]);

  if (!initial.linked) {
    return (
      <EmptyState
        icon={Clock}
        title={t("personal.history.emptyTitle")}
        description={
          serverProvider
            ? t("personal.history.emptyServer")
            : t("personal.history.emptyUnlinked")
        }
      />
    );
  }

  const filtersActive = typeFilter !== "" || search !== "";
  const { items, loadFailed } = history;

  return (
    <div>
      <HistoryFilters
        typeFilter={typeFilter}
        initialSearch={initialSearch}
        stats={initial.stats}
        onType={setTypeFilter}
        onSearch={onSearch}
      />

      {loadFailed ? (
        <div role="alert" className="flex flex-col items-center" style={{ gap: 10, padding: "24px 0" }}>
          <p className="ds-mono" style={{ fontSize: 11, color: "var(--ds-danger)", margin: 0 }}>
            {failureText(loadFailed, t("personal.history.loadFailed"), t)}
          </p>
          <Button
            variant="outline"
            size="sm"
            onClick={history.retry}
            disabled={history.refreshing || history.retryBlocked}
          >
            {t("shared.common.retry")}
          </Button>
        </div>
      ) : items.length === 0 ? (
        <EmptyState
          icon={Clock}
          title={filtersActive ? t("personal.history.noMatchTitle") : t("personal.history.emptyTitle")}
          description={
            filtersActive
              ? t("personal.history.noMatchDescription")
              : t("personal.history.noPlaysDescription")
          }
        />
      ) : (
        <div
          className="flex flex-col"
          style={{ gap: 8, opacity: history.refreshing ? 0.6 : 1, transition: "opacity 120ms" }}
        >
          {items.map((item) => (
            <HistoryRow key={item.id} item={item} issuesEnabled={issuesEnabled} />
          ))}
        </div>
      )}

      {history.nextCursor && items.length > 0 && (
        <div className="flex flex-col items-center gap-1.5" style={{ marginTop: 12 }}>
          <Button variant="outline" size="sm" onClick={history.loadMore} disabled={history.loadingMore}>
            {history.loadingMore
              ? t("personal.common.loading")
              : t("personal.common.loadMore", { count: Math.max(0, history.total - items.length) })}
          </Button>
          {history.loadMoreFailed && (
            <span role="alert" aria-live="assertive" className="text-xs text-red-400">
              {failureText(history.loadMoreFailed, t("personal.common.loadMoreError"), t)}
            </span>
          )}
        </div>
      )}
    </div>
  );
}

/** The type segments, the all-time summary and the search box. The text being
 *  typed lives here, so a keystroke re-renders only this bar; the list hears
 *  the debounced value. */
function HistoryFilters({
  typeFilter,
  initialSearch,
  stats,
  onType,
  onSearch,
}: {
  typeFilter: TypeFilter;
  initialSearch: string;
  stats: MyWatchHistoryPage["stats"];
  onType: (next: TypeFilter) => void;
  onSearch: (debounced: string) => void;
}) {
  const t = useT();
  const locale = useLocale();
  const [text, setText] = useState(initialSearch);
  useEffect(() => {
    const timer = setTimeout(() => onSearch(text.trim()), SEARCH_DEBOUNCE_MS);
    return () => clearTimeout(timer);
  }, [text, onSearch]);

  const typeSegments: readonly FilterSegment<TypeFilter>[] = TYPE_SEGMENT_KEYS.map((s) => ({
    value: s.value,
    label: t(s.key),
  }));

  return (
    <FilterBar
      segments={typeSegments}
      active={typeFilter}
      onChange={onType}
      label={t("personal.history.filter.label")}
      right={
        <div className="flex items-center flex-wrap" style={{ gap: 10 }}>
          <span className="ds-mono" style={{ fontSize: 11, color: "var(--ds-fg-subtle)" }}>
            {t("personal.history.summary", {
              count: stats.plays,
              duration: formatDurationHM(stats.playSeconds, locale),
            })}
          </span>
          <input
            type="search"
            value={text}
            onChange={(e) => setText(e.target.value)}
            placeholder={t("personal.common.searchTitles")}
            aria-label={t("personal.history.searchAria")}
            className="outline-none focus-visible:ring-2 focus-visible:ring-ring"
            style={{
              fontSize: 12,
              padding: "6px 10px",
              width: 170,
              background: "var(--ds-bg-1)",
              border: "1px solid var(--ds-border)",
              borderRadius: 6,
              color: "var(--ds-fg)",
            }}
          />
        </div>
      }
    />
  );
}

/** One consolidated history entry. Memoized: a keystroke, a refetch or Load
 *  more re-renders only the rows whose data changed. */
const HistoryRow = memo(function HistoryRow({
  item,
  issuesEnabled,
}: {
  item: MyWatchHistoryItem;
  issuesEnabled: boolean;
}) {
  const mounted = useHasMounted();
  const t = useT();
  const locale = useLocale();
  const href = mediaHref(item.tmdbId, item.mediaType);
  const episode = episodeLine(item);
  // Consolidated entries: progress and the duration figure reflect
  // the whole group's play time, not just the latest session.
  const groupSeconds = item.totalPlaySeconds;
  const pct =
    item.duration > 0
      ? Math.min(100, Math.round((groupSeconds / item.duration) * 100))
      : 0;
  const meta = item.platform ?? item.player ?? item.device;
  const row = (
    <>
      <span
        className="relative shrink-0 overflow-hidden"
        style={{
          width: 44,
          height: 66,
          borderRadius: 4,
          background: "var(--ds-bg-3)",
          border: "1px solid var(--ds-border)",
        }}
      >
        {item.posterUrl ? (
          <Image src={item.posterUrl} alt="" fill className="object-cover" sizes="44px" />
        ) : (
          <span
            className="flex items-center justify-center h-full"
            style={{ color: "var(--ds-fg-subtle)" }}
          >
            {item.mediaType === "TV" ? (
              <Tv2 style={{ width: 16, height: 16 }} />
            ) : (
              <Film style={{ width: 16, height: 16 }} />
            )}
          </span>
        )}
      </span>
      <span className="min-w-0 flex-1">
        <span
          className="flex items-center"
          style={{ gap: 6, fontSize: 13, fontWeight: 600, color: "var(--ds-fg)" }}
        >
          <span
            className="transition-colors group-hover:text-[var(--ds-accent-text)]"
            style={{
              overflow: "hidden",
              textOverflow: "ellipsis",
              whiteSpace: "nowrap",
              minWidth: 0,
            }}
          >
            {item.title}
          </span>
          {item.year && (
            <span style={{ fontWeight: 400, color: "var(--ds-fg-subtle)", flexShrink: 0 }}>
              {item.year}
            </span>
          )}
          {item.playCount > 1 && (
            <span
              className="ds-mono"
              title={t("personal.history.watchedTimes", { count: item.playCount })}
              style={{
                fontSize: 9.5,
                fontWeight: 400,
                padding: "2px 6px",
                borderRadius: 999,
                background: "color-mix(in oklab, var(--ds-fg) 6%, transparent)",
                color: "var(--ds-fg-subtle)",
                letterSpacing: "0.04em",
                whiteSpace: "nowrap",
                flexShrink: 0,
              }}
            >
              {item.playCount}×
            </span>
          )}
        </span>
        {episode && (
          <span
            className="ds-mono block"
            style={{
              fontSize: 10.5,
              color: "var(--ds-fg-muted)",
              marginTop: 2,
              overflow: "hidden",
              textOverflow: "ellipsis",
              whiteSpace: "nowrap",
            }}
          >
            {episode}
          </span>
        )}
        <span
          className="ds-mono flex items-center"
          style={{ gap: 6, fontSize: 10.5, color: "var(--ds-fg-subtle)", marginTop: 3 }}
        >
          <span
            aria-hidden
            style={{
              width: 5,
              height: 5,
              borderRadius: 999,
              flexShrink: 0,
              background:
                item.source === "plex" ? "var(--ds-plex)" : "var(--ds-jellyfin)",
            }}
          />
          <span>{item.source === "plex" ? "Plex" : "Jellyfin"}</span>
          {meta && <span>· {meta}</span>}
        </span>
      </span>
      <span
        className="flex flex-col items-end shrink-0"
        style={{ gap: 3, textAlign: "right" }}
      >
        <span
          className="ds-mono"
          style={{ fontSize: 10.5, color: "var(--ds-fg-subtle)" }}
          title={mounted ? new Date(item.startedAt).toLocaleString(locale) : undefined}
        >
          {mounted ? formatRelativeTimeLocalized(item.startedAt, locale) : ""}
        </span>
        <span className="ds-mono" style={{ fontSize: 10.5, color: "var(--ds-fg-muted)" }}>
          {formatDurationHM(groupSeconds, locale)}
        </span>
        {item.watched ? (
          <span
            className="flex items-center"
            style={{ gap: 3, fontSize: 10.5, color: "var(--ds-success)" }}
          >
            <Check style={{ width: 11, height: 11 }} /> {t("personal.history.watched")}
          </span>
        ) : (
          <span className="ds-mono" style={{ fontSize: 10.5, color: "var(--ds-fg-subtle)" }}>
            {pct}%
          </span>
        )}
      </span>
    </>
  );
  // Report button sits OUTSIDE the row link (a button inside an
  // anchor would navigate on click). Prefilled to the exact episode
  // for TV entries; unmatched rows (no tmdbId) can't be reported.
  const report =
    issuesEnabled && item.tmdbId != null && item.mediaType != null ? (
      <ReportIssueButton
        compact
        tmdbId={item.tmdbId}
        mediaType={item.mediaType}
        title={item.title}
        posterPath={item.posterPath}
        initialScope={
          item.mediaType === "TV" && item.seasonNumber != null ? "EPISODE" : "FULL"
        }
        initialSeasonNumber={item.seasonNumber}
        initialEpisodeNumber={item.episodeNumber}
      />
    ) : null;
  return (
    <div
      className="flex items-center transition-colors bg-[var(--ds-bg-2)] hover:bg-[var(--ds-bg-3)] border border-[var(--ds-border)]"
      style={{ gap: 14, padding: 14, borderRadius: 8 }}
    >
      {href ? (
        <Link
          href={href}
          className="flex items-center min-w-0 flex-1 group"
          style={{ gap: 14, textDecoration: "none" }}
        >
          {row}
        </Link>
      ) : (
        <span className="flex items-center min-w-0 flex-1" style={{ gap: 14 }}>
          {row}
        </span>
      )}
      {report}
    </div>
  );
});
