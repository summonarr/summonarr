export const dynamic = "force-dynamic";

import type { Metadata } from "next";
import { getMovieGenres, getWatchProviders, type DiscoverFilters, type TmdbMedia } from "@/lib/tmdb";
import { requireAppSession } from "@/lib/require-app-session";
import { runBrowseQuery } from "@/lib/browse-query";
import { tmdbAuth } from "@/lib/tmdb-auth";
import { LiveRefresh } from "@/components/live-refresh";
import { BrowseGrid } from "@/components/media/browse-grid";
import { PageHeader } from "@/components/ui/design";
import { getTranslator } from "@/lib/i18n/server";

// Tab / bookmark / history title — the nav label, in the viewer's language.
export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslator();
  return { title: t("nav.movies") };
}

export default async function MoviesPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string>>;
}) {
  const [sp, session, t] = await Promise.all([searchParams, requireAppSession(), getTranslator()]);
  const genreId        = sp.genreId        || undefined;
  const keywordId      = sp.keywordId      || undefined;
  const minRating      = sp.minRating      || undefined;
  const ratingFilter   = sp.ratingFilter   || undefined;
  const minVoteCount   = sp.minVoteCount   || undefined;
  const fromYear       = sp.fromYear       || undefined;
  const toYear         = sp.toYear         || undefined;
  const sortBy         = sp.sortBy         || undefined;
  const watchProvider  = sp.watchProvider  || undefined;
  const watchRegion    = sp.watchRegion    || undefined;
  const hideAvailable  = sp.hideAvailable === "1";
  const requestedPage  = Math.max(1, parseInt(sp.page ?? "1", 10) || 1);

  const filters: DiscoverFilters = { genreId, keywordId, minRating, minVoteCount, fromYear, toYear, sortBy, watchProvider, watchRegion };

  // Shared with /api/browse — see src/lib/browse-query.ts. The helper THROWS on
  // a first-page failure; a server component has no prior state to preserve, so
  // it degrades to an empty grid here, which is what the per-page .catch() used
  // to do inline.
  // `failed` distinguishes "TMDB is down" from "no results" — the grid
  // renders a retry banner for the first and an empty state for the second,
  // and the old per-page .catch() collapsed both into the latter.
  const query = (p: number) =>
    runBrowseQuery({ mediaType: "movie", page: p, filters, hideAvailable, ratingFilter, session })
      .then((r) => ({ ...r, failed: false }))
      .catch(() => ({ items: [] as TmdbMedia[], totalPages: 1, showPlex: false, showJellyfin: false, failed: true }));
  const [genres, providers, firstBrowse] = await Promise.all([
    getMovieGenres().catch(() => []),
    getWatchProviders("movie", watchRegion).catch(() => []),
    query(requestedPage),
  ]);
  // Clamp the page ONCE and hand every surface the same number, the way
  // /upcoming does. A stale bookmark (`?page=600` on a set that has shrunk to
  // 500 pages) used to show "Page 500 of 500" in the header while the grid said
  // "past the end" and the pager highlighted 600. TMDB serves one page per
  // call, so the clamped page is re-read — one extra fetch, only on this
  // stale-URL path, and only when the first read itself succeeded (a failed
  // read reports totalPages 1 and would otherwise always "clamp").
  const browse =
    !firstBrowse.failed && requestedPage > firstBrowse.totalPages
      ? await query(Math.max(1, firstBrowse.totalPages))
      : firstBrowse;
  const page = Math.max(1, Math.min(requestedPage, browse.totalPages));
  const { items, totalPages, showPlex, showJellyfin, failed } = browse;

  // Header subtitle. Same predicate as BrowseGrid's own `hasFilters` (which
  // deliberately leaves watchRegion out — a region alone narrows nothing the
  // user asked for); the grid used to render this line itself and pull it up
  // under the header with a negative margin.
  const hasFilters = !!(genreId || keywordId || minRating || ratingFilter || minVoteCount || fromYear || toYear || sortBy || watchProvider || hideAvailable);
  // `items` is ONE TMDB page (~20), not the result set, so a bare count would
  // read "20 results" above a pager offering hundreds of pages. Page-scoped when
  // there is more than one page; a count only when this page is everything.
  // A failed fetch states no number — the grid's retry banner says what happened.
  const subtitle = !hasFilters
    ? t("browse.popularNow")
    : failed
      ? t("browse.filteredResults")
      : totalPages > 1
        ? t("browse.pageOf", { page, total: totalPages })
        : t("browse.results", { count: items.length });

  return (
    <div className="ds-page-enter">
      <LiveRefresh on={["request:new", "request:updated", "request:deleted"]} />
      <PageHeader title={t("nav.movies")} subtitle={subtitle} />
      <BrowseGrid
        initialItems={items}
        initialTotalPages={totalPages}
        initialPage={page}
        genres={genres}
        watchProviders={providers}
        showPlex={showPlex}
        showJellyfin={showJellyfin}
        maxYear={new Date().getUTCFullYear() + 1}
        failed={failed}
        tokenMissing={tmdbAuth() === null}
      />
    </div>
  );
}
