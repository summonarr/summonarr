export const dynamic = "force-dynamic";

import type { Metadata } from "next";
import { getTopRatedMovies, getTopRatedTV, type TmdbMedia } from "@/lib/tmdb";
import { getTraktPopularMovies, getTraktPopularTV } from "@/lib/trakt";
import { getMdblistTopRated } from "@/lib/mdblist";
import { MediaCard } from "@/components/media/media-card";
import { PaginationBar } from "@/components/media/pagination-bar";
import { RangeLabel } from "@/components/media/range-label";
import { attachAllAvailability } from "@/lib/attach-all";
import { Suspense } from "react";
import { TopFilterBar } from "@/components/media/top-filter-bar";
import { requireAppSession } from "@/lib/require-app-session";
import { getBadgeVisibility } from "@/lib/badge-visibility";
import { getShow4kVisibility } from "@/lib/four-k-visibility";
import { LiveRefresh } from "@/components/live-refresh";
import { prisma } from "@/lib/prisma";
import { isFeatureEnabled, requireFeature } from "@/lib/features";
import { PageHeader, EmptyState, SectionHeader } from "@/components/ui/design";
import { AlertTriangle, Filter, Film, Tv, type IconComponent } from "@/components/icons";
import { getTranslator } from "@/lib/i18n/server";
import type { Translator } from "@/lib/i18n/translate";

const PER_PAGE = 36;

type SortBy = "imdb" | "letterboxd" | "rt" | "trakt" | "mdblist";

// Catalog keys, translated at render time (module scope has no request locale).
const SORT_LABEL_KEYS: Record<SortBy, string> = {
  imdb: "browse.top.sort.imdb",
  letterboxd: "browse.top.sort.letterboxd",
  rt: "browse.top.sort.rt",
  trakt: "browse.top.sort.trakt",
  mdblist: "browse.top.sort.mdblist",
};

function sortByRating(items: TmdbMedia[], sortBy: SortBy): TmdbMedia[] {
  return [...items].sort((a, b) => {
    let av: number, bv: number;
    switch (sortBy) {
      case "letterboxd":
        av = parseFloat(a.letterboxdRating ?? "");
        bv = parseFloat(b.letterboxdRating ?? "");
        break;
      case "rt":
        av = parseInt(a.rottenTomatoes?.replace("%", "") ?? "", 10);
        bv = parseInt(b.rottenTomatoes?.replace("%", "") ?? "", 10);
        break;
      case "trakt":
        av = parseFloat(a.traktRating ?? "");
        bv = parseFloat(b.traktRating ?? "");
        break;
      case "mdblist":
        av = parseFloat(a.mdblistScore ?? "");
        bv = parseFloat(b.mdblistScore ?? "");
        break;
      default:
        av = parseFloat(a.imdbRating ?? "");
        bv = parseFloat(b.imdbRating ?? "");
    }
    if (!isNaN(av) && !isNaN(bv)) return bv - av;
    if (!isNaN(av)) return -1;
    if (!isNaN(bv)) return 1;
    return b.voteAverage - a.voteAverage;
  });
}

function dedup(sources: TmdbMedia[][]): TmdbMedia[] {
  const seen = new Set<string>();
  const result: TmdbMedia[] = [];
  for (const items of sources) {
    for (const item of items) {
      const key = `${item.mediaType}:${item.id}`;
      if (!seen.has(key)) {
        seen.add(key);
        result.push(item);
      }
    }
  }
  return result;
}

