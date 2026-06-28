export const dynamic = "force-dynamic";

import {
  getPopularTVPage, discoverTVPage, getTVGenres, getWatchProviders,
  type TmdbMedia, type DiscoverFilters,
} from "@/lib/tmdb";
import { attachAllAvailability } from "@/lib/attach-all";
import { auth } from "@/lib/auth";
import { getBadgeVisibility } from "@/lib/badge-visibility";
import { getShow4kVisibility } from "@/lib/four-k-visibility";
import { isFeatureEnabled } from "@/lib/features";
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

export default async function TVPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string>>;
}) {
  const [sp, session] = await Promise.all([searchParams, auth()]);
  const [show4k, plexEnabled, jellyfinEnabled] = await Promise.all([
    getShow4kVisibility(session, "tv"),
    isFeatureEnabled("feature.integration.plex"),
    isFeatureEnabled("feature.integration.jellyfin"),
  ]);
  const { showPlex, showJellyfin } = getBadgeVisibility(session, { plex: plexEnabled, jellyfin: jellyfinEnabled });
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

  const hasFilters = !!(genreId || keywordId || minRating || ratingFilter || minVoteCount || fromYear || toYear || sortBy || watchProvider);
  const filters: DiscoverFilters = { genreId, keywordId, minRating, minVoteCount, fromYear, toYear, sortBy, watchProvider, watchRegion };

  const needsLoop = hideAvailable || !!ratingFilter;
  const tmdbStartPage = needsLoop ? (page - 1) * TMDB_PAGES_PER_VIRTUAL + 1 : page;

  const fetchPage = (p: number) =>
    (hasFilters
      ? discoverTVPage(filters, p)
      : getPopularTVPage(p)
    ).catch(() => ({ items: [] as TmdbMedia[], totalPages: 1 }));

  const [genres, providers, firstPaged] = await Promise.all([
    getTVGenres().catch(() => []),
    getWatchProviders("tv", watchRegion).catch(() => []),
    fetchPage(tmdbStartPage),
  ]);

  let items: TmdbMedia[] = [];
  let totalPages: number;

  if (needsLoop) {
    totalPages = Math.max(1, Math.ceil(firstPaged.totalPages / TMDB_PAGES_PER_VIRTUAL));
    const tmdbEndPage = Math.min(firstPaged.totalPages, tmdbStartPage + TMDB_PAGES_PER_VIRTUAL - 1);

    // Fetch the whole virtual-page window up front (in parallel) and enrich once.
    // The old loop ran a sequential fetch+enrich per page; when filtering discards
    // most results (e.g. hideAvailable on a fully-owned library) that was up to 5
    // serial round-trips of TMDB-fetch + attachAllAvailability. fetchPage already
    // catches per-page, so a failed page yields no items rather than rejecting.
    const restPages: number[] = [];
    for (let p = tmdbStartPage + 1; p <= tmdbEndPage; p++) restPages.push(p);
    const rest = await Promise.all(restPages.map(fetchPage));
    const rawItems = [firstPaged, ...rest].flatMap((pg) => pg.items);

    // Block on ratings when a filter is active — non-blocking leaves uncached items
    // unrated and they'd be dropped, yielding an empty page on a cold cache.
    let enriched = await attachAllAvailability(rawItems, session?.user.id, { show4k, blockRatings: !!ratingFilter });
    if (ratingFilter) enriched = applyExternalRatingFilter(enriched, ratingFilter);
    // Gate hideAvailable on the user's pinned server so a Plex-pinned user doesn't hide
    // Jellyfin-only titles (and vice versa).
    if (hideAvailable) enriched = enriched.filter((m) => !((showPlex && m.plexAvailable) || (showJellyfin && m.jellyfinAvailable)));
    items = enriched.slice(0, 20);
  } else {
    totalPages = firstPaged.totalPages;
    items = await attachAllAvailability(firstPaged.items, session?.user.id, { show4k });
  }

  return (
    <div className="ds-page-enter">
      <LiveRefresh on={["request:new", "request:updated", "request:deleted"]} />
      <PageHeader title="TV Shows" />
      <BrowseGrid
        mediaType="tv"
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
