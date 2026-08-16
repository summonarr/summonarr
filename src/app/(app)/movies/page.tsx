export const dynamic = "force-dynamic";

import { getMovieGenres, getWatchProviders, type DiscoverFilters, type TmdbMedia } from "@/lib/tmdb";
import { requireAppSession } from "@/lib/require-app-session";
import { runBrowseQuery } from "@/lib/browse-query";
import { LiveRefresh } from "@/components/live-refresh";
import { BrowseGrid } from "@/components/media/browse-grid";
import { PageHeader } from "@/components/ui/design";

export default async function MoviesPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string>>;
}) {
  const [sp, session] = await Promise.all([searchParams, requireAppSession()]);
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
  const page           = Math.max(1, parseInt(sp.page ?? "1", 10) || 1);

  const filters: DiscoverFilters = { genreId, keywordId, minRating, minVoteCount, fromYear, toYear, sortBy, watchProvider, watchRegion };

  // Shared with /api/browse — see src/lib/browse-query.ts. The helper THROWS on
  // a first-page failure; a server component has no prior state to preserve, so
  // it degrades to an empty grid here, which is what the per-page .catch() used
  // to do inline.
  const [genres, providers, browse] = await Promise.all([
    getMovieGenres().catch(() => []),
    getWatchProviders("movie", watchRegion).catch(() => []),
    // `failed` distinguishes "TMDB is down" from "no results" — the grid
    // renders a retry banner for the first and an empty state for the second,
    // and the old per-page .catch() collapsed both into the latter.
    runBrowseQuery({ mediaType: "movie", page, filters, hideAvailable, ratingFilter, session })
      .then((r) => ({ ...r, failed: false }))
      .catch(() => ({ items: [] as TmdbMedia[], totalPages: 1, showPlex: false, showJellyfin: false, failed: true })),
  ]);
  const { items, totalPages, showPlex, showJellyfin, failed } = browse;

  return (
    <div className="ds-page-enter">
      <LiveRefresh on={["request:new", "request:updated", "request:deleted"]} />
      <PageHeader title="Movies" />
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
      />
    </div>
  );
}
