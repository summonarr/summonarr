import { NextResponse } from "next/server";
import { withAuth } from "@/lib/api-auth";
import { parsePageParam } from "@/lib/pagination";
import { getMostPopularOnServer, POPULAR_PER_PAGE, type PopularSort } from "@/lib/play-history";
import { attachAllAvailability } from "@/lib/attach-all";
import { getShow4kVisibility } from "@/lib/four-k-visibility";
import { checkRateLimit } from "@/lib/rate-limit";
import { isFeatureEnabled } from "@/lib/features";
import { translatorForRequest } from "@/lib/i18n/server-locale";
import { parsePopularMediaFilter, resolvePopularTitles, type PopularTitle } from "@/lib/popular-titles";
import type { PopularResult } from "@/lib/play-history-popular";

// Cap cold-cache TMDB detail fetches per page — a cold page can otherwise fan out
// dozens of concurrent /movie & /tv lookups. Matches the TMDB list-page discipline.
const DETAIL_CONCURRENCY = 5;

const POPULAR_SORTS: readonly PopularSort[] = ["plays", "viewers", "trending"];
// The type a filter leaves out: no query, nothing on the page.
const SKIPPED: PopularResult = { items: [], totalItems: 0, totalPages: 1, page: 1 };

// Native-client mirror of src/app/(app)/popular/page.tsx — most-played media on
// the connected Plex/Jellyfin servers. Keep the resolve + enrich logic in sync
// with that page (it is the same getMostPopularOnServer aggregation).
export const GET = withAuth(async (request, _ctx, session) => {
  const t = translatorForRequest(request);
  if (!(await isFeatureEnabled("feature.page.popular"))) {
    return NextResponse.json({ error: t("apiUser.browse.popularDisabled") }, { status: 403 });
  }
  if (!checkRateLimit(`popular:${session.user.id}`, 30, 60_000)) {
    return NextResponse.json({ error: t("apiUser.common.tooManyRequests") }, { status: 429 });
  }

  const sp = request.nextUrl.searchParams;
  const mediaTypeFilter = parsePopularMediaFilter(sp.get("mediaType"));
  if (mediaTypeFilter === null) {
    return NextResponse.json({ error: t("apiUser.browse.popularMediaTypeInvalid") }, { status: 400 });
  }
  const sortParam = sp.get("sort");
  const sort: PopularSort = POPULAR_SORTS.find((s) => s === sortParam) ?? "trending";
  const requestedPage = parsePageParam(sp);

  try {
    const show4k = await getShow4kVisibility(session);
    const [moviesResult, tvResult] = await Promise.all([
      mediaTypeFilter === "tv" ? SKIPPED : getMostPopularOnServer({ mediaType: "MOVIE", sort, page: requestedPage }),
      mediaTypeFilter === "movies" ? SKIPPED : getMostPopularOnServer({ mediaType: "TV", sort, page: requestedPage }),
    ]);
    // getMostPopularOnServer clamps a deep ?page= to page 100 only: a page past
    // the ranking's own last page is served as asked, with no items. The page
    // and rank offset answered are the page it SERVED.
    const page = Math.max(moviesResult.page, tvResult.page);

    const [movieTitles, tvTitles] = await Promise.all([
      resolvePopularTitles(moviesResult.items, "movie", DETAIL_CONCURRENCY),
      resolvePopularTitles(tvResult.items, "tv", DETAIL_CONCURRENCY),
    ]);
    // attachAllAvailability is generic, so the play stats come back typed.
    const enrich = (items: PopularTitle[]) => attachAllAvailability(items, session.user.id, { show4k });
    const [movies, tv] = await Promise.all([enrich(movieTitles), enrich(tvTitles)]);

    // normalize emits `keywords` as a names array (string[]) at the source, so
    // the getMovieDetails/getTVDetails shape ships straight through — no per-route
    // flattening needed (it previously held object form and broke native decode).
    return NextResponse.json({
      movies,
      tv,
      totalMovies: moviesResult.totalItems,
      totalTv: tvResult.totalItems,
      totalPages: Math.max(moviesResult.totalPages, tvResult.totalPages),
      page,
      sort,
      rankOffset: (page - 1) * POPULAR_PER_PAGE,
    });
  } catch (err) {
    console.error("[popular] Failed:", err);
    return NextResponse.json({ error: t("apiUser.common.fetchFailed") }, { status: 500 });
  }
});
