export const dynamic = "force-dynamic";

import type { Metadata } from "next";
import { MediaCard } from "@/components/media/media-card";
import { PaginationBar } from "@/components/media/pagination-bar";
import { RangeLabel } from "@/components/media/range-label";
import { Suspense } from "react";
import { TopFilterBar } from "@/components/media/top-filter-bar";
import { requireAppSession } from "@/lib/require-app-session";
import { LiveRefresh } from "@/components/live-refresh";
import { requireFeature } from "@/lib/features";
import { PageHeader, EmptyState, SectionHeader } from "@/components/ui/design";
import { AlertTriangle, Filter, Film, Tv, type IconComponent } from "@/components/icons";
import { getTranslator } from "@/lib/i18n/server";
import type { Translator } from "@/lib/i18n/translate";
import type { TmdbMedia } from "@/lib/tmdb-types";
import { canRequest } from "@/lib/permissions";
import { parsePageNumber } from "@/lib/pagination";
import { searchParamGetter, type PageSearchParams } from "@/lib/search-params";
import {
  TOP_RATED_PER_PAGE,
  parseTopRatedQuery,
  runTopRatedQuery,
  topRatedHasFilters,
  topRatedSearch,
  type TopRatedSort,
} from "@/lib/top-rated";

// Catalog keys, translated at render time (module scope has no request locale).
const SORT_LABEL_KEYS: Record<TopRatedSort, string> = {
  imdb: "browse.top.sort.imdb",
  letterboxd: "browse.top.sort.letterboxd",
  rt: "browse.top.sort.rt",
  trakt: "browse.top.sort.trakt",
  mdblist: "browse.top.sort.mdblist",
};

// Tab / bookmark / history title — the nav label, in the viewer's language.
export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslator();
  return { title: t("nav.topRated") };
}

export default async function TopRatedPage({
  searchParams,
}: {
  searchParams: Promise<PageSearchParams>;
}) {
  await requireFeature("feature.page.top");
  const [sp, session, t] = await Promise.all([searchParams, requireAppSession(), getTranslator()]);
  // Parsed and validated the same way as /api/top-rated (src/lib/top-rated.ts):
  // an unknown mediaType, sort or a malformed year is "not set".
  const query = parseTopRatedQuery(searchParamGetter(sp));
  const { mediaType, sortBy, minImdb, minVotes, fromYear, toYear, hideAvailable } = query;
  const page = parsePageNumber(sp.page);
  const canRequestMovie = canRequest(session.user.permissions, "MOVIE", false);
  const canRequestTv = canRequest(session.user.permissions, "TV", false);

  const hasFilters = topRatedHasFilters(query);
  // Retry target for the unfiltered empty state: this view, rebuilt from the
  // normalised values rather than echoing the raw params.
  const retryHref = topHref(topRatedSearch(query, page));
  // Past the end: page 1 of THIS view, filters kept.
  const firstPageHref = topHref(topRatedSearch(query, 1));

  // Dedupe, backfill, filters, the sort and the hidden-title rule are shared
  // with /api/top-rated — see src/lib/top-rated.ts. The default view is the
  // whole pool ordered by cached IMDb rating, so every page continues the one
  // before it.
  const {
    movies, tv,
    totalMovies: totalMovieCount, totalTv: totalTvCount, totalPages,
    sourceCount, failedSources, showPlex, showJellyfin,
  } = await runTopRatedQuery({ query, page, session });

  const showMovies = mediaType !== "tv";
  const showTV     = mediaType !== "movies";
  const offset = (page - 1) * TOP_RATED_PER_PAGE;

  // The FILTERED totals — the same numbers the section range labels report.
  // The unfiltered pool read "1,180 titles" over a Movies section saying
  // "1–36 of 92" the moment any filter was on. Unfiltered, the two agree.
  const subtitleBits = [
    t("browse.top.sortedBy", { label: t(SORT_LABEL_KEYS[sortBy]) }),
    sourceCount > 1 ? t("browse.top.sources", { count: sourceCount }) : null,
    t("browse.top.titles", { count: totalMovieCount + totalTvCount }),
  ].filter((bit): bit is string => bit !== null);

  // When nothing survived in EITHER visible section, one empty state for the
  // page — not the same card once under each section heading.
  const bothEmpty =
    (!showMovies || movies.length === 0) && (!showTV || tv.length === 0);

  return (
    <div className="ds-page-enter">
      <LiveRefresh on={["request:new", "request:updated", "request:deleted"]} />
      <PageHeader title={t("nav.topRated")} subtitle={subtitleBits.join(" · ")} />

      <Suspense>
        <TopFilterBar
          activeMediaType={mediaType}
          activeSortBy={sortBy !== "imdb" ? sortBy : undefined}
          activeMinImdb={minImdb}
          activeMinVotes={minVotes}
          activeFromYear={fromYear}
          activeToYear={toYear}
          activeHideAvailable={hideAvailable}
          maxYear={new Date().getUTCFullYear() + 1}
        />
      </Suspense>

      {bothEmpty ? (
        sectionEmptyState(t, showMovies ? Film : Tv, page, hasFilters, retryHref, firstPageHref, failedSources.length > 0)
      ) : (
        // A section with nothing on this page is OMITTED, the way /popular
        // does it — not a heading over a "No titles match" card while the
        // other half of the page carries on. The page-level empty state above
        // covers "nothing anywhere". The gap replaces the per-section bottom
        // margin, so whichever section renders last sits 40px above nothing
        // extra and the pager's own mt-8 still applies.
        <div style={{ display: "flex", flexDirection: "column", gap: 40 }}>
          {/* A source that failed outright: the list is partial, not wrong. */}
          {failedSources.length > 0 && (
            <p role="status" className="flex items-center gap-2" style={{ fontSize: 13, color: "var(--ds-fg-muted)" }}>
              <AlertTriangle className="w-4 h-4 shrink-0" aria-hidden />
              {t("browse.top.partialSources", { sources: failedSources.map((s) => SOURCE_LABELS[s] ?? s).join(", ") })}
            </p>
          )}

          {showMovies && movies.length > 0 && (
            <TopSection
              title={t("nav.movies")}
              items={movies}
              offset={offset}
              total={totalMovieCount}
              showPlex={showPlex}
              showJellyfin={showJellyfin}
              canRequest={canRequestMovie}
              t={t}
            />
          )}

          {showTV && tv.length > 0 && (
            <TopSection
              title={t("nav.tvShows")}
              items={tv}
              offset={offset}
              total={totalTvCount}
              showPlex={showPlex}
              showJellyfin={showJellyfin}
              canRequest={canRequestTv}
              t={t}
            />
          )}
        </div>
      )}

      <Suspense>
        <PaginationBar currentPage={page} totalPages={totalPages} />
      </Suspense>
    </div>
  );
}

