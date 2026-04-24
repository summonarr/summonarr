export const dynamic = "force-dynamic";

import {
  getTrending,
  getPopularMovies,
  getPopularTV,
  getUpcomingMovies,
  getUpcomingTV,
  getTopRatedMovies,
  getTopRatedTV,
  type TmdbMedia,
} from "@/lib/tmdb";
import { MediaCard } from "@/components/media/media-card";
import { DiscoverRow } from "@/components/media/discover-row";
import { attachAllAvailability } from "@/lib/attach-all";
import { Suspense } from "react";
import { HideAvailableToggle } from "@/components/media/hide-available-toggle";
import { auth } from "@/lib/auth";
import { getBadgeVisibility } from "@/lib/badge-visibility";
import { LiveRefresh } from "@/components/live-refresh";
import { PageHeader } from "@/components/ui/design";

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
  limit: number,
): TmdbMedia[] {
  const out: TmdbMedia[] = [];
  for (const m of raw) {
    const e = enriched.get(`${m.mediaType}-${m.id}`) ?? m;
    if (hideAvailable && (e.plexAvailable || e.jellyfinAvailable)) continue;
    out.push(e);
    if (out.length >= limit) break;
  }
  return out;
}

function settled<T>(r: PromiseSettledResult<T[]>): T[] {
  return r.status === "fulfilled" ? r.value : [];
}

export default async function DiscoverPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string>>;
}) {
  const [sp, session] = await Promise.all([searchParams, auth()]);
  const hideAvailable = sp.hideAvailable === "1";
  const { showPlex, showJellyfin } = getBadgeVisibility(session);

  const [
    trendingRes,
    popMoviesRes,
    popTVRes,
    upMoviesRes,
    upTVRes,
    topMoviesRes,
    topTVRes,
  ] = await Promise.allSettled([
    getTrending(),
    getPopularMovies(),
    getPopularTV(),
    getUpcomingMovies(),
    getUpcomingTV(),
    getTopRatedMovies(),
    getTopRatedTV(),
  ]);

  const trending  = settled(trendingRes);
  const popMovies = settled(popMoviesRes).slice(0, RAIL_OVERFETCH);
  const popTV     = settled(popTVRes).slice(0, RAIL_OVERFETCH);
  const upMovies  = settled(upMoviesRes).slice(0, RAIL_OVERFETCH);
  const upTV      = settled(upTVRes).slice(0, RAIL_OVERFETCH);
  const topMovies = settled(topMoviesRes).slice(0, RAIL_OVERFETCH);
  const topTV     = settled(topTVRes).slice(0, RAIL_OVERFETCH);

  const candidateLists = [
    { raw: trending, limit: trending.length },
    { raw: popMovies, limit: RAIL_SIZE },
    { raw: popTV, limit: RAIL_SIZE },
    { raw: upMovies, limit: RAIL_SIZE },
    { raw: upTV, limit: RAIL_SIZE },
    { raw: topMovies, limit: RAIL_SIZE },
    { raw: topTV, limit: RAIL_SIZE },
  ];
  const displaySet = dedupeUnion(candidateLists.map((c) => c.raw.slice(0, c.limit)));
  const enriched = await attachAllAvailability(displaySet, session?.user.id);
  const emap = new Map(enriched.map((m) => [`${m.mediaType}-${m.id}`, m]));

  const trendingItems = project(trending,  emap, hideAvailable, trending.length);
  const rails: { title: string; subtitle: string; href: string; items: TmdbMedia[] }[] = [
    { title: "Popular Movies",   subtitle: "Most popular on TMDB",                  href: "/movies",   items: project(popMovies, emap, hideAvailable, RAIL_SIZE) },
    { title: "Popular TV",       subtitle: "Most popular TV shows",                 href: "/tv",       items: project(popTV,     emap, hideAvailable, RAIL_SIZE) },
    { title: "Upcoming Movies",  subtitle: "Hitting theaters soon",                 href: "/upcoming", items: project(upMovies,  emap, hideAvailable, RAIL_SIZE) },
    { title: "On The Air TV",    subtitle: "New episodes this week",                href: "/upcoming", items: project(upTV,      emap, hideAvailable, RAIL_SIZE) },
    { title: "Top Rated Movies", subtitle: "Highest-rated films of all time",       href: "/top",      items: project(topMovies, emap, hideAvailable, RAIL_SIZE) },
    { title: "Top Rated TV",     subtitle: "Highest-rated shows of all time",       href: "/top",      items: project(topTV,     emap, hideAvailable, RAIL_SIZE) },
  ];

  return (
    <div className="ds-page-enter">
      <LiveRefresh on={["request:new", "request:updated", "request:deleted"]} />

      <PageHeader
        title="Discover"
        subtitle="Trending this week"
        right={
          <Suspense>
            <HideAvailableToggle active={hideAvailable} />
          </Suspense>
        }
      />

      {trendingItems.length === 0 ? (
        <div
          className="ds-mono"
          style={{ color: "var(--ds-fg-subtle)", fontSize: 12, marginBottom: 40 }}
        >
          No results — set TMDB_READ_TOKEN (or TMDB_API_KEY) in .env.local to see trending content.
        </div>
      ) : (
        <section style={{ marginBottom: 40 }}>
          <div className="ds-media-grid">
            {trendingItems.map((media) => (
              <MediaCard
                key={`${media.mediaType}-${media.id}`}
                media={media}
                showPlex={showPlex}
                showJellyfin={showJellyfin}
                size="md"
              />
            ))}
          </div>
        </section>
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
        />
      ))}
    </div>
  );
}
