import { NextResponse } from "next/server";
import { withAuth } from "@/lib/api-auth";
import { getBadgeVisibility } from "@/lib/badge-visibility";
import {
  getTrending,
  getPopularMovies,
  getPopularTV,
  getUpcomingMovies,
  getOnTheAirTV,
  getTopRatedMovies,
  getTopRatedTV,
  type TmdbMedia,
} from "@/lib/tmdb";
import { attachAllAvailability } from "@/lib/attach-all";
import { getShow4kVisibility } from "@/lib/four-k-visibility";
import { checkRateLimit } from "@/lib/rate-limit";
import { getUserRecommendations } from "@/lib/recommendations";
import { getFeatureFlags } from "@/lib/features";
import { getRecentlyAddedForViewer, RECENTLY_ADDED_SIZE } from "@/lib/recently-added";
import { translatorForRequest } from "@/lib/i18n/server-locale";
import { settleSources } from "@/lib/settle-sources";
import { dedupeUnion, mediaKey, projectRail, splitFeatured, type RailVisibility } from "@/lib/home-rails";

// The home feed for native clients, mirroring the web home page
// (src/app/(app)/page.tsx): the trending "featured" titles plus the same rails
// the web shows. Keep the rail list, sizes and filtering in sync with that page.
const RAIL_SIZE = 14;
const RAIL_OVERFETCH = 20;

export const GET = withAuth(async (request, _ctx, session) => {
  const t = translatorForRequest(request);
  if (!checkRateLimit(`home:${session.user.id}`, 30, 60_000)) {
    return NextResponse.json({ error: t("apiUser.common.tooManyRequests") }, { status: 429 });
  }

  const hideAvailable = request.nextUrl.searchParams.get("hideAvailable") === "1";
  try {
    const flags = await getFeatureFlags();
    // Which servers (Plex / Jellyfin) this user is shown, for the hideAvailable
    // filter — with the integration flags, which default to TRUE when omitted.
    const { showPlex, showJellyfin } = getBadgeVisibility(session, {
      plex: flags["feature.integration.plex"],
      jellyfin: flags["feature.integration.jellyfin"],
    });
    const recentEnabled = flags["feature.page.recentlyAdded"] && !hideAvailable;
    // The web home page gates these rails on their pages' flags; a page an
    // admin switched off must not keep its rails in the native feed.
    const upcomingEnabled = flags["feature.page.upcoming"];
    const topEnabled = flags["feature.page.top"];
    const none = () => Promise.resolve([] as TmdbMedia[]);

    // A rail whose source rejected degrades to an omitted rail (better than
    // 500ing the whole feed); settleSources logs each rejection by name. The
    // 4K-visibility read runs alongside, and a failure there still 500s.
    const [lists, show4k] = await Promise.all([
      settleSources("home", {
        trending: getTrending(),
        "popular-movies": getPopularMovies(),
        "popular-tv": getPopularTV(),
        "upcoming-movies": upcomingEnabled ? getUpcomingMovies() : none(),
        "on-the-air-tv": upcomingEnabled ? getOnTheAirTV() : none(),
        "top-rated-movies": topEnabled ? getTopRatedMovies() : none(),
        "top-rated-tv": topEnabled ? getTopRatedTV() : none(),
        // The For You rail is gated at emit time below, so don't pay the
        // recommendation read (~8 queries) plus the enrichment of its 20 extra
        // titles for a rail the default (flag-off) configuration then discards.
        "for-you": flags["feature.page.forYou"]
          ? getUserRecommendations(session.user.id)
          : Promise.resolve([] as TmdbMedia[]),
        // Library reads scoped to the servers this viewer may see (guardrail 35),
        // cached per visible-server set. Every title on it is on the viewer's own
        // server, so hideAvailable would always empty it — skip the read then.
        "recently-added": recentEnabled
          ? getRecentlyAddedForViewer(session, {
              plex: flags["feature.integration.plex"],
              jellyfin: flags["feature.integration.jellyfin"],
            })
          : Promise.resolve([] as TmdbMedia[]),
      }),
      getShow4kVisibility(session),
    ]);

    // The TMDB rails, each cut to the RAIL_OVERFETCH window: projectRail drops
    // available/hidden titles and backfills toward RAIL_SIZE from the tail, so
    // the whole window is enriched below or rails under-fill when a filter is on.
    const overfetch = (list: TmdbMedia[]) => list.slice(0, RAIL_OVERFETCH);
    const trending = lists.trending;
    const forYou = overfetch(lists["for-you"]);
    const recent = lists["recently-added"];
    const tmdbRails = [
      { id: "popular-movies", titleKey: "home.rail.popularMovies.title", raw: overfetch(lists["popular-movies"]) },
      { id: "popular-tv", titleKey: "home.rail.popularTv.title", raw: overfetch(lists["popular-tv"]) },
      { id: "upcoming-movies", titleKey: "home.rail.upcomingMovies.title", raw: overfetch(lists["upcoming-movies"]) },
      { id: "on-the-air-tv", titleKey: "home.rail.onTheAir.title", raw: overfetch(lists["on-the-air-tv"]) },
      { id: "top-rated-movies", titleKey: "home.rail.topMovies.title", raw: overfetch(lists["top-rated-movies"]) },
      { id: "top-rated-tv", titleKey: "home.rail.topTv.title", raw: overfetch(lists["top-rated-tv"]) },
    ];

    const displaySet = dedupeUnion([
      trending,
      ...tmdbRails.map((r) => r.raw),
      forYou,
      // Last, so a title also on a TMDB rail keeps that richer record.
      recent,
    ]);
    const enriched = await attachAllAvailability(displaySet, session.user.id, { show4k });
    const emap = new Map(enriched.map((m) => [mediaKey(m), m]));
    const vis: RailVisibility = { hideAvailable, showPlex, showJellyfin };
    const pick = (raw: TmdbMedia[], limit = RAIL_SIZE) => projectRail(raw, emap, vis, limit);

    const { featured, rest: trendingRest } = splitFeatured(pick(trending, trending.length));

    const carousels = [
      { id: "trending", title: t("home.trending.title"), items: trendingRest },
      // Additive: a carousel id older clients don't know renders generically.
      ...(recentEnabled
        ? [{ id: "recently-added", title: t("home.rail.recent.title"), items: pick(recent, RECENTLY_ADDED_SIZE) }]
        : []),
      ...(flags["feature.page.forYou"]
        ? [{ id: "for-you", title: t("home.rail.forYou.title"), items: pick(forYou) }]
        : []),
      ...tmdbRails.map((r) => ({ id: r.id, title: t(r.titleKey), items: pick(r.raw) })),
    ].filter((c) => c.items.length > 0);

    return NextResponse.json({ featured, carousels });
  } catch (err) {
    console.error("[home] Failed:", err);
    return NextResponse.json({ error: t("apiUser.common.fetchFailed") }, { status: 500 });
  }
});
