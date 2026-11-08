export const dynamic = "force-dynamic";

import type { Metadata } from "next";
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
import { DiscoverRow } from "@/components/media/discover-row";
import { DiscoverHero } from "@/components/media/discover-hero";
import { attachAllAvailability } from "@/lib/attach-all";
import { Suspense } from "react";
import { HideAvailableToggle } from "@/components/media/hide-available-toggle";
import { requireAppSession } from "@/lib/require-app-session";
import { getFeatureFlags } from "@/lib/features";
import { getUserRecommendations } from "@/lib/recommendations";
import { getRecentlyAddedForViewer, RECENTLY_ADDED_SIZE } from "@/lib/recently-added";
import { getBadgeVisibility } from "@/lib/badge-visibility";
import { getShow4kVisibility } from "@/lib/four-k-visibility";
import { LiveRefresh } from "@/components/live-refresh";
import { PageHeader, EmptyState } from "@/components/ui/design";
import { AlertTriangle } from "@/components/icons";
import { getTranslator } from "@/lib/i18n/server";
import type { Translator } from "@/lib/i18n/translate";
import { canRequest } from "@/lib/permissions";
import { settleSources } from "@/lib/settle-sources";
import { first, type PageSearchParams } from "@/lib/search-params";
import { dedupeUnion, emptiedByHideAvailable, mediaKey, projectRail, splitFeatured, type RailVisibility } from "@/lib/home-rails";

const RAIL_SIZE = 14;
const RAIL_OVERFETCH = 20;

type HomeRail = { title: string; subtitle: string; href?: string; raw: TmdbMedia[]; items: TmdbMedia[] };

// The rails under the trending row, in display order, each gated on its page's
// feature flag. `project` turns a raw list into its enriched, filtered rail.
function homeRails({
  t, recentEnabled, forYouEnabled, upcomingEnabled, topEnabled, lists, project,
}: {
  t: Translator;
  recentEnabled: boolean;
  forYouEnabled: boolean;
  upcomingEnabled: boolean;
  topEnabled: boolean;
  lists: Record<"recent" | "forYou" | "popMovies" | "popTV" | "upMovies" | "upTV" | "topMovies" | "topTV", TmdbMedia[]>;
  project: (raw: TmdbMedia[], limit: number) => TmdbMedia[];
}): HomeRail[] {
  const rail = (title: string, subtitle: string, raw: TmdbMedia[], href?: string, limit = RAIL_SIZE): HomeRail => ({
    title,
    subtitle,
    ...(href ? { href } : {}),
    raw,
    items: project(raw, limit),
  });
  return [
    // No "See all": the only full list (/admin/activity/recent) is admin-only.
    ...(recentEnabled
      ? [rail(t("home.rail.recent.title"), t("home.rail.recent.subtitle"), lists.recent, undefined, RECENTLY_ADDED_SIZE)]
      : []),
    ...(forYouEnabled ? [rail(t("home.rail.forYou.title"), t("home.rail.forYou.subtitle"), lists.forYou, "/for-you")] : []),
    rail(t("home.rail.popularMovies.title"), t("home.rail.popularMovies.subtitle"), lists.popMovies, "/movies"),
    rail(t("home.rail.popularTv.title"), t("home.rail.popularTv.subtitle"), lists.popTV, "/tv"),
    ...(upcomingEnabled
      ? [
          rail(t("home.rail.upcomingMovies.title"), t("home.rail.upcomingMovies.subtitle"), lists.upMovies, "/upcoming"),
          rail(t("home.rail.onTheAir.title"), t("home.rail.onTheAir.subtitle"), lists.upTV, "/upcoming"),
        ]
      : []),
    ...(topEnabled
      ? [
          rail(t("home.rail.topMovies.title"), t("home.rail.topMovies.subtitle"), lists.topMovies, "/top"),
          rail(t("home.rail.topTv.title"), t("home.rail.topTv.subtitle"), lists.topTV, "/top"),
        ]
      : []),
  ];
}

// Tab / bookmark / history title — the page title, in the viewer's language.
export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslator();
  return { title: t("home.title") };
}

