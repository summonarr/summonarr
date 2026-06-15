import { NextResponse } from "next/server";
import { withAuth } from "@/lib/api-auth";
import { getMostPopularOnServer, POPULAR_PER_PAGE, type PopularSort } from "@/lib/play-history";
import { getMovieDetails, getTVDetails } from "@/lib/tmdb";
import type { TmdbMedia } from "@/lib/tmdb-types";
import { prisma } from "@/lib/prisma";
import { attachAllAvailability } from "@/lib/attach-all";
import { getShow4kVisibility } from "@/lib/four-k-visibility";

// Native-client mirror of src/app/(app)/popular/page.tsx — most-played media on
// the connected Plex/Jellyfin servers. Keep the resolve + enrich logic in sync
// with that page (it is the same getMostPopularOnServer aggregation).
type EnrichedMedia = TmdbMedia & {
  plays: number;
  allTimePlays: number;
  viewers: number;
  episodes: number;
  totalHours: number;
};

export const GET = withAuth(async (request, _ctx, session) => {
  const sp = request.nextUrl.searchParams;
  const mediaTypeFilter = sp.get("mediaType") || undefined; // "movies" | "tv" | undefined
  const validSorts = new Set<PopularSort>(["plays", "viewers", "trending"]);
  const sortParam = sp.get("sort");
  const sort: PopularSort = validSorts.has(sortParam as PopularSort)
    ? (sortParam as PopularSort)
    : "trending";
  const page = Math.max(1, parseInt(sp.get("page") ?? "1", 10) || 1);
  const show4k = await getShow4kVisibility(session);

  try {
    const [moviesResult, tvResult] = await Promise.all([
      mediaTypeFilter === "tv"
        ? Promise.resolve({ items: [], totalItems: 0, totalPages: 1, page: 1 })
        : getMostPopularOnServer({ mediaType: "MOVIE", sort, page }),
      mediaTypeFilter === "movies"
        ? Promise.resolve({ items: [], totalItems: 0, totalPages: 1, page: 1 })
        : getMostPopularOnServer({ mediaType: "TV", sort, page }),
    ]);

    async function resolveMedia(
      items: typeof moviesResult.items,
      type: "movie" | "tv",
    ): Promise<EnrichedMedia[]> {
      if (items.length === 0) return [];
      const dbType = type === "movie" ? "MOVIE" : "TV";

      const coreRows = await prisma.tmdbMediaCore.findMany({
        where: {
          OR: items.map((i) => ({ tmdbId: i.tmdbId, mediaType: dbType, expiresAt: { gt: new Date() } })),
        },
      });
      const coreMap = new Map(coreRows.map((r) => [r.tmdbId, r]));

      const results = await Promise.allSettled(
        items.map(async (item) => {
          const core = coreMap.get(item.tmdbId);
          const details: TmdbMedia = core
            ? {
                id: item.tmdbId,
                mediaType: type,
                title: core.title,
                overview: "",
                posterPath: core.posterPath ?? null,
                backdropPath: null,
                releaseDate: null,
                releaseYear: core.releaseYear ?? "",
                voteAverage: core.voteAverage,
                certification: core.certification ?? undefined,
              }
            : type === "movie"
              ? await getMovieDetails(item.tmdbId)
              : await getTVDetails(item.tmdbId);
          return {
            ...details,
            plays: item.plays,
            allTimePlays: item.allTimePlays,
            viewers: item.viewers,
            episodes: item.episodes,
            totalHours: item.totalHours,
          };
        }),
      );
      return results
        .filter((r): r is PromiseFulfilledResult<EnrichedMedia> => r.status === "fulfilled")
        .map((r) => r.value);
    }

    let [movies, tv] = await Promise.all([
      resolveMedia(moviesResult.items, "movie"),
      resolveMedia(tvResult.items, "tv"),
    ]);

    const enrich = async (items: EnrichedMedia[]): Promise<EnrichedMedia[]> =>
      (await attachAllAvailability(items, session.user.id, { show4k })) as EnrichedMedia[];

    [movies, tv] = await Promise.all([enrich(movies), enrich(tv)]);

    return NextResponse.json({
      movies,
      tv,
      totalMovies: moviesResult.totalItems,
      totalTv: tvResult.totalItems,
      totalPages: Math.max(moviesResult.totalPages, tvResult.totalPages),
      page,
      sort,
      rankOffset: (page - 1) * POPULAR_PER_PAGE,
    });
  } catch (err) {
    console.error("[popular] Failed:", err);
    return NextResponse.json({ error: "Failed to fetch" }, { status: 500 });
  }
});
