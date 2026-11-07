export const dynamic = "force-dynamic";

import type { Metadata } from "next";
import { getMostPopularOnServer, isPlayHistoryEnabled, POPULAR_PER_PAGE, type PopularSort } from "@/lib/play-history";
import { getMovieDetails, getTVDetails } from "@/lib/tmdb";
import type { TmdbMedia } from "@/lib/tmdb-types";
import { prisma } from "@/lib/prisma";
import { MediaCard } from "@/components/media/media-card";
import { PaginationBar } from "@/components/media/pagination-bar";
import { RangeLabel } from "@/components/media/range-label";
import { attachAllAvailability } from "@/lib/attach-all";
import { settleLimit } from "@/lib/concurrency";
import { requireAppSession } from "@/lib/require-app-session";
import { getBadgeVisibility } from "@/lib/badge-visibility";
import { getShow4kVisibility } from "@/lib/four-k-visibility";
import { LiveRefresh } from "@/components/live-refresh";
import { isFeatureEnabled, requireFeature } from "@/lib/features";
import { Suspense } from "react";
import { PageHeader, EmptyState, SectionHeader } from "@/components/ui/design";
import { SegmentedLinks } from "@/components/ui/design/segmented-links";
import { TrendingUp, Film } from "@/components/icons";
import { getTranslator } from "@/lib/i18n/server";
import type { Translator } from "@/lib/i18n/translate";
import { canRequest } from "@/lib/permissions";
import { parsePageNumber } from "@/lib/pagination";
import { first, type PageSearchParams } from "@/lib/search-params";

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

type MediaTypeFilter = (typeof TYPE_OPTIONS)[number]["value"];

// Tab / bookmark / history title — the nav label, in the viewer's language.
export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslator();
  return { title: t("nav.popularOnServer") };
}

export default async function PopularOnServerPage({
  searchParams,
}: {
  searchParams: Promise<PageSearchParams>;
}) {
  await requireFeature("feature.page.popular");
  const [sp, session, plexEnabled, jellyfinEnabled, t] = await Promise.all([
    searchParams,
    requireAppSession(),
    isFeatureEnabled("feature.integration.plex"),
    isFeatureEnabled("feature.integration.jellyfin"),
    getTranslator(),
  ]);
  // Integration flags passed explicitly — they default to TRUE when omitted.
  const { showPlex, showJellyfin } = getBadgeVisibility(session, {
    plex: plexEnabled,
    jellyfin: jellyfinEnabled,
  });
  const canRequestMovie = canRequest(session.user.permissions, "MOVIE", false);
  const canRequestTv = canRequest(session.user.permissions, "TV", false);
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

  // Only the two real types filter; anything else (a hand-edited ?mediaType=)
  // is "all" — otherwise it showed both sections with no tab marked and was
  // copied into every sort, empty-state and pager link.
  const rawMediaType = first(sp.mediaType);
  const mediaTypeFilter: MediaTypeFilter =
    rawMediaType === "movies" || rawMediaType === "tv" ? rawMediaType : undefined;
  const validSorts = new Set<PopularSort>(["plays", "viewers", "trending"]);
  const sortParam = first(sp.sort);
  const sort: PopularSort = validSorts.has(sortParam as PopularSort)
    ? (sortParam as PopularSort)
    : "trending";
  const requestedPage = parsePageNumber(sp.page);

  const activeSort = SORT_OPTIONS.find((s) => s.value === sort)!;

  const [moviesResult, tvResult] = await Promise.all([
    mediaTypeFilter === "tv"
      ? Promise.resolve({ items: [], totalItems: 0, totalPages: 1, page: 1 })
      : getMostPopularOnServer({ mediaType: "MOVIE", sort, page: requestedPage }),
    mediaTypeFilter === "movies"
      ? Promise.resolve({ items: [], totalItems: 0, totalPages: 1, page: 1 })
      : getMostPopularOnServer({ mediaType: "TV", sort, page: requestedPage }),
  ]);

  // getMostPopularOnServer clamps a deep ?page= (MAX_POPULAR_PAGE); rank and pager
  // must follow the page it actually served, not the requested one.
  const page = Math.max(moviesResult.page, tvResult.page);
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
    // A title whose TMDB resolve rejected is dropped (its rank was taken up
    // front, so the rest keep theirs) — logged, as /api/popular does, so a
    // most-played title that vanished is diagnosable.
    for (const r of results) {
      if (r.status === "rejected") {
        console.error(`[popular] ${type} detail resolve failed:`, r.reason instanceof Error ? r.reason.message : r.reason);
      }
    }
    return results
      .filter((r): r is PromiseFulfilledResult<EnrichedMedia> => r.status === "fulfilled")
      .map((r) => r.value);
  }

  let [movies, tv] = await Promise.all([
    resolveMedia(moviesResult.items, "movie"),
    resolveMedia(tvResult.items, "tv"),
  ]);

  const enrich = (items: EnrichedMedia[]) => attachAllAvailability(items, session.user.id, { show4k });

  [movies, tv] = await Promise.all([enrich(movies), enrich(tv)]);

  const showMovies = mediaTypeFilter !== "tv";
  const showTV = mediaTypeFilter !== "movies";
  const hasAny = movies.length > 0 || tv.length > 0;

  // "first–last of N" from the surviving ranks, not from the survivor count:
  // a filtered title in the middle of the page leaves the ends where they are.
  // The shared RangeLabel (the label /top renders) carries the string.
  const rankRange = (items: EnrichedMedia[], total: number) => (
    <RangeLabel t={t} from={items[0]!.rank} to={items[items.length - 1]!.rank} total={total} />
  );

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
        <SegmentedLinks
          links={SORT_OPTIONS.map(({ value, labelKey }) => ({
            key: value,
            label: t(labelKey),
            href: buildHref({ sort: value === "trending" ? undefined : value }),
          }))}
          active={sort}
        />

        <div
          className="hidden sm:block self-stretch"
          style={{ width: 1, background: "var(--ds-border)", marginInline: 4 }}
        />

        <SegmentedLinks
          links={TYPE_OPTIONS.map(({ labelKey, value }) => ({
            key: value ?? "all",
            label: t(labelKey),
            href: buildHref({ mediaType: value }),
          }))}
          active={mediaTypeFilter ?? "all"}
        />
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
                right={rankRange(movies, totalMovies)}
              />
              <MediaGrid
                items={movies}
                showPlex={showPlex}
                showJellyfin={showJellyfin}
                sort={sort}
                t={t}
                canRequest={canRequestMovie}
              />
            </section>
          )}

          {showTV && tv.length > 0 && (
            <section>
              <SectionHeader
                title={t("nav.tvShows")}
                right={rankRange(tv, totalTv)}
              />
              <MediaGrid
                items={tv}
                showPlex={showPlex}
                showJellyfin={showJellyfin}
                sort={sort}
                t={t}
                canRequest={canRequestTv}
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

function MediaGrid({
  items,
  showPlex,
  showJellyfin,
  sort,
  t,
  canRequest,
}: {
  items: EnrichedMedia[];
  showPlex: boolean;
  showJellyfin: boolean;
  sort: PopularSort;
  t: Translator;
  canRequest?: boolean;
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
            canRequest={canRequest}
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
