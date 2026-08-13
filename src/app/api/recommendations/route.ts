import { NextResponse } from "next/server";
import { withAuth } from "@/lib/api-auth";
import { attachAllAvailability } from "@/lib/attach-all";
import { getShow4kVisibility } from "@/lib/four-k-visibility";
import { checkRateLimit } from "@/lib/rate-limit";
import { getUserRecommendations } from "@/lib/recommendations";
import { isFeatureEnabled } from "@/lib/features";

// Native-client mirror of the /for-you page: the FULL ranked per-user
// recommendation set (the /api/home rail serves only the top slice), enriched
// with availability, with the same server-side availability filter the web
// page offers. Read-only over the precomputed UserRecommendation cache — this
// route never calls TMDB. 404s when the feature.page.forYou flag is off, the
// same enforcement requireFeature applies to the web page (native clients
// treat a 404 as feature-disabled, matching their compat fail-soft posture).
export const GET = withAuth(async (request, _ctx, session) => {
  if (!checkRateLimit(`recommendations:${session.user.id}`, 30, 60_000)) {
    return NextResponse.json({ error: "Too many requests" }, { status: 429 });
  }

  if (!(await isFeatureEnabled("feature.page.forYou"))) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }

  const filterRaw = request.nextUrl.searchParams.get("filter");
  const filter = filterRaw === "available" || filterRaw === "missing" ? filterRaw : undefined;

  try {
    const [recommendations, show4k] = await Promise.all([
      getUserRecommendations(session.user.id),
      getShow4kVisibility(session),
    ]);

    // Enrich the whole ranked set (rank order is preserved through the attach
    // chokepoint; hidden titles drop; availability is per-user
    // visibility-scoped) — the filter below reads post-enrichment fields.
    const enriched = await attachAllAvailability(recommendations, session.user.id, { show4k });

    const items =
      filter === "available"
        ? enriched.filter((m) => m.plexAvailable || m.jellyfinAvailable)
        : filter === "missing"
          ? enriched.filter((m) => !(m.plexAvailable || m.jellyfinAvailable))
          : enriched;

    return NextResponse.json({ items, total: items.length });
  } catch (err) {
    console.error("[recommendations] Failed:", err);
    return NextResponse.json({ error: "Failed to fetch" }, { status: 500 });
  }
});
