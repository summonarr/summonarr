import { prisma } from "@/lib/prisma";
import type { TmdbMedia } from "@/lib/tmdb-types";

// DECLINED requests are excluded so a re-requested item is correctly shown as un-requested
export async function filterRequestedItems(items: TmdbMedia[]): Promise<TmdbMedia[]> {
  if (items.length === 0) return items;

  const rows = await prisma.mediaRequest.findMany({
    where: {
      status: { not: "DECLINED" },
      OR: items.map((item) => ({
        tmdbId: item.id,
        mediaType: item.mediaType === "movie" ? ("MOVIE" as const) : ("TV" as const),
      })),
    },
    select: { tmdbId: true, mediaType: true },
    distinct: ["tmdbId", "mediaType"],
  });

  const requestedSet = new Set(rows.map((r) => `${r.tmdbId}:${r.mediaType}`));

  return items.filter((item) => {
    const key = `${item.id}:${item.mediaType === "movie" ? "MOVIE" : "TV"}`;
    return !requestedSet.has(key);
  });
}

export async function attachRequestedStatus(items: TmdbMedia[], userId?: string): Promise<TmdbMedia[]> {
  if (items.length === 0) return items;

  const orClause = items.map((item) => ({
    tmdbId: item.id,
    mediaType: item.mediaType === "movie" ? ("MOVIE" as const) : ("TV" as const),
  }));

  const [globalRows, mineRows] = await Promise.all([
    prisma.mediaRequest.findMany({
      where: { status: { not: "DECLINED" }, OR: orClause },
      select: { tmdbId: true, mediaType: true },
      distinct: ["tmdbId", "mediaType"],
    }),
    userId
      ? prisma.mediaRequest.findMany({
          where: { status: { not: "DECLINED" }, requestedBy: userId, OR: orClause },
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