async function backfillMetadata(items: TmdbMedia[]): Promise<TmdbMedia[]> {
  const missing = items.filter((i) => !i.posterPath);
  if (missing.length === 0) return items;

  const coreRows = await prisma.tmdbMediaCore.findMany({
    where: {
      OR: missing.map((i) => ({
        tmdbId: i.id,
        mediaType: i.mediaType === "movie" ? "MOVIE" : "TV",
      })),
    },
  });
  const coreMap = new Map(coreRows.map((r) => [`${r.mediaType}:${r.tmdbId}`, r]));

  return items.map((item) => {
    if (item.posterPath) return item;
    const core = coreMap.get(`${item.mediaType === "movie" ? "MOVIE" : "TV"}:${item.id}`);
    if (!core) return item;
    return {
      ...item,
      title: core.title || item.title,
      posterPath: core.posterPath ?? item.posterPath,
      releaseYear: core.releaseYear ?? item.releaseYear,
      voteAverage: core.voteAverage ?? item.voteAverage,
    };
  });
}

function applyFilters(
  items: TmdbMedia[],
  opts: { hideAvailable: boolean; showPlex: boolean; showJellyfin: boolean; minImdb?: string; minVotes?: string; fromYear?: string; toYear?: string },
): TmdbMedia[] {
  let result = items;
  if (opts.hideAvailable) {
    // Gate on the user's own server visibility, matching /api/top-rated. Without
    // it a Plex-pinned user had Jellyfin-only titles hidden from this
    // server-rendered page while the route that serves every subsequent page
    // kept them — so the same filter produced two different lists depending on
    // which half of the pair answered.
    result = result.filter((m) => !((opts.showPlex && m.plexAvailable) || (opts.showJellyfin && m.jellyfinAvailable)));
  }
  if (opts.minImdb) {
    const threshold = parseFloat(opts.minImdb);
    if (!isNaN(threshold)) {
      result = result.filter((m) => {
        const r = parseFloat(m.imdbRating ?? "");
        return !isNaN(r) && r >= threshold;
      });
    }
  }
  if (opts.minVotes) {
    const threshold = parseInt(opts.minVotes, 10);
    if (!isNaN(threshold)) {
      // Unknown voteCount passes — non-TMDB sources (Trakt/MDBList) carry no vote counts; only a known count is filterable (cf. content-rating.ts exceedsCap).
      result = result.filter((m) => typeof m.voteCount !== "number" || m.voteCount >= threshold);
    }
  }
  if (opts.fromYear) {
    result = result.filter((m) => (m.releaseYear ?? "") >= opts.fromYear!);
  }
  if (opts.toYear) {
    result = result.filter((m) => (m.releaseYear ?? "") <= opts.toYear!);
  }
  return result;
}

// Tab / bookmark / history title — the nav label, in the viewer's language.
export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslator();
  return { title: t("nav.topRated") };
}

