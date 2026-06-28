import { NextResponse } from "next/server";
import { withAuth } from "@/lib/api-auth";
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

// Native-client mirror of the curated Discover home — src/app/(app)/page.tsx.
// Returns the same trending heroes + 6 rails the web renders. Keep the rail
// set, sizes, and dedupe/projection logic in sync with that page.
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

export const GET = withAuth(async (request, _ctx, session) => {
  if (!checkRateLimit(`home:${session.user.id}`, 30, 60_000)) {
    return NextResponse.json({ error: "Too many requests" }, { status: 429 });
  }

  const hideAvailable = request.nextUrl.searchParams.get("hideAvailable") === "1";

  try {
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
      getOnTheAirTV(),
      getTopRatedMovies(),
      getTopRatedTV(),
    ]);

    // A rail whose source rejected degrades to an omitted rail (better than
    // 500ing the whole feed). Log each rejection so the missing rail is
    // diagnosable rather than silently absent.
    const sourceNames = [
      "trending", "popular-movies", "popular-tv",
      "upcoming-movies", "on-the-air-tv", "top-rated-movies", "top-rated-tv",
    ];
    [trendingRes, popMoviesRes, popTVRes, upMoviesRes, upTVRes, topMoviesRes, topTVRes]
      .forEach((r, i) => {
        if (r.status === "rejected") {
          console.error(`[home] source ${sourceNames[i]} failed:`, r.reason instanceof Error ? r.reason.message : r.reason);
        }
      });

    const trending = settled(trendingRes);
    const popMovies = settled(popMoviesRes).slice(0, RAIL_OVERFETCH);
    const popTV = settled(popTVRes).slice(0, RAIL_OVERFETCH);
    const upMovies = settled(upMoviesRes).slice(0, RAIL_OVERFETCH);
    const upTV = settled(upTVRes).slice(0, RAIL_OVERFETCH);
    const topMovies = settled(topMoviesRes).slice(0, RAIL_OVERFETCH);
    const topTV = settled(topTVRes).slice(0, RAIL_OVERFETCH);

    const candidateLists = [
      trending,
      popMovies.slice(0, RAIL_SIZE),
      popTV.slice(0, RAIL_SIZE),
      upMovies.slice(0, RAIL_SIZE),
      upTV.slice(0, RAIL_SIZE),
      topMovies.slice(0, RAIL_SIZE),
      topTV.slice(0, RAIL_SIZE),
    ];
    const displaySet = dedupeUnion(candidateLists);
    const show4k = await getShow4kVisibility(session);
    const enriched = await attachAllAvailability(displaySet, session.user.id, { show4k });
    const emap = new Map(enriched.map((m) => [`${m.mediaType}-${m.id}`, m]));

    const trendingItems = project(trending, emap, hideAvailable, trending.length);
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
      { id: "trending", title: "Trending this week", items: trendingRest },
      { id: "popular-movies", title: "Popular Movies", items: project(popMovies, emap, hideAvailable, RAIL_SIZE) },
      { id: "popular-tv", title: "Popular TV", items: project(popTV, emap, hideAvailable, RAIL_SIZE) },
      { id: "upcoming-movies", title: "Upcoming Movies", items: project(upMovies, emap, hideAvailable, RAIL_SIZE) },
      { id: "on-the-air-tv", title: "On The Air TV", items: project(upTV, emap, hideAvailable, RAIL_SIZE) },
      { id: "top-rated-movies", title: "Top Rated Movies", items: project(topMovies, emap, hideAvailable, RAIL_SIZE) },
      { id: "top-rated-tv", title: "Top Rated TV", items: project(topTV, emap, hideAvailable, RAIL_SIZE) },
    ].filter((c) => c.items.length > 0);

    const featured = [featuredMovie, featuredTV].filter((m): m is TmdbMedia => m != null);

    return NextResponse.json({ featured, carousels });
  } catch (err) {
    console.error("[home] Failed:", err);
    return NextResponse.json({ error: "Failed to fetch" }, { status: 500 });
  }
});
