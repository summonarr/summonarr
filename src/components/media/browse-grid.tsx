"use client";

import { useTransition } from "react";
import { useSearchParams } from "next/navigation";
import type { TmdbMedia, Genre, WatchProvider } from "@/lib/tmdb-types";
import { MediaCard } from "./media-card";
import { FilterBar } from "./filter-bar";
import { PaginationBar } from "./pagination-bar";
import { Loader2, Filter, AlertTriangle } from "@/components/icons";
import { EmptyState } from "@/components/ui/design";
import { usePathname } from "next/navigation";

interface BrowseGridProps {
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
  // True when the server's discover fetch failed. Replaces the client fetch's
  // own error state: without it a TMDB outage renders an empty grid under the
  // "TMDB token not configured" empty state, which names the wrong cause. The
  // empty-state branch below is therefore gated on `!failed` — the page maps a
  // failure to `items: []`, so without that gate both the banner AND the
  // wrong-cause empty state rendered together.
  failed?: boolean;
}


export function BrowseGrid({
  initialItems,
  initialTotalPages,
  initialPage,
  genres,
  watchProviders,
  showPlex,
  showJellyfin,
  maxYear,
  failed,
}: BrowseGridProps) {
  const searchParams = useSearchParams();
  const pathname = usePathname();

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

  // The SERVER owns every filter and page change.
  //
  // This component used to re-run the whole discover + enrichment pipeline
  // against /api/browse on every search-param change — while the RSC page,
  // which reads searchParams and is force-dynamic, had already run the exact
  // same pipeline to produce `initialItems`. The two ran serially, so a filter
  // change cost both round-trips added together, roughly 30 DB queries instead
  // of 15, and the server's result was then thrown away unread: `hasFilters`
  // gated the sync effect specifically to stop it overwriting the client fetch.
  //
  // Worse than the waste, the two paths could disagree, and did — the route
  // resolved 4K visibility unscoped and badge visibility without the
  // integration flags, so page 1 (server) and page 2 (client) rendered
  // different badges and filtered differently. Deleting this fetch removes the
  // second path entirely rather than trying to keep two copies in step.
  //
  // /api/browse itself stays: the iOS client is its consumer.
  // React's own pending mechanism — no dependency, no client-state library
  // (guardrail 9). Strictly better than the spinner it replaces: that one was
  // driven by the client fetch, which only began AFTER the server render had
  // finished, so it covered the tail of the wait. isPending covers all of it.
  const [isPending, startTransition] = useTransition();

  const items = initialItems;
  const totalPages = initialTotalPages;
  const currentPage = initialPage;

  const hasFilters = !!(genreId || keywordId || minRating || ratingFilter || minVoteCount || fromYear || toYear || sortBy || watchProvider || hideAvailable);
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
        navigate={startTransition}
      />

      {failed && !isPending && (
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
          Couldn&apos;t load results from TMDB — try again.
        </div>
      )}

      <div className="relative min-h-[200px]">
        {isPending && (
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
        {items.length === 0 && !isPending && !failed ? (
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
            {items.map((media, i) => (
              <MediaCard
                key={media.id}
                media={media}
                showPlex={showPlex}
                showJellyfin={showJellyfin}
                size="md"
                // LCP: preload the first row's posters, but only for the
                // SSR'd list (items still references the initialItems prop —
                // client-fetched result pages load lazily as usual). Same
                // value on the server and at hydration, so no mismatch.
                priority={i < 6 && items === initialItems}
              />
            ))}
          </div>
        )}
      </div>

      <PaginationBar currentPage={currentPage} totalPages={totalPages} />
    </>
  );
}
