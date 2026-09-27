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
  // True when the server's discover fetch failed. The page turns a failure
  // into `items: []`, so the empty-state branch below checks `!failed` —
  // otherwise a TMDB outage would also show the misleading "TMDB token not
  // configured" message next to the error banner.
  failed?: boolean;
  // True only when the server knows TMDB_READ_TOKEN is unset. An empty
  // unfiltered grid on a configured instance (a bookmarked `?page=N` past the
  // end, an empty upstream page) must not blame the token.
  tokenMissing?: boolean;
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
  tokenMissing,
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

  // The SERVER owns every filter and page change: the page reads the URL's
  // search params and renders `initialItems`, so this component does no
  // fetching of its own. (It used to re-fetch /api/browse on every change,
  // which doubled the work and could render different badges than the server.
  // /api/browse still exists because the iOS app uses it.)
  //
  // useTransition is React's built-in "a navigation is in progress" flag
  // (no client-state library — guardrail 9). FilterBar wraps its URL updates
  // in startTransition, so isPending stays true until the new server render
  // arrives, and we show a spinner over the grid meanwhile.
  const [isPending, startTransition] = useTransition();

  const items = initialItems;
  const totalPages = initialTotalPages;
  const currentPage = initialPage;

  // The "N results" / "Popular right now" line lives in the page's PageHeader
  // subtitle (movies/page.tsx, tv/page.tsx), not here.
  const hasFilters = !!(genreId || keywordId || minRating || ratingFilter || minVoteCount || fromYear || toYear || sortBy || watchProvider || hideAvailable);

  return (
    <>
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
                color: "var(--ds-accent-text)",
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
          ) : tokenMissing ? (
            <EmptyState
              icon={AlertTriangle}
              title="TMDB token not configured"
              description="Set TMDB_READ_TOKEN in your environment to enable discovery."
            />
          ) : (
            <EmptyState
              icon={Filter}
              title="No results on this page"
              description={
                currentPage > 1
                  ? "This page is past the end of the results."
                  : "TMDB returned nothing here — try again later."
              }
              cta={currentPage > 1 ? { href: pathname, label: "Back to page 1" } : undefined}
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
                // LCP (the page's main paint): preload the first row's
                // posters. Same value on the server and at hydration, so no
                // mismatch.
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
