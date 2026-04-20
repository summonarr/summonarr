export const dynamic = "force-dynamic";

import { getMostPopularOnServer, POPULAR_PER_PAGE, type PopularSort } from "@/lib/play-history";
import { getMovieDetails, getTVDetails } from "@/lib/tmdb";
import type { TmdbMedia } from "@/lib/tmdb-types";
import { prisma } from "@/lib/prisma";
import { MediaCard } from "@/components/media/media-card";
import { PaginationBar } from "@/components/media/pagination-bar";
import { attachAllAvailability } from "@/lib/attach-all";
import { auth } from "@/lib/auth";
import { getBadgeVisibility } from "@/lib/badge-visibility";
import { LiveRefresh } from "@/components/live-refresh";
import Link from "next/link";
import { cn } from "@/lib/utils";
import { Suspense } from "react";

type EnrichedMedia = TmdbMedia & {
  plays: number;
  allTimePlays: number;
  viewers: number;
  episodes: number;
  totalHours: number;
};

const SORT_OPTIONS: { value: PopularSort; label: string; description: string }[] = [
  { value: "trending", label: "Trending", description: "Most played in the last 30 days" },
  { value: "viewers", label: "Most Viewers", description: "Ranked by number of unique viewers" },
  { value: "plays", label: "Most Played", description: "Ranked by total play count across all users" },
];

const TYPE_OPTIONS = [
  { label: "All", value: undefined },
  { label: "Movies", value: "movies" },
  { label: "TV Shows", value: "tv" },
] as const;

export default async function PopularOnServerPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string>>;
}) {
  const [sp, session] = await Promise.all([searchParams, auth()]);
  if (!session) return null;
  const { showPlex, showJellyfin } = getBadgeVisibility(session);

  const mediaTypeFilter = sp.mediaType || undefined;
  const validSorts = new Set<PopularSort>(["plays", "viewers", "trending"]);
  const sort: PopularSort = validSorts.has(sp.sort as PopularSort)
    ? (sp.sort as PopularSort)
    : "trending";
  const page = Math.max(1, parseInt(sp.page ?? "1", 10) || 1);

  const activeSort = SORT_OPTIONS.find((s) => s.value === sort)!;

  const [moviesResult, tvResult] = await Promise.all([
    mediaTypeFilter === "tv"
      ? Promise.resolve({ items: [], totalItems: 0, totalPages: 1, page: 1 })
      : getMostPopularOnServer({ mediaType: "MOVIE", sort, page }),
    mediaTypeFilter === "movies"
      ? Promise.resolve({ items: [], totalItems: 0, totalPages: 1, page: 1 })
      : getMostPopularOnServer({ mediaType: "TV", sort, page }),
  ]);

  const totalPages = Math.max(moviesResult.totalPages, tvResult.totalPages);
  const totalMovies = moviesResult.totalItems;
  const totalTv = tvResult.totalItems;

  async function resolveMedia(
    items: typeof moviesResult.items,
    type: "movie" | "tv",
  ): Promise<EnrichedMedia[]> {
    if (items.length === 0) return [];
    const dbType = type === "movie" ? "MOVIE" : "TV";

    const coreRows = await prisma.tmdbMediaCore.findMany({
      where: {
        OR: items.map((i) => ({ tmdbId: i.tmdbId, mediaType: dbType, expiresAt: { gt: new Date() } })),
      },
    });
    const coreMap = new Map(coreRows.map((r) => [r.tmdbId, r]));

    const results = await Promise.allSettled(
      items.map(async (item) => {
        const core = coreMap.get(item.tmdbId);
        const details: TmdbMedia = core
          ? {
              id: item.tmdbId,
              mediaType: type,
              title: core.title,
              overview: "",
              posterPath: core.posterPath ?? null,
              backdropPath: null,
              releaseDate: null,
              releaseYear: core.releaseYear ?? "",
              voteAverage: core.voteAverage,
              certification: core.certification ?? undefined,
            }
          :
            type === "movie"
            ? await getMovieDetails(item.tmdbId)
            : await getTVDetails(item.tmdbId);
        return {
          ...details,
          plays: item.plays,
          allTimePlays: item.allTimePlays,
          viewers: item.viewers,
          episodes: item.episodes,
          totalHours: item.totalHours,
        };
      }),
    );
    return results
      .filter((r): r is PromiseFulfilledResult<EnrichedMedia> => r.status === "fulfilled")
      .map((r) => r.value);
  }

  let [movies, tv] = await Promise.all([
    resolveMedia(moviesResult.items, "movie"),
    resolveMedia(tvResult.items, "tv"),
  ]);

  async function enrich(items: EnrichedMedia[]): Promise<EnrichedMedia[]> {
    return (await attachAllAvailability(items, session?.user.id)) as EnrichedMedia[];
  }

  [movies, tv] = await Promise.all([enrich(movies), enrich(tv)]);

  const showMovies = mediaTypeFilter !== "tv";
  const showTV = mediaTypeFilter !== "movies";
  const hasAny = movies.length > 0 || tv.length > 0;

  const rankOffset = (page - 1) * POPULAR_PER_PAGE;

  function buildHref(overrides: Record<string, string | undefined>) {
    const merged: Record<string, string> = {};
    if (mediaTypeFilter) merged.mediaType = mediaTypeFilter;
    if (sort !== "trending") merged.sort = sort;
    for (const [k, v] of Object.entries(overrides)) {
      if (v) merged[k] = v;
      else delete merged[k];
    }
    delete merged.page;
    const qs = new URLSearchParams(merged).toString();
    return qs ? `/popular?${qs}` : "/popular";
  }

  return (
    <div>
      <LiveRefresh on={["request:new", "request:updated", "request:deleted"]} />
      <h1 className="text-2xl font-bold mb-1">Popular on Server</h1>
      <p className="text-zinc-400 text-sm mb-5">{activeSort.description}</p>

      <div className="flex flex-col sm:flex-row gap-3 mb-6">
        <div className="flex gap-2">
          {SORT_OPTIONS.map(({ value, label }) => (
            <Link
              key={value}
              href={buildHref({ sort: value === "trending" ? undefined : value })}
              className={cn(
                "px-3 py-1.5 rounded-full text-sm font-medium transition-colors",
                sort === value
                  ? "bg-indigo-600 text-white"
                  : "bg-zinc-800 text-zinc-400 hover:text-white hover:bg-zinc-700",
              )}
            >
              {label}
            </Link>
          ))}
        </div>

        <div className="hidden sm:block w-px bg-zinc-700 mx-1" />

        <div className="flex gap-2">
          {TYPE_OPTIONS.map(({ label, value }) => (
            <Link
              key={label}
              href={buildHref({ mediaType: value })}
              className={cn(
                "px-3 py-1.5 rounded-full text-sm font-medium transition-colors",
                mediaTypeFilter === value
                  ? "bg-zinc-600 text-white"
                  : "bg-zinc-800 text-zinc-400 hover:text-white hover:bg-zinc-700",
              )}
            >
              {label}
            </Link>
          ))}
        </div>
      </div>

      {!hasAny ? (
        <div className="text-zinc-500 text-sm">
          {sort === "trending"
            ? "No plays in the last 30 days — try switching to Most Played for all-time data."
            : page > 1
              ? "No more results on this page."
              : "No play history yet — data will appear once media is played on your servers."}
        </div>
      ) : (
        <div className="space-y-10">
          {showMovies && movies.length > 0 && (
            <section>
              <h2 className="text-lg font-semibold text-white mb-4">
                Movies
                <span className="ml-2 text-sm font-normal text-zinc-400">
                  {rankOffset + 1}–{rankOffset + movies.length} of {totalMovies} titles
                </span>
              </h2>
              <MediaGrid items={movies} showPlex={showPlex} showJellyfin={showJellyfin} sort={sort} rankOffset={rankOffset} />
            </section>
          )}

          {showTV && tv.length > 0 && (
            <section>
              <h2 className="text-lg font-semibold text-white mb-4">
                TV Shows
                <span className="ml-2 text-sm font-normal text-zinc-400">
                  {rankOffset + 1}–{rankOffset + tv.length} of {totalTv} titles
                </span>
              </h2>
              <MediaGrid items={tv} showPlex={showPlex} showJellyfin={showJellyfin} sort={sort} rankOffset={rankOffset} />
            </section>
          )}
        </div>
      )}

      <Suspense>
        <PaginationBar currentPage={page} totalPages={totalPages} />
      </Suspense>
    </div>
  );
}