// Provider names as their brands spell them (never translated).
const SOURCE_LABELS: Record<string, string> = { tmdb: "TMDB", trakt: "Trakt", mdblist: "MDBList" };

const topHref = (search: string) => (search ? `/top?${search}` : "/top");

// One media type's section: heading, range label and its cards.
function TopSection({
  title,
  items,
  offset,
  total,
  showPlex,
  showJellyfin,
  canRequest,
  t,
}: {
  title: string;
  items: TmdbMedia[];
  offset: number;
  total: number;
  showPlex: boolean;
  showJellyfin: boolean;
  canRequest: boolean;
  t: Translator;
}) {
  return (
    <section>
      <SectionHeader
        title={title}
        right={<RangeLabel t={t} from={offset + 1} to={Math.min(offset + items.length, total)} total={total} />}
      />
      <div className="ds-media-grid">
        {items.map((media) => (
          <MediaCard
            key={`${media.mediaType}-${media.id}`}
            media={media}
            showPlex={showPlex}
            showJellyfin={showJellyfin}
            size="md"
            canRequest={canRequest}
          />
        ))}
      </div>
    </section>
  );
}

// The page-level empty state (both visible sections empty). `icon` only
// matters past page 1 — the filters case always shows the filter glyph.
// A source whose load failed outright makes an empty page 1 a load failure,
// filters or not. Otherwise, with no filter set, an empty page 1 still means the
// sources came back empty (most list helpers swallow an outage into []), so it
// must not blame filters the user never applied.
function sectionEmptyState(
  t: Translator,
  icon: IconComponent,
  page: number,
  hasFilters: boolean,
  retryHref: string,
  firstPageHref: string,
  sourcesFailed: boolean,
) {
  if (page > 1) {
    return (
      <EmptyState
        icon={icon}
        title={t("browse.empty.noMoreResults.title")}
        description={t("browse.empty.noMoreResults.description")}
        cta={{ href: firstPageHref, label: t("browse.empty.backToPage1") }}
      />
    );
  }
  return hasFilters && !sourcesFailed ? (
    <EmptyState
      icon={Filter}
      title={t("browse.empty.noFilterMatch.title")}
      description={t("browse.empty.noFilterMatch.description")}
      cta={{ href: "/top", label: t("browse.clearFilters") }}
    />
  ) : (
    <EmptyState
      icon={AlertTriangle}
      title={t("browse.top.loadFailed.title")}
      description={t("browse.top.loadFailed.description")}
      cta={{ href: retryHref, label: t("browse.retry") }}
    />
  );
}
