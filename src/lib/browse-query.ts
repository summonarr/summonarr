import "server-only";
import type { SummonarrSession } from "@/lib/api-auth";
import type { DiscoverFilters, TmdbMedia } from "@/lib/tmdb-types";
import {
  discoverMoviesPage,
  discoverTVPage,
  getPopularMoviesPage,
  getPopularTVPage,
} from "@/lib/tmdb";
import { attachAllAvailability } from "@/lib/attach-all";
import { getBadgeVisibility } from "@/lib/badge-visibility";
import { getShow4kVisibility } from "@/lib/four-k-visibility";
import { isFeatureEnabled } from "@/lib/features";

// The discover + enrichment pipeline behind /movies, /tv and /api/browse.
//
// It lived in all three, and the two copies that were meant to be identical
// were — movies/page.tsx and tv/page.tsx differ only in which media type they
// name. The route was the odd one out, in two ways that both reached users:
//
//   • it resolved 4K visibility WITHOUT a media type, so it got the OR of both
//     backends. /api/browse serves exactly one type per request, so it is a
//     single-type list and must scope. A user who may request 4K TV but not 4K
//     movies, on a server with Radarr-4K configured, saw no 4K badges on the
//     SSR-rendered first page of /movies and then saw them on page 2, which the
//     client fetches from here.
//   • it resolved badge visibility without the integration flags, which default
//     to true — so with an integration disabled, `hideAvailable` on a
//     client-fetched page hid titles the server-rendered page had shown.
//
// Both are resolved INSIDE this function rather than taken as arguments. That
// is the point: passing them in would leave exactly the same two call sites
// free to drift apart again.
//
// Deliberately NOT handled here: failure. A server component has nothing to
// fall back on and degrades to an empty grid; the route's consumer holds prior
// state and relies on a non-2xx to keep it (a contract pinned by
// tests/discovery-routes.test.mts). So this throws and each caller decides.

const TMDB_PAGES_PER_VIRTUAL = 5;

// Copied verbatim from the three callers — NOT rewritten. The fields are
// strings on TmdbMedia (imdbRating/rottenTomatoes/rtAudienceScore), each parsed
// differently, and an unrecognised source passes everything through rather than
// filtering everything out. Every one of those is easy to get wrong from
// memory, and getting it wrong empties the grid silently.
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

export interface BrowseQueryInput {
  mediaType: "movie" | "tv";
  /** Already clamped by the caller. */
  page: number;
  filters: DiscoverFilters;
  hideAvailable: boolean;
  ratingFilter?: string;
  session: SummonarrSession;
}

export interface BrowseQueryResult {
  items: TmdbMedia[];
  totalPages: number;
  /** Returned so the page components can pass them straight to BrowseGrid. */
  showPlex: boolean;
  showJellyfin: boolean;
}

export function browseHasFilters(f: DiscoverFilters, ratingFilter?: string): boolean {
  // watchRegion is deliberately excluded — it only qualifies watchProvider and
  // must not by itself flip the query from "popular" to "discover".
  return !!(
    f.genreId || f.keywordId || f.minRating || ratingFilter || f.minVoteCount ||
    f.fromYear || f.toYear || f.sortBy || f.watchProvider
  );
}