function MediaGrid({
  items,
  showPlex,
  showJellyfin,
  sort,
  rankOffset,
}: {
  items: EnrichedMedia[];
  showPlex: boolean;
  showJellyfin: boolean;
  sort: PopularSort;
  rankOffset: number;
}) {
  return (
    <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5 xl:grid-cols-6 gap-5">
      {items.map((media, i) => (
        <div key={`${media.mediaType}-${media.id}`} className="relative">
          <div className="absolute top-2 left-2 z-10 bg-black/70 rounded-full w-6 h-6 flex items-center justify-center">
            <span className="text-xs font-bold text-white">{rankOffset + i + 1}</span>
          </div>
          <MediaCard
            media={media}
            showPlex={showPlex}
            showJellyfin={showJellyfin}
            size="md"
          />
          <div className="flex flex-wrap items-center gap-x-2 gap-y-0.5 mt-1.5 px-1">
            <span
              className={cn(
                "text-[11px] whitespace-nowrap",
                sort === "plays" || sort === "trending" ? "text-indigo-400 font-medium" : "text-zinc-500",
              )}
            >
              {media.plays} {media.plays === 1 ? "play" : "plays"}
              {sort === "trending" ? " (30d)" : ""}
            </span>
            {sort === "trending" && (
              <>
                <span className="text-zinc-700">&middot;</span>
                <span className="text-[11px] whitespace-nowrap text-zinc-500">
                  {media.allTimePlays} all-time
                </span>
              </>
            )}
            <span className="text-zinc-700">&middot;</span>
            <span
              className={cn(
                "text-[11px] whitespace-nowrap",
                sort === "viewers" ? "text-indigo-400 font-medium" : "text-zinc-500",
              )}
            >
              {media.viewers} {media.viewers === 1 ? "viewer" : "viewers"}
            </span>
            {media.mediaType === "tv" && media.episodes > 0 && (
              <>
                <span className="text-zinc-700">&middot;</span>
                <span className="text-[11px] text-zinc-500 whitespace-nowrap">
                  {media.episodes} {media.episodes === 1 ? "ep" : "eps"}
                </span>
              </>
            )}
            {media.totalHours > 0 && (
              <>
                <span className="text-zinc-700">&middot;</span>
                <span className="text-[11px] text-zinc-500 whitespace-nowrap">{media.totalHours}h</span>
              </>
            )}
          </div>
        </div>
      ))}
    </div>
  );
}
