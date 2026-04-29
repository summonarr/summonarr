export const dynamic = "force-dynamic";

import {
  getPopularMoviesPage, discoverMoviesPage, getMovieGenres, getWatchProviders,
  type TmdbMedia, type DiscoverFilters,
} from "@/lib/tmdb";
import { attachAllAvailability } from "@/lib/attach-all";
import { auth } from "@/lib/auth";
import { getBadgeVisibility } from "@/lib/badge-visibility";
import { LiveRefresh } from "@/components/live-refresh";
import { BrowseGrid } from "@/components/media/browse-grid";
import { PageHeader } from "@/components/ui/design";

function applyExternalRatingFilter(items: TmdbMedia[], ratingFilter: string): TmdbMedia[] {
  const colon = ratingFilter.indexOf(":");
  if (colon === -1) return items;
  const source = ratingFilter.slice(0, colon);
  const threshold = parseFloat(ratingFilter.slice(colon + 1));
  if (isNaN(threshold)) return items;

  return items.filter((item) => {
    if (source === "imdb") {
      const r = parseFloat(item.imdbRating ?? "");
      return !isNaN(r) && r >= threshold;
    }
    if (source === "rt") {
      const r = parseInt(item.rottenTomatoes ?? "");
      return !isNaN(r) && r >= threshold;
    }
    if (source === "rta") {
      const r = parseInt(item.rtAudienceScore ?? "");
      return !isNaN(r) && r >= threshold;
    }
    return true;
  });
}

const TMDB_PAGES_PER_VIRTUAL = 5;

export default async function MoviesPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string>>;
}) {
  const [sp, session] = await Promise.all([searchParams, auth()]);
  const { showPlex, showJellyfin } = getBadgeVisibility(session);
  const genreId        = sp.genreId        || undefined;
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

  const hasFilters = !!(genreId || minRating || ratingFilter || minVoteCount || fromYear || toYear || sortBy || watchProvider);
  const filters: DiscoverFilters = { genreId, minRating, minVoteCount, fromYear, toYear, sortBy, watchProvider, watchRegion };

  const needsLoop = hideAvailable || !!ratingFilter;
  const tmdbStartPage = needsLoop ? (page - 1) * TMDB_PAGES_PER_VIRTUAL + 1 : page;

  const fetchPage = (p: number) =>
    (hasFilters
      ? discoverMoviesPage(filters, p)
      : getPopularMoviesPage(p)
    ).catch(() => ({ items: [] as TmdbMedia[], totalPages: 1 }));

  const [genres, providers, firstPaged] = await Promise.all([
    getMovieGenres().catch(() => []),
    getWatchProviders("movie", watchRegion).catch(() => []),
    fetchPage(tmdbStartPage),
  ]);

  let items: TmdbMedia[] = [];
  let totalPages: number;

  if (needsLoop) {
    totalPages = Math.max(1, Math.ceil(firstPaged.totalPages / TMDB_PAGES_PER_VIRTUAL));
    const tmdbEndPage = tmdbStartPage + TMDB_PAGES_PER_VIRTUAL - 1;
    let tmdbPage = tmdbStartPage;

    while (items.length < 20 && tmdbPage <= Math.min(firstPaged.totalPages, tmdbEndPage)) {
      const paged = tmdbPage === tmdbStartPage ? firstPaged : await fetchPage(tmdbPage);
      let batch = await attachAllAvailability(paged.items, session?.user.id);
      if (ratingFilter) batch = applyExternalRatingFilter(batch, ratingFilter);
      if (hideAvailable) batch = batch.filter((m) => !(m.plexAvailable || m.jellyfinAvailable));
      items = items.concat(batch);
      tmdbPage++;
    }
    items = items.slice(0, 20);
  } else {
    totalPages = firstPaged.totalPages;
    items = await attachAllAvailability(firstPaged.items, session?.user.id);
  }

  return (
    <div className="ds-page-enter">
      <LiveRefresh on={["request:new", "request:updated", "request:deleted"]} />
      <PageHeader title="Movies" />
      <BrowseGrid
        mediaType="movie"
        initialItems={items}
        initialTotalPages={totalPages}
        initialPage={page}
        genres={genres}
        watchProviders={providers}
        showPlex={showPlex}
        showJellyfin={showJellyfin}
        maxYear={new Date().getUTCFullYear() + 1}
      />
    </div>
  );
}
