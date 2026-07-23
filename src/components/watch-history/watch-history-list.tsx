"use client";

// Self-service watch history list (the /watch-history page). Server-rendered
// first page arrives via props (the /notifications pattern); filter changes and
// "Load more" refetch from /api/play-history/mine, which is scoped server-side
// to the caller's own linked media-server users. Relative-time cells are gated
// behind useHasMounted so SSR and hydration agree (guardrail 16).

import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import Image from "next/image";
import { Check, Film, Tv2 } from "@/components/icons";
import { withBasePath } from "@/lib/base-path";
import { useHasMounted } from "@/hooks/use-has-mounted";
import { formatRelativeTime } from "@/lib/relative-time";
import { EmptyState } from "@/components/ui/empty-state";
import type { MyWatchHistoryItem, MyWatchHistoryPage } from "@/lib/my-watch-history";

// Local copy of the tiny duration formatter (activity-ui's fmtDuration) so the
// user-facing bundle doesn't pull in the whole admin activity chart module.
function fmtDuration(seconds: number): string {
  if (!seconds || seconds <= 0) return "—";
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  if (h > 0) return `${h}h ${m}m`;
  if (m > 0) return `${m}m`;
  return `${Math.round(seconds)}s`;
}

function episodeLine(item: MyWatchHistoryItem): string | null {
  if (item.mediaType !== "TV" || item.seasonNumber == null) return null;
  const se = `S${String(item.seasonNumber).padStart(2, "0")} · E${String(item.episodeNumber ?? 0).padStart(2, "0")}`;
  return item.episodeTitle ? `${se} · ${item.episodeTitle}` : se;
}

function mediaHref(item: MyWatchHistoryItem): string | null {
  if (item.tmdbId == null || item.mediaType == null) return null;
  return item.mediaType === "TV" ? `/tv/${item.tmdbId}` : `/movie/${item.tmdbId}`;
}

type TypeFilter = "" | "MOVIE" | "TV";

