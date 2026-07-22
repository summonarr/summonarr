export const dynamic = "force-dynamic";

import { getTopRatedMovies, getTopRatedTV, type TmdbMedia } from "@/lib/tmdb";
import { getTraktPopularMovies, getTraktPopularTV } from "@/lib/trakt";
import { getMdblistTopRated } from "@/lib/mdblist";
import { MediaCard } from "@/components/media/media-card";
import { PaginationBar } from "@/components/media/pagination-bar";
import { attachAllAvailability } from "@/lib/attach-all";
import { Suspense } from "react";
import { TopFilterBar } from "@/components/media/top-filter-bar";
import { requireAppSession } from "@/lib/require-app-session";
import { getBadgeVisibility } from "@/lib/badge-visibility";
import { getShow4kVisibility } from "@/lib/four-k-visibility";
import { LiveRefresh } from "@/components/live-refresh";
import { prisma } from "@/lib/prisma";
import { requireFeature } from "@/lib/features";
import { PageHeader, EmptyState } from "@/components/ui/design";
import { Filter, Film, Tv } from "@/components/icons";

const PER_PAGE = 36;

type SortBy = "imdb" | "letterboxd" | "rt" | "trakt" | "mdblist";

const SORT_LABELS: Record<SortBy, string> = {
  imdb: "IMDb rating",
  letterboxd: "Letterboxd rating",
  rt: "Rotten Tomatoes score",
  trakt: "Trakt rating",
  mdblist: "MDBList composite score",
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
  opts: { hideAvailable: boolean; minImdb?: string; minVotes?: string; fromYear?: string; toYear?: string },
): TmdbMedia[] {
  let result = items;
  if (opts.hideAvailable) {
    result = result.filter((m) => !(m.plexAvailable || m.jellyfinAvailable));
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

export default async function TopRatedPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string>>;
}) {
  await requireFeature("feature.page.top");
  const [sp, session] = await Promise.all([searchParams, requireAppSession()]);
  const hideAvailable = sp.hideAvailable === "1";
  const mediaType     = sp.mediaType || undefined;
  const minImdb       = sp.minImdb   || undefined;
  const minVotes      = sp.minVotes  || undefined;
  const fromYear      = sp.fromYear  || undefined;
  const toYear        = sp.toYear    || undefined;
  const validSorts = new Set<SortBy>(["imdb", "letterboxd", "rt", "trakt", "mdblist"]);
  const sortBy: SortBy = validSorts.has(sp.sortBy as SortBy) ? (sp.sortBy as SortBy) : "imdb";
  const page = Math.max(1, parseInt(sp.page ?? "1", 10) || 1);
  const { showPlex, showJellyfin } = getBadgeVisibility(session);

  const filterOpts = { hideAvailable, minImdb, minVotes, fromYear, toYear };
  const hasFilters = !!(hideAvailable || minImdb || minVotes || fromYear || toYear);

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
    // Block on ratings when minImdb is active — applyFilters needs a parsed rating, and
    // non-blocking enrichment leaves uncached items unrated and filtered out.
    const [enrichedMovies, enrichedTV] = await Promise.all([
      showMovies && allMovies.length > 0
        ? backfillMetadata(allMovies).then((m) => attachAllAvailability(m, session?.user.id, { show4k, blockRatings: !!minImdb }))
        : Promise.resolve([] as TmdbMedia[]),
      showTV && allTV.length > 0
        ? backfillMetadata(allTV).then((t) => attachAllAvailability(t, session?.user.id, { show4k, blockRatings: !!minImdb }))
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

  const subtitleBits = [
    `Sorted by ${SORT_LABELS[sortBy]}`,
    sourceCount > 1 ? `${sourceCount} sources` : null,
    `${allMovies.length + allTV.length} titles`,
  ].filter(Boolean) as string[];

  return (
    <div className="ds-page-enter">
      <LiveRefresh on={["request:new", "request:updated", "request:deleted"]} />
      <PageHeader title="Top Rated" subtitle={subtitleBits.join(" · ")} />

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

      {showMovies && (
        <section style={{ marginBottom: 40 }}>
          <SectionHeader
            title="Movies"
            range={
              totalMovieCount > 0
                ? `${offset + 1}–${Math.min(offset + movies.length, totalMovieCount)} of ${totalMovieCount}`
                : undefined
            }
          />
          {movies.length === 0 ? (
            page > 1 ? (
              <EmptyState
                icon={Film}
                title="No more results on this page"
                description="Try going back to the first page."
                cta={{ href: "/top", label: "Back to page 1" }}
              />
            ) : (
              <EmptyState
                icon={Filter}
                title="No results match these filters"
                description="Try removing one or two filters to see more."
                {...(hasFilters
                  ? { cta: { href: "/top", label: "Clear filters" } }
                  : {})}
              />
            )
          ) : (
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
          )}
        </section>
      )}

      {showTV && (
        <section style={{ marginBottom: 40 }}>
          <SectionHeader
            title="TV Shows"
            range={
              totalTvCount > 0
                ? `${offset + 1}–${Math.min(offset + tv.length, totalTvCount)} of ${totalTvCount}`
                : undefined
            }
          />
          {tv.length === 0 ? (
            page > 1 ? (
              <EmptyState
                icon={Tv}
                title="No more results on this page"
                description="Try going back to the first page."
                cta={{ href: "/top", label: "Back to page 1" }}
              />
            ) : (
              <EmptyState
                icon={Filter}
                title="No results match these filters"
                description="Try removing one or two filters to see more."
                {...(hasFilters
                  ? { cta: { href: "/top", label: "Clear filters" } }
                  : {})}
              />
            )
          ) : (
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
          )}
        </section>
      )}

      <Suspense>
        <PaginationBar currentPage={page} totalPages={totalPages} />
      </Suspense>
    </div>
  );
}

function SectionHeader({ title, range }: { title: string; range?: string }) {
  return (
    <div className="flex items-end mb-3">
      <h2
        className="section-title m-0 font-semibold"
        style={{
          fontSize: 15,
          letterSpacing: "-0.01em",
          color: "var(--ds-fg)",
        }}
      >
        {title}
      </h2>
      {range && (
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
      )}
    </div>
  );
}
