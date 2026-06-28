"use client";

import { useState, useEffect, useCallback } from "react";
import { useSearchParams } from "next/navigation";
import type { TmdbMedia, Genre, WatchProvider } from "@/lib/tmdb-types";
import { MediaCard } from "./media-card";
import { FilterBar } from "./filter-bar";
import { PaginationBar } from "./pagination-bar";
import { Loader2, Filter, AlertTriangle } from "@/components/icons";
import { EmptyState } from "@/components/ui/design";
import { usePathname } from "next/navigation";
import { withBasePath } from "@/lib/base-path";

interface BrowseGridProps {
  mediaType: "movie" | "tv";
  initialItems: TmdbMedia[];
  initialTotalPages: number;
  initialPage: number;
  genres: Genre[];
  watchProviders: WatchProvider[];
  showPlex: boolean;
  showJellyfin: boolean;
  // Latest year to show in From/To Year filter dropdowns. Computed by the
  // server page so SSR and hydration match — see filter-bar.tsx.
  maxYear: number;
}

interface BrowseResult {
  items: TmdbMedia[];
  totalPages: number;
  page: number;
}

export function BrowseGrid({
  mediaType,
  initialItems,
  initialTotalPages,
  initialPage,
  genres,
  watchProviders,
  showPlex,
  showJellyfin,
  maxYear,
}: BrowseGridProps) {
  const searchParams = useSearchParams();
  const pathname = usePathname();

  const [items, setItems] = useState<TmdbMedia[]>(initialItems);
  const [totalPages, setTotalPages] = useState(initialTotalPages);
  const [currentPage, setCurrentPage] = useState(initialPage);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(false);

  const genreId       = searchParams.get("genreId") || undefined;
  const keywordId     = searchParams.get("keywordId") || undefined;
  const keywordName   = searchParams.get("keywordName") || undefined;
  const minRating     = searchParams.get("minRating") || undefined;
  const ratingFilter  = searchParams.get("ratingFilter") || undefined;
  const minVoteCount  = searchParams.get("minVoteCount") || undefined;
  const fromYear      = searchParams.get("fromYear") || undefined;
  const toYear        = searchParams.get("toYear") || undefined;
  const sortBy        = searchParams.get("sortBy") || undefined;
  const watchProvider = searchParams.get("watchProvider") || undefined;
  const hideAvailable = searchParams.get("hideAvailable") === "1";
  const page          = Math.max(1, parseInt(searchParams.get("page") ?? "1", 10) || 1);

  const fetchResults = useCallback(async (signal?: AbortSignal) => {
    setLoading(true);
    try {
      const params = new URLSearchParams();
      params.set("mediaType", mediaType);
      params.set("page", String(page));
      if (genreId)       params.set("genreId", genreId);
      if (keywordId)     params.set("keywordId", keywordId);
      if (minRating)     params.set("minRating", minRating);
      if (ratingFilter)  params.set("ratingFilter", ratingFilter);
      if (minVoteCount)  params.set("minVoteCount", minVoteCount);
      if (fromYear)      params.set("fromYear", fromYear);
      if (toYear)        params.set("toYear", toYear);
      if (sortBy)        params.set("sortBy", sortBy);
      if (watchProvider) params.set("watchProvider", watchProvider);
      if (hideAvailable) params.set("hideAvailable", "1");

      const res = await fetch(withBasePath(`/api/browse?${params.toString()}`), { signal });
      if (!res.ok) {
        setError(true);
        return;
      }
      const data = await res.json() as BrowseResult;
      setItems(data.items);
      setTotalPages(data.totalPages);
      setCurrentPage(data.page);
      setError(false);
    } catch (err) {
      // A superseded fetch (filters changed mid-flight) is aborted — ignore it so
      // the newer request's results aren't clobbered by this stale one. Leave the
      // prior results in place on any other error.
      if ((err as Error)?.name === "AbortError") return;
      setError(true);
    } finally {
      if (!signal?.aborted) setLoading(false);
    }
  }, [mediaType, page, genreId, keywordId, minRating, ratingFilter, minVoteCount, fromYear, toYear, sortBy, watchProvider, hideAvailable]);

  const hasFilters = !!(genreId || keywordId || minRating || ratingFilter || minVoteCount || fromYear || toYear || sortBy || watchProvider || hideAvailable);

  const [isInitial, setIsInitial] = useState(true);
  useEffect(() => {
    if (isInitial) {
      setIsInitial(false);
      return;
    }
    const controller = new AbortController();
    fetchResults(controller.signal);
    return () => controller.abort();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [fetchResults]);

  // On the unfiltered grid the server component is the source of truth, so a
  // router.refresh() (driven by LiveRefresh on request:* SSE events) passes
  // fresh initialItems that must replace local state. With filters active the
  // grid is client-fetched, so leave that state untouched.
  useEffect(() => {
    if (hasFilters) return;
    setItems(initialItems);
    setTotalPages(initialTotalPages);
    setCurrentPage(initialPage);
  }, [initialItems, initialTotalPages, initialPage, hasFilters]);
  const subtitle = hasFilters ? `${items.length} results` : "Popular right now";

  return (
    <>
      <p
        className="ds-mono"
        style={{
          fontSize: 12,
          color: "var(--ds-fg-subtle)",
          marginTop: -12,
          marginBottom: 16,
        }}
      >
        {subtitle}
      </p>

      <FilterBar
        genres={genres}
        watchProviders={watchProviders}
        activeGenreId={genreId}
        activeKeywordId={keywordId}
        activeKeywordName={keywordName}
        activeMinRating={minRating}
        activeRatingFilter={ratingFilter}
        activeMinVoteCount={minVoteCount}
        activeFromYear={fromYear}
        activeToYear={toYear}
        activeSortBy={sortBy}
        activeWatchProvider={watchProvider}
        activeHideAvailable={hideAvailable}
        maxYear={maxYear}
      />

      {error && !loading && (
        <div
          role="alert"
          className="ds-mono"
          style={{
            display: "flex",
            alignItems: "center",
            gap: 8,
            fontSize: 12,
            color: "var(--ds-danger)",
            background: "color-mix(in oklab, var(--ds-danger) 12%, transparent)",
            border: "1px solid color-mix(in oklab, var(--ds-danger) 35%, transparent)",
            borderRadius: 8,
            padding: "8px 12px",
            marginBottom: 12,
          }}
        >
          <AlertTriangle style={{ width: 14, height: 14, flexShrink: 0 }} />
          Couldn&apos;t load results. Showing the previous view — try again.
        </div>
      )}

      <div className="relative min-h-[200px]">
        {loading && (
          <div
            className="absolute inset-0 z-10 flex items-center justify-center"
            style={{
              background:
                "color-mix(in oklab, var(--ds-bg) 65%, transparent)",
              borderRadius: 8,
            }}
          >
            <Loader2
              className="animate-spin"
              style={{
                width: 28,
                height: 28,
                color: "var(--ds-accent)",
              }}
            />
          </div>
        )}
        {items.length === 0 && !loading ? (
          hasFilters ? (
            <EmptyState
              icon={Filter}
              title="No results match these filters"
              description="Try removing one or two filters to see more."
              cta={{ href: pathname, label: "Clear filters" }}
            />
          ) : (
            <EmptyState
              icon={AlertTriangle}
              title="TMDB token not configured"
              description="Set TMDB_READ_TOKEN in your environment to enable discovery."
            />
          )
        ) : (
          <div className="ds-media-grid">
            {items.map((media) => (
              <MediaCard key={media.id} media={media} showPlex={showPlex} showJellyfin={showJellyfin} size="md" />
            ))}
          </div>
        )}
      </div>

      <PaginationBar currentPage={currentPage} totalPages={totalPages} />
    </>
  );
}
