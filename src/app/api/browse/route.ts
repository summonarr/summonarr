import { NextResponse } from "next/server";
import { withAuth } from "@/lib/api-auth";
import { parsePageParam } from "@/lib/pagination";
import { discoverFiltersOf, parseBrowseFilters } from "@/lib/browse-filters";
import { checkRateLimit } from "@/lib/rate-limit";
import { runBrowseQuery } from "@/lib/browse-query";
import { translatorForRequest } from "@/lib/i18n/server-locale";

export const GET = withAuth(async (request, _ctx, session) => {
  const t = translatorForRequest(request);
  if (!checkRateLimit(`browse:${session.user.id}`, 30, 60_000)) {
    return NextResponse.json({ error: t("apiUser.common.tooManyRequests") }, { status: 429 });
  }

  const sp = request.nextUrl.searchParams;
  const mediaType = sp.get("mediaType") === "tv" ? "tv" : "movie";
  const page = parsePageParam(sp);
  // The same filter set the /movies and /tv pages read (browse-filters.ts), so
  // a filter added there reaches this API too.
  const browse = parseBrowseFilters((key) => sp.get(key));

  try {
    // Shared with /movies and /tv — see src/lib/browse-query.ts. The helper
    // throws rather than degrading, because this consumer needs the non-2xx:
    // browse-grid keeps its previous items on !res.ok instead of blanking, and
    // tests/discovery-routes.test.mts pins the body.
    const { items, totalPages } = await runBrowseQuery({
      mediaType,
      page,
      filters: discoverFiltersOf(browse),
      hideAvailable: browse.hideAvailable,
      ratingFilter: browse.ratingFilter,
      session,
    });
    return NextResponse.json({ items, totalPages, page });
  } catch (err) {
    console.error("[browse] Failed:", err);
    return NextResponse.json({ error: t("apiUser.common.fetchFailed") }, { status: 500 });
  }
});
