import { NextRequest, NextResponse } from "next/server";
import { auth, isTokenExpired } from "@/lib/auth";
import {
  getPopularMoviesPage, getPopularTVPage,
  discoverMoviesPage, discoverTVPage,
  type TmdbMedia, type DiscoverFilters,
} from "@/lib/tmdb";
import { attachAllAvailability } from "@/lib/attach-all";

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

export async function GET(request: NextRequest) {
  const session = await auth();
  if (!session || isTokenExpired(session)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const sp = request.nextUrl.searchParams;
  const mediaType     = sp.get("mediaType") === "tv" ? "tv" : "movie";
  const page          = Math.max(1, parseInt(sp.get("page") ?? "1", 10) || 1);
  const genreId       = sp.get("genreId") || undefined;
  const minRating     = sp.get("minRating") || undefined;
  const ratingFilter  = sp.get("ratingFilter") || undefined;
  const minVoteCount  = sp.get("minVoteCount") || undefined;
  const fromYear      = sp.get("fromYear") || undefined;
  const toYear        = sp.get("toYear") || undefined;
  const sortBy        = sp.get("sortBy") || undefined;
  const watchProvider = sp.get("watchProvider") || undefined;
  const watchRegion   = sp.get("watchRegion") || undefined;
  const hideAvailable = sp.get("hideAvailable") === "1";

  const hasFilters = !!(genreId || minRating || ratingFilter || minVoteCount || fromYear || toYear || sortBy || watchProvider);
  const filters: DiscoverFilters = { genreId, minRating, minVoteCount, fromYear, toYear, sortBy, watchProvider, watchRegion };

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
      const tmdbEndPage = tmdbStartPage + TMDB_PAGES_PER_VIRTUAL - 1;
      let tmdbPage = tmdbStartPage;

      while (items.length < PAGE_SIZE && tmdbPage <= Math.min(firstPaged.totalPages, tmdbEndPage)) {
        const paged = tmdbPage === tmdbStartPage ? firstPaged : await fetchPage(tmdbPage);
        let batch = await attachAllAvailability(paged.items, session.user.id);
        if (ratingFilter) batch = applyExternalRatingFilter(batch, ratingFilter);
        if (hideAvailable) batch = batch.filter((m) => !(m.plexAvailable || m.jellyfinAvailable));
        items = items.concat(batch);
        tmdbPage++;
      }
      items = items.slice(0, PAGE_SIZE);
    } else {
      totalPages = firstPaged.totalPages;
      items = await attachAllAvailability(firstPaged.items, session.user.id);
    }

    return NextResponse.json({ items, totalPages, page });
  } catch (err) {
    console.error("[browse] Failed:", err);
    return NextResponse.json({ error: "Failed to fetch" }, { status: 500 });
  }
}
