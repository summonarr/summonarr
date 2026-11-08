export const dynamic = "force-dynamic";

import type { Metadata } from "next";
import { getMostPopularOnServer, isPlayHistoryEnabled, POPULAR_PER_PAGE, type PopularSort } from "@/lib/play-history";
import { MediaCard } from "@/components/media/media-card";
import { PaginationBar } from "@/components/media/pagination-bar";
import { RangeLabel } from "@/components/media/range-label";
import { attachAllAvailability } from "@/lib/attach-all";
import { resolvePopularTitles, type PopularItem, type PopularTitle } from "@/lib/popular-titles";
import { requireAppSession } from "@/lib/require-app-session";
import { getBadgeVisibility } from "@/lib/badge-visibility";
import { getShow4kVisibility } from "@/lib/four-k-visibility";
import { LiveRefresh } from "@/components/live-refresh";
import { isFeatureEnabled, requireFeature } from "@/lib/features";
import { Suspense, type CSSProperties } from "react";
import { PageHeader, EmptyState, SectionHeader } from "@/components/ui/design";
import { SegmentedLinks } from "@/components/ui/design/segmented-links";
import { TrendingUp, Film, AlertTriangle } from "@/components/icons";
import { getTranslator } from "@/lib/i18n/server";
import type { Translator } from "@/lib/i18n/translate";
import { canRequest } from "@/lib/permissions";
import { parsePageNumber } from "@/lib/pagination";
import { first, type PageSearchParams } from "@/lib/search-params";

type EnrichedMedia = PopularTitle & {
  // 1-based position in the SERVER-WIDE ranking (page offset included), taken
  // from the item's slot in the unfiltered page. Later steps can drop items (a
  // failed TMDB fetch, a title the viewer hid), so the rank is stored up front
  // instead of recounted from what survives — otherwise every later title
  // would show the wrong number.
  rank: number;
};

// One type's ranked page as cards, through the shared resolver /api/popular
// uses (it logs each dropped title). The rank is the item's slot in the
// unfiltered page, so a later drop never renumbers the survivors.
async function resolveRanked(
  items: readonly PopularItem[],
  type: "movie" | "tv",
  rankOffset: number,
): Promise<{ titles: EnrichedMedia[]; allFailed: boolean }> {
  const rankById = new Map(items.map((item, i) => [item.tmdbId, rankOffset + i + 1]));
  const resolved = await resolvePopularTitles(items, type, 8);
  const titles = resolved.map((m) => ({ ...m, rank: rankById.get(m.id) ?? 0 }));
  return { titles, allFailed: items.length > 0 && titles.length === 0 };
}

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
  // An unknown ?sort= is the default (trending, the first option).
  const sortParam = first(sp.sort);
  const activeSort = SORT_OPTIONS.find((s) => s.value === sortParam) ?? SORT_OPTIONS[0];
  const sort = activeSort.value;
  const requestedPage = parsePageNumber(sp.page);

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

  // At most 8 TMDB reads at a time (guardrail 31): items without a fresh
  // TmdbMediaCore row hit TMDB, and on a cold cache that is all of them.
  const [movieRanked, tvRanked] = await Promise.all([
    resolveRanked(moviesResult.items, "movie", rankOffset),
    resolveRanked(tvResult.items, "tv", rankOffset),
  ]);
  const enrich = (items: EnrichedMedia[]) => attachAllAvailability(items, session.user.id, { show4k });
  const [movies, tv] = await Promise.all([enrich(movieRanked.titles), enrich(tvRanked.titles)]);
  // Every ranked title failed to resolve (TMDB down with the core rows
  // expired): the plays exist, so "no plays" would be false.
  const resolveFailed = movieRanked.allFailed || tvRanked.allFailed;

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
        <PopularEmptyState
          page={page}
          sort={sort}
          resolveFailed={resolveFailed}
          backToFirstHref={buildHref({})}
          allTimeHref={buildHref({ sort: "plays" })}
          t={t}
        />
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

// A stat line's figure, accented when it is what the active sort ranks by.
function statStyle(emphasised: boolean): CSSProperties {
  return {
    whiteSpace: "nowrap",
    color: emphasised ? "var(--ds-accent-text)" : "var(--ds-fg-subtle)",
    fontWeight: emphasised ? 500 : 400,
  };
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
            {/* The number alone announced no context ahead of the card's name. */}
            <span aria-hidden="true">{media.rank}</span>
            <span className="sr-only">{t("browse.popular.rank", { rank: media.rank })}</span>
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
            <span style={statStyle(sort === "plays" || sort === "trending")}>
              {sort === "trending"
                ? t("browse.popular.stat.plays30d", { count: media.plays })
                : t("browse.popular.stat.plays", { count: media.plays })}
            </span>
            {sort === "trending" && (
              <span style={{ whiteSpace: "nowrap" }}>
                · {t("browse.popular.stat.allTime", { count: media.allTimePlays })}
              </span>
            )}
            <span style={statStyle(sort === "viewers")}>
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

// Page overflow first: a past-the-end ?page= on the trending sort is not
// "nothing was played in 30 days"; then a TMDB failure, which is not "no plays".
function PopularEmptyState({
  page,
  sort,
  resolveFailed,
  backToFirstHref,
  allTimeHref,
  t,
}: {
  page: number;
  sort: PopularSort;
  resolveFailed: boolean;
  backToFirstHref: string;
  allTimeHref: string;
  t: Translator;
}) {
  if (page > 1) {
    return (
      <EmptyState
        icon={Film}
        title={t("browse.empty.noMoreResults.title")}
        description={t("browse.empty.noMoreResults.description")}
        cta={{ href: backToFirstHref, label: t("browse.empty.backToPage1") }}
      />
    );
  }
  if (resolveFailed) {
    return (
      <EmptyState
        icon={AlertTriangle}
        title={t("browse.popular.loadFailed.title")}
        description={t("browse.popular.loadFailed.description")}
      />
    );
  }
  if (sort === "trending") {
    return (
      <EmptyState
        icon={TrendingUp}
        title={t("browse.popular.noRecentPlays.title")}
        description={t("browse.popular.noRecentPlays.description")}
        cta={{ href: allTimeHref, label: t("browse.popular.noRecentPlays.cta") }}
      />
    );
  }
  return (
    <EmptyState
      icon={Film}
      title={t("browse.popular.noHistory.title")}
      description={t("browse.popular.noHistory.description")}
    />
  );
}