export default async function DiscoverPage({
  searchParams,
}: {
  searchParams: Promise<PageSearchParams>;
}) {
  const [sp, session, flags, t] = await Promise.all([searchParams, requireAppSession(), getFeatureFlags(), getTranslator()]);
  const hideAvailable = first(sp.hideAvailable) === "1";
  // Integration flags passed explicitly: they default to TRUE when omitted, which
  // left a disabled integration's leftover library rows driving these rails while
  // the /movies and /tv pages they link to (browse-query.ts) ignored them.
  const { showPlex, showJellyfin } = getBadgeVisibility(session, {
    plex: flags["feature.integration.plex"],
    jellyfin: flags["feature.integration.jellyfin"],
  });
  // The viewer's own server visibility: a Plex-pinned viewer must not have
  // Jellyfin-only titles dropped from their rails — every paginated surface
  // (/api/top-rated, /api/upcoming, browse-query) gates the same way.
  const vis: RailVisibility = { hideAvailable, showPlex, showJellyfin };
  const canRequestMovie = canRequest(session.user.permissions, "MOVIE", false);
  const canRequestTv = canRequest(session.user.permissions, "TV", false);
  const upcomingEnabled = flags["feature.page.upcoming"];
  const topEnabled = flags["feature.page.top"];
  const forYouEnabled = flags["feature.page.forYou"];
  // Every title on this rail is on the viewer's own server by construction, so
  // with Hide Available on it could only ever read "all available" — skip it.
  const recentEnabled = flags["feature.page.recentlyAdded"] && !hideAvailable;

  // Start the 4K-visibility read concurrently with the TMDB fan-out; awaited
  // just before attachAllAvailability consumes it. The no-op catch only marks
  // the promise handled if something throws first — the await below still
  // rethrows a getShow4kVisibility failure.
  const show4kPromise = getShow4kVisibility(session);
  show4kPromise.catch(() => {});

  // A rail whose source rejected degrades to an empty rail; settleSources logs
  // each rejection by name, as src/app/api/home/route.ts does.
  const lists = await settleSources("home", {
    trending: getTrending(),
    "popular-movies": getPopularMovies(),
    "popular-tv": getPopularTV(),
    "upcoming-movies": getUpcomingMovies(),
    "on-the-air-tv": getOnTheAirTV(),
    "top-rated-movies": getTopRatedMovies(),
    "top-rated-tv": getTopRatedTV(),
    // The For You rail is gated at emit time below, so don't pay the
    // recommendation read plus the enrichment of its 20 extra titles for a
    // rail the default (flag-off) configuration then discards. Mirrors
    // src/app/api/home/route.ts — keep the two in sync.
    "for-you": forYouEnabled
      ? getUserRecommendations(session.user.id)
      : Promise.resolve([] as TmdbMedia[]),
    // Library reads scoped to the servers this viewer may see (guardrail 35),
    // cached per visible-server set — never a TMDB call. Mirrors
    // src/app/api/home/route.ts — keep the two in sync.
    "recently-added": recentEnabled
      ? getRecentlyAddedForViewer(session, {
          plex: flags["feature.integration.plex"],
          jellyfin: flags["feature.integration.jellyfin"],
        })
      : Promise.resolve([] as TmdbMedia[]),
  });

  // Enrich the full RAIL_OVERFETCH window (not just RAIL_SIZE): projectRail()
  // drops available/hidden items then backfills toward RAIL_SIZE from the tail,
  // so the tail must be in the enriched map too or rails under-fill when a
  // filter is on. Trending and recently-added are kept whole (the latter is
  // already capped at its own overfetch).
  const trending  = lists.trending;
  const popMovies = lists["popular-movies"].slice(0, RAIL_OVERFETCH);
  const popTV     = lists["popular-tv"].slice(0, RAIL_OVERFETCH);
  const upMovies  = lists["upcoming-movies"].slice(0, RAIL_OVERFETCH);
  const upTV      = lists["on-the-air-tv"].slice(0, RAIL_OVERFETCH);
  const topMovies = lists["top-rated-movies"].slice(0, RAIL_OVERFETCH);
  const topTV     = lists["top-rated-tv"].slice(0, RAIL_OVERFETCH);
  const forYou    = lists["for-you"].slice(0, RAIL_OVERFETCH);
  const recent    = lists["recently-added"];

  // Recently added last, so a title also on a TMDB rail keeps that richer
  // record (overview, backdrop) in the shared enriched map.
  const displaySet = dedupeUnion([trending, popMovies, popTV, upMovies, upTV, topMovies, topTV, forYou, recent]);
  const show4k = await show4kPromise;
  const enriched = await attachAllAvailability(displaySet, session.user.id, { show4k });
  const emap = new Map(enriched.map((m) => [mediaKey(m), m]));
  const project = (raw: TmdbMedia[], limit: number) => projectRail(raw, emap, vis, limit);

  const { featured, rest: trendingRest } = splitFeatured(project(trending, trending.length));
  const featuredMovie = featured.find((m) => m.mediaType === "movie");
  const featuredTV = featured.find((m) => m.mediaType === "tv");
  const featuredKeys = new Set(featured.map(mediaKey));
  const railsBase = homeRails({
    t, recentEnabled, forYouEnabled, upcomingEnabled, topEnabled,
    lists: { recent, forYou, popMovies, popTV, upMovies, upTV, topMovies, topTV },
    project,
  });
  const rails = railsBase.map((r) => ({
    ...r,
    allAvailable: r.items.length === 0 && emptiedByHideAvailable(r.raw, emap, vis),
  }));
  // Judged over the titles the ROW could show: the two heroes take the only
  // unavailable titles in an otherwise all-available week, and counting them
  // made the row vanish instead of saying everything else is on the server.
  const trendingAllAvailable =
    trendingRest.length === 0 &&
    emptiedByHideAvailable(
      trending.filter((m) => !featuredKeys.has(mediaKey(m))),
      emap,
      vis,
    );

  return (
    <div className="ds-page-enter">
      <LiveRefresh on={["request:new", "request:updated", "request:deleted"]} />

      <PageHeader
        title={t("home.title")}
        subtitle={t("home.subtitle")}
        right={
          <Suspense>
            <HideAvailableToggle active={hideAvailable} />
          </Suspense>
        }
      />

      {/* Gated on the RAW trending list, not the projected one: with Hide
          Available on, an all-available week projects to nothing and must read
          as that (the row below says so), not as a missing token. getTrending
          swallows an outage into [] as well, so the two are one message here. */}
      {trending.length === 0 ? (
        <div style={{ marginBottom: 36 }}>
          <EmptyState
            icon={AlertTriangle}
            title={t("home.trendingUnavailable.title")}
            description={t("home.trendingUnavailable.description")}
          />
        </div>
      ) : (
        <>
          {(featuredMovie || featuredTV) && (
            <div className="ds-discover-hero-pair">
              {featuredMovie && (
                <DiscoverHero
                  media={featuredMovie}
                  label={t("home.hero.trendingMovie")}
                  showPlex={showPlex}
                  showJellyfin={showJellyfin}
                />
              )}
              {featuredTV && (
                <DiscoverHero
                  media={featuredTV}
                  label={t("home.hero.trendingTv")}
                  showPlex={showPlex}
                  showJellyfin={showJellyfin}
                />
              )}
            </div>
          )}
          <DiscoverRow
            title={t("home.trending.title")}
            subtitle={t("home.trending.results", { count: trendingRest.length })}
            items={trendingRest}
            showPlex={showPlex}
            showJellyfin={showJellyfin}
            allAvailable={trendingAllAvailable}
            canRequestMovie={canRequestMovie}
            canRequestTv={canRequestTv}
          />
        </>
      )}

      {rails.map((rail) => (
        <DiscoverRow
          key={rail.title}
          title={rail.title}
          subtitle={rail.subtitle}
          seeAllHref={rail.href}
          items={rail.items}
          showPlex={showPlex}
          showJellyfin={showJellyfin}
          allAvailable={rail.allAvailable}
          canRequestMovie={canRequestMovie}
          canRequestTv={canRequestTv}
        />
      ))}
    </div>
  );
}
