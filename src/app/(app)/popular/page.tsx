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
import { requireFeature } from "@/lib/features";
import Link from "next/link";
import { cn } from "@/lib/utils";
import { Suspense } from "react";
import { PageHeader } from "@/components/ui/design";

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
  await requireFeature("feature.page.popular");
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
    <div className="ds-page-enter">
      <LiveRefresh on={["request:new", "request:updated", "request:deleted"]} />
      <PageHeader title="Popular on Server" subtitle={activeSort.description} />

      <div className="flex flex-col sm:flex-row gap-3 mb-6 flex-wrap">
        <div
          className="ds-no-scrollbar flex overflow-x-auto max-w-full"
          style={{
            padding: 2,
            background: "var(--ds-bg-1)",
            border: "1px solid var(--ds-border)",
            borderRadius: 8,
            gap: 0,
          }}
        >
          {SORT_OPTIONS.map(({ value, label }) => {
            const isActive = sort === value;
            return (
              <Link
                key={value}
                href={buildHref({ sort: value === "trending" ? undefined : value })}
                className="inline-flex items-center whitespace-nowrap font-medium transition-colors"
                style={{
                  padding: "5px 12px",
                  borderRadius: 6,
                  fontSize: 12,
                  background: isActive ? "var(--ds-bg-3)" : "transparent",
                  color: isActive ? "var(--ds-fg)" : "var(--ds-fg-muted)",
                }}
              >
                {label}
              </Link>
            );
          })}
        </div>

        <div
          className="hidden sm:block self-stretch"
          style={{ width: 1, background: "var(--ds-border)", marginInline: 4 }}
        />

        <div
          className="ds-no-scrollbar flex overflow-x-auto max-w-full"
          style={{
            padding: 2,
            background: "var(--ds-bg-1)",
            border: "1px solid var(--ds-border)",
            borderRadius: 8,
          }}
        >
          {TYPE_OPTIONS.map(({ label, value }) => {
            const isActive = mediaTypeFilter === value;
            return (
              <Link
                key={label}
                href={buildHref({ mediaType: value })}
                className={cn(
                  "inline-flex items-center whitespace-nowrap font-medium transition-colors",
                )}
                style={{
                  padding: "5px 12px",
                  borderRadius: 6,
                  fontSize: 12,
                  background: isActive ? "var(--ds-bg-3)" : "transparent",
                  color: isActive ? "var(--ds-fg)" : "var(--ds-fg-muted)",
                }}
              >
                {label}
              </Link>
            );
          })}
        </div>
      </div>

      {!hasAny ? (
        <div
          className="ds-mono"
          style={{ fontSize: 12, color: "var(--ds-fg-subtle)" }}
        >
          {sort === "trending"
            ? "No plays in the last 30 days — try switching to Most Played for all-time data."
            : page > 1
              ? "No more results on this page."
              : "No play history yet — data will appear once media is played on your servers."}
        </div>
      ) : (
        <div style={{ display: "flex", flexDirection: "column", gap: 40 }}>
          {showMovies && movies.length > 0 && (
            <section>
              <PopularSectionHeader
                title="Movies"
                range={`${rankOffset + 1}–${rankOffset + movies.length} of ${totalMovies} titles`}
              />
              <MediaGrid
                items={movies}
                showPlex={showPlex}
                showJellyfin={showJellyfin}
                sort={sort}
                rankOffset={rankOffset}
              />
            </section>
          )}

          {showTV && tv.length > 0 && (
            <section>
              <PopularSectionHeader
                title="TV Shows"
                range={`${rankOffset + 1}–${rankOffset + tv.length} of ${totalTv} titles`}
              />
              <MediaGrid
                items={tv}
                showPlex={showPlex}
                showJellyfin={showJellyfin}
                sort={sort}
                rankOffset={rankOffset}
              />
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

function PopularSectionHeader({
  title,
  range,
}: {
  title: string;
  range: string;
}) {
  return (
    <div className="flex items-end mb-3">
      <h2
        className="section-title m-0 font-semibold"
        style={{ fontSize: 15, letterSpacing: "-0.01em", color: "var(--ds-fg)" }}
      >
        {title}
      </h2>
      <span
        className="ds-mono ml-auto uppercase"
        style={{
          fontSize: 10.5,
          color: "var(--ds-fg-subtle)",
          letterSpacing: "0.06em",
        }}
      >
        {range}
      </span>
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
    <div className="ds-media-grid">
      {items.map((media, i) => (
        <div key={`${media.mediaType}-${media.id}`} className="relative">
          <div
            className="ds-mono absolute z-10 flex items-center justify-center font-bold"
            style={{
              top: 6,
              left: 6,
              width: 22,
              height: 22,
              borderRadius: 999,
              background: "color-mix(in oklab, var(--ds-bg-inset) 85%, transparent)",
              border: "1px solid var(--ds-border)",
              color: "var(--ds-fg)",
              fontSize: 10.5,
            }}
          >
            {rankOffset + i + 1}
          </div>
          <MediaCard
            media={media}
            showPlex={showPlex}
            showJellyfin={showJellyfin}
            size="md"
          />
          <div
            className="ds-mono flex flex-wrap items-center"
            style={{
              marginTop: 6,
              paddingInline: 2,
              gap: "0 8px",
              fontSize: 10.5,
              color: "var(--ds-fg-subtle)",
            }}
          >
            <span
              style={{
                whiteSpace: "nowrap",
                color:
                  sort === "plays" || sort === "trending"
                    ? "var(--ds-accent)"
                    : "var(--ds-fg-subtle)",
                fontWeight: sort === "plays" || sort === "trending" ? 500 : 400,
              }}
            >
              {media.plays} {media.plays === 1 ? "play" : "plays"}
              {sort === "trending" ? " (30d)" : ""}
            </span>
            {sort === "trending" && (
              <span style={{ whiteSpace: "nowrap" }}>
                · {media.allTimePlays} all-time
              </span>
            )}
            <span
              style={{
                whiteSpace: "nowrap",
                color:
                  sort === "viewers" ? "var(--ds-accent)" : "var(--ds-fg-subtle)",
                fontWeight: sort === "viewers" ? 500 : 400,
              }}
            >
              · {media.viewers} {media.viewers === 1 ? "viewer" : "viewers"}
            </span>
            {media.mediaType === "tv" && media.episodes > 0 && (
              <span style={{ whiteSpace: "nowrap" }}>
                · {media.episodes} {media.episodes === 1 ? "ep" : "eps"}
              </span>
            )}
            {media.totalHours > 0 && (
              <span style={{ whiteSpace: "nowrap" }}>· {media.totalHours}h</span>
            )}
          </div>
        </div>
      ))}
    </div>
  );
}
