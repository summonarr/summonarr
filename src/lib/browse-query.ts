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
import { forgetWarnOnChange, warnOnChange } from "@/lib/log-dedup";
import { hasQueryFilters } from "@/lib/browse-filters";

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
const EXTRA_PAGE_WARN_KEY = "browse:tmdb-extra-page";

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

// A filtered virtual page's TMDB pages after the first, fetched together, then
// merged with it. Only the EXTRA pages are guarded — a transient failure there
// degrades to fewer items, while a first-page failure is the caller's to
// interpret. The response can't say it is short (the clients read a fixed
// shape), so the failure is logged — once per distinct error, not once per
// request (7b).
//
// Each TMDB page is cached on its own schedule, and popularity ranks move
// between fills, so a title can sit on two adjacent pages: the merge keeps
// its first occurrence only (the grid keys cards by id).
async function fetchWindowItems(
  fetchPage: (p: number) => Promise<{ items: TmdbMedia[]; totalPages: number }>,
  firstPaged: { items: TmdbMedia[]; totalPages: number },
  tmdbStartPage: number,
  tmdbEndPage: number,
): Promise<TmdbMedia[]> {
  const restPages: number[] = [];
  for (let p = tmdbStartPage + 1; p <= tmdbEndPage; p++) restPages.push(p);
  let extraPageFailed = false;
  const rest = await Promise.all(
    restPages.map((p) => fetchPage(p).catch((err: unknown) => {
      extraPageFailed = true;
      const msg = err instanceof Error ? err.message : String(err);
      warnOnChange(EXTRA_PAGE_WARN_KEY, msg, `[browse] a TMDB page of a filtered window failed, so it shows fewer items: ${msg}`);
      return { items: [] as TmdbMedia[], totalPages: firstPaged.totalPages };
    })),
  );
  if (!extraPageFailed && restPages.length > 0) forgetWarnOnChange(EXTRA_PAGE_WARN_KEY);
  return dedupeMedia([firstPaged, ...rest].flatMap((pg) => pg.items));
}

/** First occurrence of each (id, media type), order kept. */
export function dedupeMedia(items: TmdbMedia[]): TmdbMedia[] {
  const seen = new Set<string>();
  const out: TmdbMedia[] = [];
  for (const m of items) {
    const key = `${m.id}:${m.mediaType}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(m);
  }
  return out;
}

// The two filters TMDB can't apply. hideAvailable is gated on the user's own
// visible servers — a Plex-pinned user must not have Jellyfin-only titles
// hidden from them.
function applyWindowFilters(
  items: TmdbMedia[],
  opts: { ratingFilter?: string; hideAvailable: boolean; showPlex: boolean; showJellyfin: boolean },
): TmdbMedia[] {
  let out = opts.ratingFilter ? applyExternalRatingFilter(items, opts.ratingFilter) : items;
  if (opts.hideAvailable) {
    out = out.filter((m) => !((opts.showPlex && m.plexAvailable) || (opts.showJellyfin && m.jellyfinAvailable)));
  }
  return out;
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
  // The term list is shared with the pages' UI predicate (browse-filters.ts).
  // watchRegion is deliberately excluded — it only qualifies watchProvider and
  // must not by itself flip the query from "popular" to "discover".
  return hasQueryFilters({ ...f, ratingFilter });
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

  // A page past the end is EMPTY. TMDB clamps its page number at 500, so the
  // fetch above served the last real page — under the requested number, which
  // the route echoes back, so a client paging on would see the same titles
  // again. Nothing is enriched for it.
  if (!needsLoop) {
    if (page > Math.max(1, firstPaged.totalPages)) {
      return { items: [], totalPages: firstPaged.totalPages, showPlex, showJellyfin };
    }
    return {
      items: await attachAllAvailability(firstPaged.items, session.user.id, { show4k }),
      totalPages: firstPaged.totalPages,
      showPlex,
      showJellyfin,
    };
  }

  const totalPages = Math.max(1, Math.ceil(firstPaged.totalPages / TMDB_PAGES_PER_VIRTUAL));
  if (page > totalPages) return { items: [], totalPages, showPlex, showJellyfin };
  const tmdbEndPage = Math.min(firstPaged.totalPages, tmdbStartPage + TMDB_PAGES_PER_VIRTUAL - 1);

  const rawItems = await fetchWindowItems(fetchPage, firstPaged, tmdbStartPage, tmdbEndPage);

  // Blocking on ratings is required when a rating filter is active — a
  // non-blocking read leaves uncached items unrated, and they would then be
  // filtered out, emptying the page on a cold cache.
  const enriched = applyWindowFilters(
    await attachAllAvailability(rawItems, session.user.id, { show4k, blockRatings: !!ratingFilter }),
    { ratingFilter, hideAvailable, showPlex, showJellyfin },
  );

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