export default async function TopRatedPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string>>;
}) {
  await requireFeature("feature.page.top");
  const [sp, session, plexEnabled, jellyfinEnabled, t] = await Promise.all([
    searchParams,
    requireAppSession(),
    isFeatureEnabled("feature.integration.plex"),
    isFeatureEnabled("feature.integration.jellyfin"),
    getTranslator(),
  ]);
  const hideAvailable = sp.hideAvailable === "1";
  const mediaType     = sp.mediaType || undefined;
  const minImdb       = sp.minImdb   || undefined;
  const minVotes      = sp.minVotes  || undefined;
  const fromYear      = sp.fromYear  || undefined;
  const toYear        = sp.toYear    || undefined;
  const validSorts = new Set<SortBy>(["imdb", "letterboxd", "rt", "trakt", "mdblist"]);
  const sortBy: SortBy = validSorts.has(sp.sortBy as SortBy) ? (sp.sortBy as SortBy) : "imdb";
  const page = Math.max(1, parseInt(sp.page ?? "1", 10) || 1);
  // Integration flags passed explicitly — they default to TRUE when omitted.
  const { showPlex, showJellyfin } = getBadgeVisibility(session, {
    plex: plexEnabled,
    jellyfin: jellyfinEnabled,
  });

  const filterOpts = { hideAvailable, showPlex, showJellyfin, minImdb, minVotes, fromYear, toYear };
  const hasFilters = !!(hideAvailable || minImdb || minVotes || fromYear || toYear);
  // Retry target for the unfiltered empty state: the page the user is on, as-is.
  const currentQuery = new URLSearchParams(sp).toString();
  const retryHref = currentQuery ? `/top?${currentQuery}` : "/top";

  const [
    rawTmdbMovies, rawTmdbTV,
    rawTraktMovies, rawTraktTV,
    rawMdbMovies, rawMdbTV,
    show4k,
  ] = await Promise.all([
    mediaType === "tv"     ? [] : getTopRatedMovies().catch(() => [] as TmdbMedia[]),
    mediaType === "movies" ? [] : getTopRatedTV().catch(() => [] as TmdbMedia[]),
    mediaType === "tv"     ? [] : getTraktPopularMovies().catch(() => [] as TmdbMedia[]),
    mediaType === "movies" ? [] : getTraktPopularTV().catch(() => [] as TmdbMedia[]),
    mediaType === "tv"     ? [] : getMdblistTopRated("movie").catch(() => [] as TmdbMedia[]),
    mediaType === "movies" ? [] : getMdblistTopRated("tv").catch(() => [] as TmdbMedia[]),
    getShow4kVisibility(session),
  ]);

  const allMovies = dedup([rawTmdbMovies, rawTraktMovies, rawMdbMovies]);
  const allTV     = dedup([rawTmdbTV, rawTraktTV, rawMdbTV]);

  const showMovies = mediaType !== "tv";
  const showTV     = mediaType !== "movies";

  const offset = (page - 1) * PER_PAGE;
  // See the native /api/top-rated route for the rationale: applyFilters + the
  // rating sort read post-enrichment fields, so enrich+filter+sort the whole pool
  // only when a filter or non-default sort is active. Otherwise the default view is
  // already rating-ordered by source and we enrich just the visible slice.
  const filtersActive = hasFilters || sortBy !== "imdb";

  let movies: TmdbMedia[];
  let tv: TmdbMedia[];
  let totalMovieCount: number;
  let totalTvCount: number;

  if (filtersActive) {
    // Ratings enrichment is NOT blocking here, matching the native /api/top-rated route:
    // the pool is the whole catalogue (hundreds of titles), so awaiting its ratings misses
    // would burn the OMDB daily quota on one cold load. Trade-off: a title whose rating is
    // still uncached drops out of the minImdb filter on the first load and reappears on the
    // next, once the post-response warm has filled the cache.
    const [enrichedMovies, enrichedTV] = await Promise.all([
      showMovies && allMovies.length > 0
        ? backfillMetadata(allMovies).then((m) => attachAllAvailability(m, session?.user.id, { show4k }))
        : Promise.resolve([] as TmdbMedia[]),
      showTV && allTV.length > 0
        ? backfillMetadata(allTV).then((t) => attachAllAvailability(t, session?.user.id, { show4k }))
        : Promise.resolve([] as TmdbMedia[]),
    ]);
    const filteredMovies = sortByRating(applyFilters(enrichedMovies, filterOpts), sortBy);
    const filteredTV     = sortByRating(applyFilters(enrichedTV, filterOpts), sortBy);
    totalMovieCount = filteredMovies.length;
    totalTvCount    = filteredTV.length;
    movies = filteredMovies.slice(offset, offset + PER_PAGE);
    tv     = filteredTV.slice(offset, offset + PER_PAGE);
  } else {
    let moviePage = allMovies.slice(offset, offset + PER_PAGE);
    let tvPage    = allTV.slice(offset, offset + PER_PAGE);
    [moviePage, tvPage] = await Promise.all([
      backfillMetadata(moviePage),
      backfillMetadata(tvPage),
    ]);
    [movies, tv] = await Promise.all([
      showMovies && moviePage.length > 0
        ? attachAllAvailability(moviePage, session?.user.id, { show4k })
        : Promise.resolve([] as TmdbMedia[]),
      showTV && tvPage.length > 0
        ? attachAllAvailability(tvPage, session?.user.id, { show4k })
        : Promise.resolve([] as TmdbMedia[]),
    ]);
    movies = sortByRating(movies, sortBy);
    tv     = sortByRating(tv, sortBy);
    totalMovieCount = allMovies.length;
    totalTvCount    = allTV.length;
  }

  const totalMoviePages = Math.max(1, Math.ceil(totalMovieCount / PER_PAGE));
  const totalTvPages    = Math.max(1, Math.ceil(totalTvCount / PER_PAGE));
  const totalPages      = Math.max(totalMoviePages, totalTvPages);

  const sourceCount = [rawTmdbMovies.length || rawTmdbTV.length, rawTraktMovies.length || rawTraktTV.length, rawMdbMovies.length || rawMdbTV.length].filter(Boolean).length;

  // The FILTERED totals — the same numbers the section range labels report.
  // The unfiltered pool read "1,180 titles" over a Movies section saying
  // "1–36 of 92" the moment any filter was on. Unfiltered, the two agree.
  const subtitleBits = [
    t("browse.top.sortedBy", { label: t(SORT_LABEL_KEYS[sortBy]) }),
    sourceCount > 1 ? t("browse.top.sources", { count: sourceCount }) : null,
    t("browse.top.titles", { count: totalMovieCount + totalTvCount }),
  ].filter(Boolean) as string[];

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
        sectionEmptyState(t, showMovies ? Film : Tv, page, hasFilters, retryHref)
      ) : (
        // A section with nothing on this page is OMITTED, the way /popular
        // does it — not a heading over a "No titles match" card while the
        // other half of the page carries on. The page-level empty state above
        // covers "nothing anywhere". The gap replaces the per-section bottom
        // margin, so whichever section renders last sits 40px above nothing
        // extra and the pager's own mt-8 still applies.
        <div style={{ display: "flex", flexDirection: "column", gap: 40 }}>
          {showMovies && movies.length > 0 && (
            <section>
              <SectionHeader
                title={t("nav.movies")}
                right={
                  <RangeLabel
                    t={t}
                    from={offset + 1}
                    to={Math.min(offset + movies.length, totalMovieCount)}
                    total={totalMovieCount}
                  />
                }
              />
              <div className="ds-media-grid">
                {movies.map((media) => (
                  <MediaCard
                    key={`movie-${media.id}`}
                    media={media}
                    showPlex={showPlex}
                    showJellyfin={showJellyfin}
                    size="md"
                  />
                ))}
              </div>
            </section>
          )}

          {showTV && tv.length > 0 && (
            <section>
              <SectionHeader
                title={t("nav.tvShows")}
                right={
                  <RangeLabel
                    t={t}
                    from={offset + 1}
                    to={Math.min(offset + tv.length, totalTvCount)}
                    total={totalTvCount}
                  />
                }
              />
              <div className="ds-media-grid">
                {tv.map((media) => (
                  <MediaCard
                    key={`tv-${media.id}`}
                    media={media}
                    showPlex={showPlex}
                    showJellyfin={showJellyfin}
                    size="md"
                  />
                ))}
              </div>
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

// The page-level empty state (both visible sections empty). `icon` only
// matters past page 1 — the filters case always shows the filter glyph.
// With no filter set, an empty page 1 means the sources came back empty (each
// fetch swallows its outage into []), so it must not blame filters the user
// never applied.
function sectionEmptyState(t: Translator, icon: IconComponent, page: number, hasFilters: boolean, retryHref: string) {
  if (page > 1) {
    return (
      <EmptyState
        icon={icon}
        title={t("browse.empty.noMoreResults.title")}
        description={t("browse.empty.noMoreResults.description")}
        cta={{ href: "/top", label: t("browse.empty.backToPage1") }}
      />
    );
  }
  return hasFilters ? (
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
