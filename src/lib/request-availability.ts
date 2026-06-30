import { prisma } from "@/lib/prisma";
import type { Prisma } from "@/generated/prisma";
import type { TmdbMedia } from "@/lib/tmdb-types";

// Build a `tmdbId IN […]` clause per mediaType — replaces the prior wide `OR: items.map(...)`
// pattern which the planner couldn't serve from the composite (tmdbId, mediaType) index.
function buildMediaTypeWhere(items: TmdbMedia[]): Prisma.MediaRequestWhereInput | null {
  const movieIds = items.filter((i) => i.mediaType === "movie").map((i) => i.id);
  const tvIds = items.filter((i) => i.mediaType === "tv").map((i) => i.id);
  if (movieIds.length === 0 && tvIds.length === 0) return null;
  return {
    OR: [
      ...(movieIds.length ? [{ mediaType: "MOVIE" as const, tmdbId: { in: movieIds } }] : []),
      ...(tvIds.length ? [{ mediaType: "TV" as const, tmdbId: { in: tvIds } }] : []),
    ],
  };
}

export async function attachRequestedStatus(items: TmdbMedia[], userId?: string): Promise<TmdbMedia[]> {
  if (items.length === 0) return items;
  const baseWhere = buildMediaTypeWhere(items);
  if (!baseWhere) return items;

  // Scope to is4k:false (HD) so a 4K-only request does not mark the primary "requested"
  // flag used for HD CTAs/grids, and vice-versa. (Detail pages query is4k explicitly;
  // 4K variant uses its own requested/pending state.) Matches unique (tmdbId, mediaType, is4k).
  const [globalRows, mineRows] = await Promise.all([
    prisma.mediaRequest.findMany({
      where: { status: { not: "DECLINED" }, is4k: false, ...baseWhere },
      select: { tmdbId: true, mediaType: true },
      distinct: ["tmdbId", "mediaType"],
    }),
    userId
      ? prisma.mediaRequest.findMany({
          where: { status: { not: "DECLINED" }, requestedBy: userId, is4k: false, ...baseWhere },
          select: { tmdbId: true, mediaType: true },
          distinct: ["tmdbId", "mediaType"],
        })
      : Promise.resolve([] as { tmdbId: number; mediaType: "MOVIE" | "TV" }[]),
  ]);

  const globalSet = new Set(globalRows.map((r) => `${r.tmdbId}:${r.mediaType}`));
  const mineSet   = new Set(mineRows.map((r)   => `${r.tmdbId}:${r.mediaType}`));

  return items.map((item) => {
    const key = `${item.id}:${item.mediaType === "movie" ? "MOVIE" : "TV"}`;
    return {
      ...item,
      requested:     globalSet.has(key),
      requestedByMe: mineSet.has(key),
    };
  });
}
