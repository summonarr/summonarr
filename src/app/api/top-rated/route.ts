import { NextResponse } from "next/server";
import { withAuth } from "@/lib/api-auth";
import { parsePageParam } from "@/lib/pagination";
import { checkRateLimit } from "@/lib/rate-limit";
import { isFeatureEnabled } from "@/lib/features";
import { translatorForRequest } from "@/lib/i18n/server-locale";
import { parseTopRatedQuery, runTopRatedQuery } from "@/lib/top-rated";

// Native-client mirror of src/app/(app)/top/page.tsx — deduplicated top-rated
// titles across TMDB + Trakt + MDBList, sorted by a chosen rating source. The
// parsing, dedupe, backfill, filters and sort are shared with that page through
// src/lib/top-rated.ts, so the two can no longer drift.
export const GET = withAuth(async (request, _ctx, session) => {
  const t = translatorForRequest(request);
  if (!(await isFeatureEnabled("feature.page.top"))) {
    return NextResponse.json({ error: t("apiUser.browse.topRatedDisabled") }, { status: 403 });
  }
  if (!checkRateLimit(`top-rated:${session.user.id}`, 30, 60_000)) {
    return NextResponse.json({ error: t("apiUser.common.tooManyRequests") }, { status: 429 });
  }

  const sp = request.nextUrl.searchParams;
  const query = parseTopRatedQuery((key) => sp.get(key));
  const page = parsePageParam(sp);

  try {
    const { movies, tv, totalMovies, totalTv, totalPages, failedSources } =
      await runTopRatedQuery({ query, page, session });
    // This route degrades on a source failure (it still answers 200 with what
    // the other sources gave). `failedSources` is what lets a client tell a
    // short or empty list caused by an outage from "nothing is top rated", as
    // the web page does. Additive (guardrail 25).
    return NextResponse.json({
      movies,
      tv,
      totalMovies,
      totalTv,
      totalPages,
      page,
      sortBy: query.sortBy,
      failedSources,
    });
  } catch (err) {
    console.error("[top-rated] Failed:", err);
    return NextResponse.json({ error: t("apiUser.common.fetchFailed") }, { status: 500 });
  }
});
