import { NextResponse } from "next/server";
import { withAuth } from "@/lib/api-auth";
import { attachAllAvailability } from "@/lib/attach-all";
import { getShow4kVisibility } from "@/lib/four-k-visibility";
import { checkRateLimit } from "@/lib/rate-limit";
import { getUserRecommendations } from "@/lib/recommendations";
import { isFeatureEnabled } from "@/lib/features";
import {
  applyRecommendationView,
  parseAvailability,
  parseRecommendationSort,
  parseRecommendationType,
} from "@/lib/recommendation-view";

// Native-client mirror of the /for-you page: the FULL ranked per-user
// recommendation set (the /api/home rail serves only the top slice), enriched
// with availability, narrowed and ordered by the SAME filter/sort helper the
// web page uses (applyRecommendationView) so the two surfaces can never drift.
// Read-only over the precomputed UserRecommendation cache — this route never
// calls TMDB. 404s when the feature.page.forYou flag is off, the same
// enforcement requireFeature applies to the web page (native clients treat a
// 404 as feature-disabled, matching their compat fail-soft posture).
//
// Every item additionally carries `recommendedBecause` (the strongest seed that
// surfaced it) — additive, so an older client that does not decode it is
// unaffected.
export const GET = withAuth(async (request, _ctx, session) => {
  if (!checkRateLimit(`recommendations:${session.user.id}`, 30, 60_000)) {
    return NextResponse.json({ error: "Too many requests" }, { status: 429 });
  }

  if (!(await isFeatureEnabled("feature.page.forYou"))) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }

  const params = request.nextUrl.searchParams;
  const availability = parseAvailability(params.get("filter"));
  const type = parseRecommendationType(params.get("type"));
  const sort = parseRecommendationSort(params.get("sort"));

  try {
    const [recommendations, show4k] = await Promise.all([
      getUserRecommendations(session.user.id),
      getShow4kVisibility(session),
    ]);

    // Enrich the whole ranked set (rank order is preserved through the attach
    // chokepoint; hidden titles drop; availability is per-user
    // visibility-scoped) — the view below reads post-enrichment fields.
    const enriched = await attachAllAvailability(recommendations, session.user.id, { show4k });
    const items = applyRecommendationView(enriched, { availability, type, sort });

    // `total` is the filtered count (what the caller received), `available` the
    // unfiltered size — a client showing "12 of 200" needs both.
    return NextResponse.json({ items, total: items.length, available: enriched.length });
  } catch (err) {
    console.error("[recommendations] Failed:", err);
    return NextResponse.json({ error: "Failed to fetch" }, { status: 500 });
  }
});
