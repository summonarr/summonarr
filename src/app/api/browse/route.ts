import { NextResponse } from "next/server";
import { withAuth } from "@/lib/api-auth";
import { parsePageParam } from "@/lib/pagination";
import { type DiscoverFilters } from "@/lib/tmdb";
import { checkRateLimit } from "@/lib/rate-limit";
import { runBrowseQuery } from "@/lib/browse-query";
import { translatorForRequest } from "@/lib/i18n/server-locale";

export const GET = withAuth(async (request, _ctx, session) => {
  const t = translatorForRequest(request);
  if (!checkRateLimit(`browse:${session.user.id}`, 30, 60_000)) {
    return NextResponse.json({ error: t("apiUser.common.tooManyRequests") }, { status: 429 });
  }

  const sp = request.nextUrl.searchParams;
  const mediaType     = sp.get("mediaType") === "tv" ? "tv" : "movie";
  const page          = parsePageParam(sp);
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
  const filters: DiscoverFilters = { genreId, keywordId, minRating, minVoteCount, fromYear, toYear, sortBy, watchProvider, watchRegion };

  try {
    // Shared with /movies and /tv — see src/lib/browse-query.ts. The helper
    // throws rather than degrading, because this consumer needs the non-2xx:
    // browse-grid keeps its previous items on !res.ok instead of blanking, and
    // tests/discovery-routes.test.mts pins the body.
    const { items, totalPages } = await runBrowseQuery({
      mediaType,
      page,
      filters,
      hideAvailable,
      ratingFilter,
      session,
    });
    return NextResponse.json({ items, totalPages, page });
  } catch (err) {
    console.error("[browse] Failed:", err);
    return NextResponse.json({ error: t("apiUser.common.fetchFailed") }, { status: 500 });
  }
});
