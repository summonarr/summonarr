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
import { isFeatureEnabled, requireFeature } from "@/lib/features";
import Link from "next/link";
import { Suspense } from "react";
import { PageHeader, EmptyState, SectionHeader } from "@/components/ui/design";
import { TrendingUp, Film } from "@/components/icons";
import { getTranslator } from "@/lib/i18n/server";
import type { Translator } from "@/lib/i18n/translate";

type EnrichedMedia = TmdbMedia & {
  // 1-based position in the SERVER-WIDE ranking (page offset included), taken
  // from the item's slot in the unfiltered page. Later steps can drop items (a
  // failed TMDB fetch, a title the viewer hid), so the rank is stored up front
  // instead of recounted from what survives — otherwise every later title
  // would show the wrong number.
  rank: number;
  plays: number;
  allTimePlays: number;
  viewers: number;
  episodes: number;
  totalHours: number;
};

// Labels are catalog keys, translated at render time (module scope has no
// request locale).
const SORT_OPTIONS: { value: PopularSort; labelKey: string; descriptionKey: string }[] = [
  { value: "trending", labelKey: "browse.popular.sort.trending", descriptionKey: "browse.popular.sort.trendingDescription" },
  { value: "viewers", labelKey: "browse.popular.sort.viewers", descriptionKey: "browse.popular.sort.viewersDescription" },
  { value: "plays", labelKey: "browse.popular.sort.plays", descriptionKey: "browse.popular.sort.playsDescription" },
];

const TYPE_OPTIONS = [
  { labelKey: "browse.type.all", value: undefined },
  { labelKey: "nav.movies", value: "movies" },
  { labelKey: "nav.tvShows", value: "tv" },
] as const;

