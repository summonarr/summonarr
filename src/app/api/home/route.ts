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

// The home feed for native clients, mirroring the web home page
// (src/app/(app)/page.tsx): the trending "featured" titles plus the same rails
// the web shows. Keep the rail list, sizes and filtering in sync with that page.
const RAIL_SIZE = 14;
const RAIL_OVERFETCH = 20;

function dedupeUnion(lists: TmdbMedia[][]): TmdbMedia[] {
  const seen = new Set<string>();
  const out: TmdbMedia[] = [];
  for (const list of lists) {
    for (const m of list) {
      const k = `${m.mediaType}-${m.id}`;
      if (seen.has(k)) continue;
      seen.add(k);
      out.push(m);
    }
  }
  return out;
}

function project(
  raw: TmdbMedia[],
  enriched: Map<string, TmdbMedia>,
  hideAvailable: boolean,
  showPlex: boolean,
  showJellyfin: boolean,
  limit: number,
): TmdbMedia[] {
  const out: TmdbMedia[] = [];
  for (const m of raw) {
    const e = enriched.get(`${m.mediaType}-${m.id}`);
    // A missing map entry means attachAllAvailability intentionally filtered the item
    // (the user hid it). Drop it — do NOT fall back to the raw item, which would
    // resurrect the hidden title onto the rail.
    if (!e) continue;
    // Gate hideAvailable on the user's pinned server so a Plex-pinned user doesn't hide
    // Jellyfin-only titles (and vice versa).
    if (hideAvailable && ((showPlex && e.plexAvailable) || (showJellyfin && e.jellyfinAvailable))) continue;
    out.push(e);
    if (out.length >= limit) break;
  }
  return out;
}

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

    // A rail whose source rejected degrades to an omitted rail (better than
    // 500ing the whole feed); settleSources logs each rejection by name. The
    // 4K-visibility read runs alongside, and a failure there still 500s.
    const [lists, show4k] = await Promise.all([
      settleSources("home", {
        trending: getTrending(),
        "popular-movies": getPopularMovies(),
        "popular-tv": getPopularTV(),
        "upcoming-movies": getUpcomingMovies(),
        "on-the-air-tv": getOnTheAirTV(),
        "top-rated-movies": getTopRatedMovies(),
        "top-rated-tv": getTopRatedTV(),
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

    const trending = lists.trending;
    const popMovies = lists["popular-movies"].slice(0, RAIL_OVERFETCH);
    const popTV = lists["popular-tv"].slice(0, RAIL_OVERFETCH);
    const upMovies = lists["upcoming-movies"].slice(0, RAIL_OVERFETCH);
    const upTV = lists["on-the-air-tv"].slice(0, RAIL_OVERFETCH);
    const topMovies = lists["top-rated-movies"].slice(0, RAIL_OVERFETCH);
    const topTV = lists["top-rated-tv"].slice(0, RAIL_OVERFETCH);
    const forYou = lists["for-you"].slice(0, RAIL_OVERFETCH);
    const recent = lists["recently-added"];

    // Enrich the full RAIL_OVERFETCH window (not just RAIL_SIZE): project() drops
    // available/hidden items then backfills toward RAIL_SIZE from the tail, so the
    // tail must be in the enriched map too or rails under-fill when a filter is on.
    // Each list above is already cut to that window.
    const candidateLists = [
      trending,
      popMovies,
      popTV,
      upMovies,
      upTV,
      topMovies,
      topTV,
      forYou,
      // Last, so a title also on a TMDB rail keeps that richer record.
      recent,
    ];
    const displaySet = dedupeUnion(candidateLists);
    const enriched = await attachAllAvailability(displaySet, session.user.id, { show4k });
    const emap = new Map(enriched.map((m) => [`${m.mediaType}-${m.id}`, m]));

    const trendingItems = project(trending, emap, hideAvailable, showPlex, showJellyfin, trending.length);
    const featuredMovie = trendingItems.find((m) => m.mediaType === "movie");
    const featuredTV = trendingItems.find((m) => m.mediaType === "tv");
    const featuredKeys = new Set(
      [featuredMovie, featuredTV]
        .filter((m): m is TmdbMedia => m != null)
        .map((m) => `${m.mediaType}-${m.id}`),
    );
    const trendingRest = trendingItems.filter(
      (m) => !featuredKeys.has(`${m.mediaType}-${m.id}`),
    );

    const carousels = [
      { id: "trending", title: t("home.trending.title"), items: trendingRest },
      // Additive: a carousel id older clients don't know renders generically.
      ...(recentEnabled
        ? [{ id: "recently-added", title: t("home.rail.recent.title"), items: project(recent, emap, hideAvailable, showPlex, showJellyfin, RECENTLY_ADDED_SIZE) }]
        : []),
      ...(flags["feature.page.forYou"]
        ? [{ id: "for-you", title: t("home.rail.forYou.title"), items: project(forYou, emap, hideAvailable, showPlex, showJellyfin, RAIL_SIZE) }]
        : []),
      { id: "popular-movies", title: t("home.rail.popularMovies.title"), items: project(popMovies, emap, hideAvailable, showPlex, showJellyfin, RAIL_SIZE) },
      { id: "popular-tv", title: t("home.rail.popularTv.title"), items: project(popTV, emap, hideAvailable, showPlex, showJellyfin, RAIL_SIZE) },
      { id: "upcoming-movies", title: t("home.rail.upcomingMovies.title"), items: project(upMovies, emap, hideAvailable, showPlex, showJellyfin, RAIL_SIZE) },
      { id: "on-the-air-tv", title: t("home.rail.onTheAir.title"), items: project(upTV, emap, hideAvailable, showPlex, showJellyfin, RAIL_SIZE) },
      { id: "top-rated-movies", title: t("home.rail.topMovies.title"), items: project(topMovies, emap, hideAvailable, showPlex, showJellyfin, RAIL_SIZE) },
      { id: "top-rated-tv", title: t("home.rail.topTv.title"), items: project(topTV, emap, hideAvailable, showPlex, showJellyfin, RAIL_SIZE) },
    ].filter((c) => c.items.length > 0);

    const featured = [featuredMovie, featuredTV].filter((m): m is TmdbMedia => m != null);

    return NextResponse.json({ featured, carousels });
  } catch (err) {
    console.error("[home] Failed:", err);
    return NextResponse.json({ error: t("apiUser.common.fetchFailed") }, { status: 500 });
  }
});
