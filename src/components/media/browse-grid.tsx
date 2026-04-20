"use client";

import { useState, useEffect, useCallback, useTransition } from "react";
import { useRouter, usePathname, useSearchParams } from "next/navigation";
import type { TmdbMedia, Genre, WatchProvider } from "@/lib/tmdb-types";
import { MediaCard } from "./media-card";
import { FilterBar } from "./filter-bar";
import { PaginationBar } from "./pagination-bar";
import { Loader2 } from "lucide-react";

interface BrowseGridProps {
  mediaType: "movie" | "tv";
  initialItems: TmdbMedia[];
  initialTotalPages: number;
  initialPage: number;
  genres: Genre[];
  watchProviders: WatchProvider[];
  showPlex: boolean;
  showJellyfin: boolean;
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
}: BrowseGridProps) {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const [isPending, startTransition] = useTransition();

  const [items, setItems] = useState<TmdbMedia[]>(initialItems);
  const [totalPages, setTotalPages] = useState(initialTotalPages);
  const [currentPage, setCurrentPage] = useState(initialPage);
  const [loading, setLoading] = useState(false);

  const genreId       = searchParams.get("genreId") || undefined;
  const minRating     = searchParams.get("minRating") || undefined;
  const ratingFilter  = searchParams.get("ratingFilter") || undefined;
  const minVoteCount  = searchParams.get("minVoteCount") || undefined;
  const fromYear      = searchParams.get("fromYear") || undefined;
  const toYear        = searchParams.get("toYear") || undefined;
  const sortBy        = searchParams.get("sortBy") || undefined;
  const watchProvider = searchParams.get("watchProvider") || undefined;
  const hideAvailable = searchParams.get("hideAvailable") === "1";
  const page          = Math.max(1, parseInt(searchParams.get("page") ?? "1", 10) || 1);

  const fetchResults = useCallback(async () => {
    setLoading(true);
    try {
      const params = new URLSearchParams();
      params.set("mediaType", mediaType);
      params.set("page", String(page));
      if (genreId)       params.set("genreId", genreId);
      if (minRating)     params.set("minRating", minRating);
      if (ratingFilter)  params.set("ratingFilter", ratingFilter);
      if (minVoteCount)  params.set("minVoteCount", minVoteCount);
      if (fromYear)      params.set("fromYear", fromYear);
      if (toYear)        params.set("toYear", toYear);
      if (sortBy)        params.set("sortBy", sortBy);
      if (watchProvider) params.set("watchProvider", watchProvider);
      if (hideAvailable) params.set("hideAvailable", "1");

      const res = await fetch(`/api/browse?${params.toString()}`);
      if (!res.ok) return;
      const data = await res.json() as BrowseResult;
      setItems(data.items);
      setTotalPages(data.totalPages);
      setCurrentPage(data.page);
    } finally {
      setLoading(false);
    }
  }, [mediaType, page, genreId, minRating, ratingFilter, minVoteCount, fromYear, toYear, sortBy, watchProvider, hideAvailable]);

  const [isInitial, setIsInitial] = useState(true);
  useEffect(() => {
    if (isInitial) {
      setIsInitial(false);
      return;
    }
    fetchResults();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [fetchResults]);

  const hasFilters = !!(genreId || minRating || ratingFilter || minVoteCount || fromYear || toYear || sortBy || watchProvider || hideAvailable);
  const subtitle = hasFilters ? `${items.length} results` : "Popular right now";

  return (
    <>
      <p className="text-zinc-400 text-sm mb-6">{subtitle}</p>

      <FilterBar
        genres={genres}
        watchProviders={watchProviders}
        activeGenreId={genreId}
        activeMinRating={minRating}
        activeRatingFilter={ratingFilter}
        activeMinVoteCount={minVoteCount}
        activeFromYear={fromYear}
        activeToYear={toYear}
        activeSortBy={sortBy}
        activeWatchProvider={watchProvider}
        activeHideAvailable={hideAvailable}
      />

      <div className="relative min-h-[200px]">
        {loading && (
          <div className="absolute inset-0 z-10 flex items-center justify-center bg-zinc-950/60 rounded-lg">
            <Loader2 className="w-8 h-8 text-indigo-400 animate-spin" />
          </div>
        )}
        {items.length === 0 && !loading ? (
          <div className="text-zinc-500 text-sm">
            {hasFilters
              ? `No ${mediaType === "tv" ? "TV shows" : "movies"} match these filters.`
              : "No results — set TMDB_READ_TOKEN (or TMDB_API_KEY) in .env.local."}
          </div>
        ) : (
          <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5 xl:grid-cols-6 gap-5">
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