export default async function PopularOnServerPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string>>;
}) {
  await requireFeature("feature.page.popular");
  const [sp, session, plexEnabled, jellyfinEnabled, t] = await Promise.all([
    searchParams,
    requireAppSession(),
    isFeatureEnabled("feature.integration.plex"),
    isFeatureEnabled("feature.integration.jellyfin"),
    getTranslator(),
  ]);
  if (!session) return null;
  // Integration flags passed explicitly — they default to TRUE when omitted.
  const { showPlex, showJellyfin } = getBadgeVisibility(session, {
    plex: plexEnabled,
    jellyfin: jellyfinEnabled,
  });
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
        <PageHeader title={t("nav.popularOnServer")} subtitle={t("browse.popular.subtitle")} />
        <EmptyState
          icon={TrendingUp}
          title={t("browse.popular.trackingOff.title")}
          description={t("browse.popular.trackingOff.description")}
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

    // One query for the whole page: every item shares mediaType and the
    // freshness check, so a single `tmdbId IN (...)` list is all that's needed.
    const coreRows = await prisma.tmdbMediaCore.findMany({
      where: {
        tmdbId: { in: items.map((i) => i.tmdbId) },
        mediaType: dbType,
        expiresAt: { gt: new Date() },
      },
    });
    const coreMap = new Map(coreRows.map((r) => [r.tmdbId, r]));

    // At most 8 at a time, not a bare Promise.allSettled (guardrail 31). Items
    // without a fresh TmdbMediaCore row hit TMDB, and on a cold cache that is
    // all of them: 40 movies + 40 shows at once would burst past TMDB's ~50
    // requests/second limit.
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
    t("browse.popular.rankRange", { from: items[0]!.rank, to: items[items.length - 1]!.rank, total });

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
      <PageHeader title={t("nav.popularOnServer")} subtitle={t(activeSort.descriptionKey)} />

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
          {SORT_OPTIONS.map(({ value, labelKey }) => {
            const isActive = sort === value;
            return (
              <Link
                key={value}
                href={buildHref({ sort: value === "trending" ? undefined : value })}
                aria-current={isActive ? "page" : undefined}
                className="ds-hover-tint inline-flex items-center whitespace-nowrap font-medium"
                style={{
                  // 32px hit area: these segments are the page's only controls
                  // at phone width, and 5px padding alone left them ~26px tall.
                  minHeight: 32,
                  padding: "5px 12px",
                  borderRadius: 6,
                  fontSize: 12,
                  background: isActive ? "var(--ds-bg-3)" : "transparent",
                  color: isActive ? "var(--ds-fg)" : "var(--ds-fg-muted)",
                }}
              >
                {t(labelKey)}
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
          {TYPE_OPTIONS.map(({ labelKey, value }) => {
            const isActive = mediaTypeFilter === value;
            return (
              <Link
                key={value ?? "all"}
                href={buildHref({ mediaType: value })}
                aria-current={isActive ? "page" : undefined}
                className="ds-hover-tint inline-flex items-center whitespace-nowrap font-medium"
                style={{
                  // 32px hit area: these segments are the page's only controls
                  // at phone width, and 5px padding alone left them ~26px tall.
                  minHeight: 32,
                  padding: "5px 12px",
                  borderRadius: 6,
                  fontSize: 12,
                  background: isActive ? "var(--ds-bg-3)" : "transparent",
                  color: isActive ? "var(--ds-fg)" : "var(--ds-fg-muted)",
                }}
              >
                {t(labelKey)}
              </Link>
            );
          })}
        </div>
      </div>

      {!hasAny ? (
        // Page overflow first: a past-the-end ?page= on the trending sort is
        // not "nothing was played in 30 days".
        page > 1 ? (
          <EmptyState
            icon={Film}
            title={t("browse.empty.noMoreResults.title")}
            description={t("browse.empty.noMoreResults.description")}
            cta={{ href: buildHref({}), label: t("browse.empty.backToPage1") }}
          />
        ) : sort === "trending" ? (
          <EmptyState
            icon={TrendingUp}
            title={t("browse.popular.noRecentPlays.title")}
            description={t("browse.popular.noRecentPlays.description")}
            cta={{ href: buildHref({ sort: "plays" }), label: t("browse.popular.noRecentPlays.cta") }}
          />
        ) : (
          <EmptyState
            icon={Film}
            title={t("browse.popular.noHistory.title")}
            description={t("browse.popular.noHistory.description")}
          />
        )
      ) : (
        <div style={{ display: "flex", flexDirection: "column", gap: 40 }}>
          {showMovies && movies.length > 0 && (
            <section>
              <SectionHeader
                title={t("nav.movies")}
                right={<RangeLabel>{rankRange(movies, totalMovies)}</RangeLabel>}
              />
              <MediaGrid
                items={movies}
                showPlex={showPlex}
                showJellyfin={showJellyfin}
                sort={sort}
                t={t}
              />
            </section>
          )}

          {showTV && tv.length > 0 && (
            <section>
              <SectionHeader
                title={t("nav.tvShows")}
                right={<RangeLabel>{rankRange(tv, totalTv)}</RangeLabel>}
              />
              <MediaGrid
                items={tv}
                showPlex={showPlex}
                showJellyfin={showJellyfin}
                sort={sort}
                t={t}
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

// "1–40 of 200 titles" beside a section title. Same label /top uses.
function RangeLabel({ children }: { children: React.ReactNode }) {
  return (
    <span
      className="ds-mono uppercase"
      style={{ fontSize: 10.5, color: "var(--ds-fg-subtle)", letterSpacing: "0.06em" }}
    >
      {children}
    </span>
  );
}

function MediaGrid({
  items,
  showPlex,
  showJellyfin,
  sort,
  t,
}: {
  items: EnrichedMedia[];
  showPlex: boolean;
  showJellyfin: boolean;
  sort: PopularSort;
  t: Translator;
}) {
  return (
    <div className="ds-media-grid">
      {items.map((media) => (
        // flex-col + the card's grow: the grid stretches this wrapper, not the
        // card, so without them each card stopped at its own content height and
        // a row's cards (and their stats lines) ended at different heights.
        <div key={`${media.mediaType}-${media.id}`} className="ds-ranked-card relative flex flex-col">
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
            className="grow"
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
                    ? "var(--ds-accent-text)"
                    : "var(--ds-fg-subtle)",
                fontWeight: sort === "plays" || sort === "trending" ? 500 : 400,
              }}
            >
              {sort === "trending"
                ? t("browse.popular.stat.plays30d", { count: media.plays })
                : t("browse.popular.stat.plays", { count: media.plays })}
            </span>
            {sort === "trending" && (
              <span style={{ whiteSpace: "nowrap" }}>
                · {t("browse.popular.stat.allTime", { count: media.allTimePlays })}
              </span>
            )}
            <span
              style={{
                whiteSpace: "nowrap",
                color:
                  sort === "viewers" ? "var(--ds-accent-text)" : "var(--ds-fg-subtle)",
                fontWeight: sort === "viewers" ? 500 : 400,
              }}
            >
              · {t("browse.popular.stat.viewers", { count: media.viewers })}
            </span>
            {media.mediaType === "tv" && media.episodes > 0 && (
              <span style={{ whiteSpace: "nowrap" }}>
                · {t("browse.popular.stat.episodes", { count: media.episodes })}
              </span>
            )}
            {media.totalHours > 0 && (
              <span style={{ whiteSpace: "nowrap" }}>· {t("browse.popular.stat.hours", { hours: media.totalHours })}</span>
            )}
          </div>
        </div>
      ))}
    </div>
  );
}
