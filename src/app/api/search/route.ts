import { NextResponse } from "next/server";
import { withAuth } from "@/lib/api-auth";
import { searchMulti } from "@/lib/tmdb";
import { attachAllAvailability } from "@/lib/attach-all";
import { getShow4kVisibility } from "@/lib/four-k-visibility";
import { maintenanceGuard } from "@/lib/maintenance";
import { checkRateLimit } from "@/lib/rate-limit";
import { translatorForRequest } from "@/lib/i18n/server-locale";

export const GET = withAuth(async (req, _ctx, session) => {
  const t = translatorForRequest(req);
  const maint = await maintenanceGuard(session);
  if (maint) return maint;

  if (!checkRateLimit(`search:${session.user.id}`, 30, 60 * 1000)) {
    return NextResponse.json({ error: t("apiUser.search.rateLimited") }, { status: 429 });
  }

  const query = req.nextUrl.searchParams.get("q") ?? "";
  const type = req.nextUrl.searchParams.get("type");
  if (!query.trim()) return NextResponse.json([]);
  if (query.length > 200) return NextResponse.json({ error: t("apiUser.search.queryTooLong") }, { status: 400 });

  try {
    const allResults = await searchMulti(query);
    const results = type === "movie" || type === "tv"
      ? allResults.filter((r) => r.mediaType === type)
      : allResults;

    // Attach the SAME availability/request/Arr state the browse + discover surfaces
    // do, so clients that render search results as request-able cards (the iOS app)
    // don't show a "Request" CTA for a title that's already requested/available.
    // skipRatings avoids an OMDB/MDBList fan-out on every (debounced) keystroke.
    const show4k = await getShow4kVisibility(session);
    const enriched = await attachAllAvailability(results, session.user.id, { skipRatings: true, show4k });

    return NextResponse.json(enriched);
  } catch (err) {
    console.error("[search] TMDB search error:", err);
    return NextResponse.json({ error: t("apiUser.search.failed") }, { status: 500 });
  }
});
