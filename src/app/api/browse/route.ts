import { NextResponse } from "next/server";
import { withAuth } from "@/lib/api-auth";
import { getBadgeVisibility } from "@/lib/badge-visibility";
import {
  getPopularMoviesPage, getPopularTVPage,
  discoverMoviesPage, discoverTVPage,
  type TmdbMedia, type DiscoverFilters,
} from "@/lib/tmdb";
import { attachAllAvailability } from "@/lib/attach-all";
import { getShow4kVisibility } from "@/lib/four-k-visibility";
import { checkRateLimit } from "@/lib/rate-limit";

const TMDB_PAGES_PER_VIRTUAL = 5;
const PAGE_SIZE = 20;

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

export const GET = withAuth(async (request, _ctx, session) => {
  if (!checkRateLimit(`browse:${session.user.id}`, 30, 60_000)) {
    return NextResponse.json({ error: "Too many requests" }, { status: 429 });
  }

  const sp = request.nextUrl.searchParams;
  const mediaType     = sp.get("mediaType") === "tv" ? "tv" : "movie";
  const page          = Math.max(1, parseInt(sp.get("page") ?? "1", 10) || 1);
  const genreId       = sp.get("genreId") || undefined;
  const keywordId     = sp.get("keywordId") || undefined;
  const minRating     = sp.get("minRating") || undefined;
  const ratingFilter  = sp.get("ratingFilter") || undefined;
  const minVoteCount  = sp.get("minVoteCount") || undefined;
  const fromYear      = sp.get("fromYear") || undefined;
  const toYear        = sp.get("toYear") || undefined;
  const sortBy        = sp.get("sortBy") || undefined;
  const watchProvider = sp.get("watchProvider") || undefined;
  const watchRegion   = sp.get("watchRegion") || undefined;
  const hideAvailable = sp.get("hideAvailable") === "1";
  // Per-user server visibility for the hideAvailable gate.
  const { showPlex, showJellyfin } = getBadgeVisibility(session);

  const hasFilters = !!(genreId || keywordId || minRating || ratingFilter || minVoteCount || fromYear || toYear || sortBy || watchProvider);
  const filters: DiscoverFilters = { genreId, keywordId, minRating, minVoteCount, fromYear, toYear, sortBy, watchProvider, watchRegion };
  const show4k = await getShow4kVisibility(session);

  const needsLoop = hideAvailable || !!ratingFilter;
  const tmdbStartPage = needsLoop ? (page - 1) * TMDB_PAGES_PER_VIRTUAL + 1 : page;

  const fetchPage = (p: number) =>
    mediaType === "tv"
      ? (hasFilters ? discoverTVPage(filters, p) : getPopularTVPage(p))
      : (hasFilters ? discoverMoviesPage(filters, p) : getPopularMoviesPage(p));

  try {
    const firstPaged = await fetchPage(tmdbStartPage);
    let items: TmdbMedia[] = [];
    let totalPages: number;

    if (needsLoop) {
      totalPages = Math.max(1, Math.ceil(firstPaged.totalPages / TMDB_PAGES_PER_VIRTUAL));
      const tmdbEndPage = Math.min(firstPaged.totalPages, tmdbStartPage + TMDB_PAGES_PER_VIRTUAL - 1);

      // Fetch the whole virtual-page window up front (in parallel) and enrich once,
      // instead of a sequential fetch+enrich per page. fetchPage has no catch here,
      // so guard each extra page — one transient failure degrades to fewer items
      // rather than 500ing the whole request.
      const restPages: number[] = [];
      for (let p = tmdbStartPage + 1; p <= tmdbEndPage; p++) restPages.push(p);
      const rest = await Promise.all(
        restPages.map((p) => fetchPage(p).catch(() => ({ items: [] as TmdbMedia[], totalPages: firstPaged.totalPages }))),
      );
      const rawItems = [firstPaged, ...rest].flatMap((pg) => pg.items);

      // Block on ratings when a filter is active — non-blocking leaves uncached items
      // unrated and they'd be dropped, yielding an empty page on a cold cache.
      let enriched = await attachAllAvailability(rawItems, session.user.id, { show4k, blockRatings: !!ratingFilter });
      if (ratingFilter) enriched = applyExternalRatingFilter(enriched, ratingFilter);
      // Gate hideAvailable on the user's pinned server (a Plex-pinned user shouldn't hide Jellyfin-only titles).
      if (hideAvailable) enriched = enriched.filter((m) => !((showPlex && m.plexAvailable) || (showJellyfin && m.jellyfinAvailable)));
      items = enriched.slice(0, PAGE_SIZE);
    } else {
      totalPages = firstPaged.totalPages;
      items = await attachAllAvailability(firstPaged.items, session.user.id, { show4k });
    }

    return NextResponse.json({ items, totalPages, page });
  } catch (err) {
    console.error("[browse] Failed:", err);
    return NextResponse.json({ error: "Failed to fetch" }, { status: 500 });
  }
});
