export const dynamic = "force-dynamic";

import { getMostPopularOnServer, isPlayHistoryEnabled, POPULAR_PER_PAGE, type PopularSort } from "@/lib/play-history";
import { getMovieDetails, getTVDetails } from "@/lib/tmdb";
import type { TmdbMedia } from "@/lib/tmdb-types";
import { prisma } from "@/lib/prisma";
import { MediaCard } from "@/components/media/media-card";
import { PaginationBar } from "@/components/media/pagination-bar";
import { attachAllAvailability } from "@/lib/attach-all";
import { settleLimit } from "@/lib/concurrency";
import { requireAppSession } from "@/lib/require-app-session";
import { getBadgeVisibility } from "@/lib/badge-visibility";
import { getShow4kVisibility } from "@/lib/four-k-visibility";
import { LiveRefresh } from "@/components/live-refresh";
import { requireFeature } from "@/lib/features";
import Link from "next/link";
import { cn } from "@/lib/utils";
import { Suspense } from "react";
import { PageHeader, EmptyState } from "@/components/ui/design";
import { TrendingUp, Film } from "@/components/icons";

type EnrichedMedia = TmdbMedia & {
  // 1-based position in the SERVER-WIDE ranking (page offset included), fixed
  // at resolve time from the item's index in the unfiltered page. Both later
  // steps shrink the array — resolveMedia drops a rejected TMDB detail fetch and
  // attachAllAvailability removes the viewer's hidden titles — so a badge or
  // range computed from the survivor index re-labels every later title one
  // rank too high and claims "1–39 of 200" with #40 on no page at all.
  rank: number;
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
  const [sp, session] = await Promise.all([searchParams, requireAppSession()]);
  if (!session) return null;
  const { showPlex, showJellyfin } = getBadgeVisibility(session);
  const [show4k, playHistoryEnabled] = await Promise.all([
    getShow4kVisibility(session),
    isPlayHistoryEnabled(),
  ]);

  // This page is built entirely from recorded play history. When tracking is
  // off no new data accrues, so surface that explicitly rather than rendering a
  // stale or empty grid with no explanation.
  if (!playHistoryEnabled) {
    return (
      <div className="ds-page-enter">
        <PageHeader title="Popular on Server" subtitle="Most played on your servers" />
        <EmptyState
          icon={TrendingUp}
          title="Play history tracking is off"
          description="Enable play history in Admin → Features to populate this page."
        />
      </div>
    );
  }

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
  const rankOffset = (page - 1) * POPULAR_PER_PAGE;

  async function resolveMedia(
    items: typeof moviesResult.items,
    type: "movie" | "tv",
  ): Promise<EnrichedMedia[]> {
    if (items.length === 0) return [];
    const dbType = type === "movie" ? "MOVIE" : "TV";

    // One IN clause, not one OR per item. mediaType and the freshness bound are
    // the same for every item here, so the OR form only varied tmdbId — it grew
    // the query text with the page for no selectivity the planner could not get
    // from an id list against the [tmdbId, mediaType] key.
    const coreRows = await prisma.tmdbMediaCore.findMany({
      where: {
        tmdbId: { in: items.map((i) => i.tmdbId) },
        mediaType: dbType,
        expiresAt: { gt: new Date() },
      },
    });
    const coreMap = new Map(coreRows.map((r) => [r.tmdbId, r]));

    // Bounded, not a bare Promise.allSettled over the page (guardrail 31). Only
    // items missing a fresh TmdbMediaCore row reach the network, but on a cold
    // cache that is every one of them — POPULAR_PER_PAGE is 40, and movies and
    // TV resolve concurrently, so the unbounded form burst up to 80 TMDB detail
    // requests at once against an API that tolerates ~50/s. 8 matches the cap
    // the push fan-outs use; the TMDB list helpers sit at 5 because each of
    // those tasks is itself a multi-page fetch.
    const results = await settleLimit(
      items,
      8,
      async (item, i) => {
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
          // The slot index is the item's position in the unfiltered page, so a
          // later drop (rejected fetch, hidden title) never renumbers survivors.
          rank: rankOffset + i + 1,
          plays: item.plays,
          allTimePlays: item.allTimePlays,
          viewers: item.viewers,
          episodes: item.episodes,
          totalHours: item.totalHours,
        };
      },
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
    return (await attachAllAvailability(items, session?.user.id, { show4k })) as EnrichedMedia[];
  }

  [movies, tv] = await Promise.all([enrich(movies), enrich(tv)]);

  const showMovies = mediaTypeFilter !== "tv";
  const showTV = mediaTypeFilter !== "movies";
  const hasAny = movies.length > 0 || tv.length > 0;

  // "first–last of N" from the surviving ranks, not from the survivor count:
  // a filtered title in the middle of the page leaves the ends where they are.
  const rankRange = (items: EnrichedMedia[], total: number) =>
    `${items[0]!.rank}–${items[items.length - 1]!.rank} of ${total} titles`;

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
        sort === "trending" ? (
          <EmptyState
            icon={TrendingUp}
            title="No plays in the last 30 days"
            description="Try switching to Most Played for all-time data."
            cta={{ href: buildHref({ sort: "plays" }), label: "Switch to Most Played" }}
          />
        ) : page > 1 ? (
          <EmptyState
            icon={Film}
            title="No more results on this page"
            description="Try going back to the first page."
            cta={{ href: buildHref({}), label: "Back to page 1" }}
          />
        ) : (
          <EmptyState
            icon={Film}
            title="No play history yet"
            description="Data will appear once media is played on your servers."
          />
        )
      ) : (
        <div style={{ display: "flex", flexDirection: "column", gap: 40 }}>
          {showMovies && movies.length > 0 && (
            <section>
              <PopularSectionHeader
                title="Movies"
                range={rankRange(movies, totalMovies)}
              />
              <MediaGrid
                items={movies}
                showPlex={showPlex}
                showJellyfin={showJellyfin}
                sort={sort}
              />
            </section>
          )}

          {showTV && tv.length > 0 && (
            <section>
              <PopularSectionHeader
                title="TV Shows"
                range={rankRange(tv, totalTv)}
              />
              <MediaGrid
                items={tv}
                showPlex={showPlex}
                showJellyfin={showJellyfin}
                sort={sort}
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
}: {
  items: EnrichedMedia[];
  showPlex: boolean;
  showJellyfin: boolean;
  sort: PopularSort;
}) {
  return (
    <div className="ds-media-grid">
      {items.map((media) => (
        <div key={`${media.mediaType}-${media.id}`} className="ds-ranked-card relative">
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
            {media.rank}
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