export async function runBrowseQuery(input: BrowseQueryInput): Promise<BrowseQueryResult> {
  const { mediaType, page, filters, hideAvailable, ratingFilter, session } = input;
  const isTv = mediaType === "tv";
  const hasFilters = browseHasFilters(filters, ratingFilter);

  const fetchPage = (p: number) =>
    isTv
      ? (hasFilters ? discoverTVPage(filters, p) : getPopularTVPage(p))
      : (hasFilters ? discoverMoviesPage(filters, p) : getPopularMoviesPage(p));

  // needsLoop is exactly the set of filters TMDB cannot express: an external
  // rating threshold (TMDB holds no IMDb/RT data) and hideAvailable (needs this
  // server's library state). Everything else goes down in the discover query and
  // never widens the window at all.
  const needsLoop = hideAvailable || !!ratingFilter;
  const tmdbStartPage = needsLoop ? (page - 1) * TMDB_PAGES_PER_VIRTUAL + 1 : page;

  // Scheduled alongside the first TMDB fetch rather than awaited before it —
  // the route paid an extra serial round-trip for this.
  const [firstPaged, show4k, plexEnabled, jellyfinEnabled] = await Promise.all([
    fetchPage(tmdbStartPage),
    // Scoped to THIS request's media type — the route omitted the argument and
    // silently got the OR of both backends.
    getShow4kVisibility(session, mediaType),
    isFeatureEnabled("feature.integration.plex"),
    isFeatureEnabled("feature.integration.jellyfin"),
  ]);
  // Resolved here, with the integration flags, because they default to TRUE when
  // omitted — which is how the route ended up hiding titles on a disabled
  // integration that the server-rendered page had shown.
  const { showPlex, showJellyfin } = getBadgeVisibility(session, {
    plex: plexEnabled,
    jellyfin: jellyfinEnabled,
  });

  if (!needsLoop) {
    return {
      items: await attachAllAvailability(firstPaged.items, session.user.id, { show4k }),
      totalPages: firstPaged.totalPages,
      showPlex,
      showJellyfin,
    };
  }

  const totalPages = Math.max(1, Math.ceil(firstPaged.totalPages / TMDB_PAGES_PER_VIRTUAL));
  const tmdbEndPage = Math.min(firstPaged.totalPages, tmdbStartPage + TMDB_PAGES_PER_VIRTUAL - 1);

  // The window is fetched and enriched in one go rather than page-by-page. Only
  // the EXTRA pages are guarded — a transient failure there degrades to fewer
  // items, while a first-page failure is the caller's to interpret.
  const restPages: number[] = [];
  for (let p = tmdbStartPage + 1; p <= tmdbEndPage; p++) restPages.push(p);
  const rest = await Promise.all(
    restPages.map((p) => fetchPage(p).catch(() => ({ items: [] as TmdbMedia[], totalPages: firstPaged.totalPages }))),
  );
  const rawItems = [firstPaged, ...rest].flatMap((pg) => pg.items);

  // Blocking on ratings is required when a rating filter is active — a
  // non-blocking read leaves uncached items unrated, and they would then be
  // filtered out, emptying the page on a cold cache.
  let enriched = await attachAllAvailability(rawItems, session.user.id, { show4k, blockRatings: !!ratingFilter });
  if (ratingFilter) enriched = applyExternalRatingFilter(enriched, ratingFilter);
  // Gated on the user's own visible servers — a Plex-pinned user must not have
  // Jellyfin-only titles hidden from them.
  if (hideAvailable) {
    enriched = enriched.filter((m) => !((showPlex && m.plexAvailable) || (showJellyfin && m.jellyfinAvailable)));
  }

  // The whole filtered window is returned, NOT a 20-item slice.
  //
  // The window is 5 TMDB pages = up to 100 items, and slicing to 20 discarded
  // every survivor past the twentieth — permanently, because virtual page 2
  // starts at TMDB page 6 and never revisits them. Items were dropped whenever
  // more than 20% of a window survived, so a PERMISSIVE filter was the bad case:
  // at full survival, 80 of every 100 matching titles were unreachable while
  // browsing under that filter, and the reachable depth fell from 10,000 items
  // to 2,000.
  //
  // Returning them costs almost nothing: attachAllAvailability has already run
  // on the entire window, so the discarded items were fully enriched before
  // being thrown away. Neither client assumes a page size — the web grid maps
  // whatever it receives and iOS appends and dedupes — so page length simply
  // varies, which is strictly better than silently hiding matches.
  return { items: enriched, totalPages, showPlex, showJellyfin };
}