export function WatchHistoryList({
  initial,
  serverProvider,
}: {
  initial: MyWatchHistoryPage;
  // True when the session's sign-in provider is Plex/Jellyfin — the account IS
  // a media-server identity, so an unlinked-empty state must never tell them
  // to "get linked"; there is simply no recorded history yet.
  serverProvider: boolean;
}) {
  const mounted = useHasMounted();

  const [items, setItems] = useState<MyWatchHistoryItem[]>(initial.items);
  const [total, setTotal] = useState(initial.total);
  const [nextCursor, setNextCursor] = useState(initial.nextCursor);
  const [typeFilter, setTypeFilter] = useState<TypeFilter>("");
  const [search, setSearch] = useState("");
  const [debouncedSearch, setDebouncedSearch] = useState("");
  const [refreshing, setRefreshing] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const t = setTimeout(() => setDebouncedSearch(search), 350);
    return () => clearTimeout(t);
  }, [search]);

  // Refetch from page one when a filter changes. The first render already has
  // the server-fetched unfiltered page, so skip the initial run.
  const firstRender = useRef(true);
  useEffect(() => {
    if (firstRender.current) {
      firstRender.current = false;
      return;
    }
    const ac = new AbortController();
    setRefreshing(true);
    setError(null);
    const params = new URLSearchParams();
    if (typeFilter) params.set("mediaType", typeFilter);
    if (debouncedSearch.trim()) params.set("search", debouncedSearch.trim());
    fetch(withBasePath(`/api/play-history/mine?${params.toString()}`), { signal: ac.signal })
      .then((r) => {
        if (!r.ok) throw new Error(`Fetch failed: ${r.status}`);
        return r.json();
      })
      .then((data: MyWatchHistoryPage) => {
        setItems(data.items);
        setTotal(data.total);
        setNextCursor(data.nextCursor);
        setRefreshing(false);
      })
      .catch((err) => {
        if (err instanceof DOMException && err.name === "AbortError") return;
        console.error("[watch-history]", err);
        setError("Failed to load watch history");
        setRefreshing(false);
      });
    return () => ac.abort();
  }, [typeFilter, debouncedSearch]);

  async function loadMore() {
    if (!nextCursor) return;
    setLoadingMore(true);
    try {
      const params = new URLSearchParams();
      if (typeFilter) params.set("mediaType", typeFilter);
      if (debouncedSearch.trim()) params.set("search", debouncedSearch.trim());
      params.set("cursor", nextCursor);
      const res = await fetch(withBasePath(`/api/play-history/mine?${params.toString()}`));
      if (res.ok) {
        const data = (await res.json()) as MyWatchHistoryPage;
        // De-dup by id — a row could shift into an already-loaded page as new
        // plays finalize between fetches.
        setItems((cur) => {
          const seen = new Set(cur.map((i) => i.id));
          return [...cur, ...data.items.filter((i) => !seen.has(i.id))];
        });
        setTotal(data.total);
        setNextCursor(data.nextCursor);
      }
    } finally {
      setLoadingMore(false);
    }
  }

  if (!initial.linked) {
    return (
      <EmptyState>
        {serverProvider
          ? "No watch history yet — what you watch on the server will show up here."
          : "No watch history yet. Activity appears here once your account is linked to a Plex or Jellyfin user — linking happens automatically when the media-server account uses the same email address, or an admin can link it manually."}
      </EmptyState>
    );
  }

  const filtersActive = typeFilter !== "" || debouncedSearch.trim() !== "";

  return (
    <div>
      <div
        className="flex flex-wrap items-center justify-between"
        style={{ gap: 10, marginBottom: 12 }}
      >
        <span className="ds-mono" style={{ fontSize: 11, color: "var(--ds-fg-subtle)" }}>
          {initial.stats.plays} {initial.stats.plays === 1 ? "play" : "plays"} ·{" "}
          {fmtDuration(initial.stats.playSeconds)} watched
        </span>
        <div className="flex items-center" style={{ gap: 8 }}>
          <div
            className="flex items-center"
            style={{
              gap: 2,
              padding: 2,
              background: "var(--ds-bg-2)",
              border: "1px solid var(--ds-border)",
              borderRadius: 7,
            }}
          >
            {([
              ["", "All"],
              ["MOVIE", "Movies"],
              ["TV", "TV"],
            ] as const).map(([value, label]) => (
              <button
                key={value}
                type="button"
                onClick={() => setTypeFilter(value)}
                style={{
                  fontSize: 11.5,
                  padding: "4px 10px",
                  borderRadius: 5,
                  cursor: "pointer",
                  background: typeFilter === value ? "var(--ds-bg-3)" : "transparent",
                  color: typeFilter === value ? "var(--ds-fg)" : "var(--ds-fg-subtle)",
                }}
              >
                {label}
              </button>
            ))}
          </div>
          <input
            type="search"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search titles…"
            aria-label="Search watch history"
            style={{
              fontSize: 12,
              padding: "6px 10px",
              width: 170,
              background: "var(--ds-bg-2)",
              border: "1px solid var(--ds-border)",
              borderRadius: 7,
              color: "var(--ds-fg)",
              outline: "none",
            }}
          />
        </div>
      </div>

      {error && (
        <p className="ds-mono" style={{ fontSize: 11, color: "var(--ds-danger)", margin: "0 0 10px" }}>
          {error}
        </p>
      )}

      {items.length === 0 ? (
        <EmptyState>
          {filtersActive
            ? "No plays match your filters."
            : "No watch history yet — plays on the media server will show up here."}
        </EmptyState>
      ) : (
        <div
          className="flex flex-col"
          style={{ gap: 8, opacity: refreshing ? 0.6 : 1, transition: "opacity 120ms" }}
        >
          {items.map((item) => {
            const href = mediaHref(item);
            const episode = episodeLine(item);
            // Consolidated entries: progress and the duration figure reflect
            // the whole group's play time, not just the latest session.
            const groupSeconds = item.totalPlaySeconds ?? item.playDuration;
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
                    width: 40,
                    height: 60,
                    borderRadius: 4,
                    background: "var(--ds-bg-3)",
                    border: "1px solid var(--ds-border)",
                  }}
                >
                  {item.posterUrl ? (
                    <Image src={item.posterUrl} alt="" fill className="object-cover" sizes="40px" />
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
                    {(item.playCount ?? 1) > 1 && (
                      <span
                        className="ds-mono"
                        title={`Watched ${item.playCount} times — showing the latest play`}
                        style={{
                          fontSize: 9.5,
                          fontWeight: 400,
                          padding: "2px 6px",
                          borderRadius: 999,
                          background: "oklch(1 0 0 / 0.06)",
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
                    title={mounted ? new Date(item.startedAt).toLocaleString() : undefined}
                  >
                    {mounted ? formatRelativeTime(item.startedAt) : ""}
                  </span>
                  <span className="ds-mono" style={{ fontSize: 10.5, color: "var(--ds-fg-muted)" }}>
                    {fmtDuration(groupSeconds)}
                  </span>
                  {item.watched ? (
                    <span
                      className="flex items-center"
                      style={{ gap: 3, fontSize: 10.5, color: "var(--ds-success)" }}
                    >
                      <Check style={{ width: 11, height: 11 }} /> Watched
                    </span>
                  ) : (
                    <span className="ds-mono" style={{ fontSize: 10.5, color: "var(--ds-fg-subtle)" }}>
                      {pct}%
                    </span>
                  )}
                </span>
              </>
            );
            const rowStyle = {
              padding: "10px 12px",
              borderRadius: 8,
              background: "var(--ds-bg-1)",
              border: "1px solid var(--ds-border)",
            } as const;
            return href ? (
              <Link
                key={item.id}
                href={href}
                className="flex gap-3 items-center"
                style={{ ...rowStyle, textDecoration: "none" }}
              >
                {row}
              </Link>
            ) : (
              <div key={item.id} className="flex gap-3 items-center" style={rowStyle}>
                {row}
              </div>
            );
          })}
        </div>
      )}

      {nextCursor && items.length > 0 && (
        <div className="flex justify-center" style={{ marginTop: 12 }}>
          <button
            type="button"
            onClick={loadMore}
            disabled={loadingMore}
            className="rounded-md border border-zinc-700 bg-zinc-800 hover:bg-zinc-700 disabled:opacity-50 px-4 py-1.5 text-xs text-zinc-200 transition-colors"
          >
            {loadingMore ? "Loading…" : `Load more (${Math.max(0, total - items.length)})`}
          </button>
        </div>
      )}
    </div>
  );
}
