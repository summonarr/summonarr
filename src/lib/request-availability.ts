import { prisma } from "@/lib/prisma";
import type { Prisma } from "@/generated/prisma";
import type { TmdbMedia } from "@/lib/tmdb-types";

// Build one `tmdbId IN […]` clause per media type. Postgres can answer this
// from the (tmdbId, mediaType) index; one OR branch per item could not.
// Exported for unit tests.
export function buildMediaTypeWhere(items: TmdbMedia[]): Prisma.MediaRequestWhereInput | null {
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

  // Only look at the default instance (arrInstance ""). A request made on a 4K
  // or named instance must not light up the main "requested" flag that the
  // grids and default request buttons use. Detail pages query each instance
  // separately, since each instance has its own requested/pending state.
  const [globalRows, mineRows] = await Promise.all([
    prisma.mediaRequest.findMany({
      where: { status: { not: "DECLINED" }, arrInstance: "", ...baseWhere },
      select: { tmdbId: true, mediaType: true },
      distinct: ["tmdbId", "mediaType"],
    }),
    userId
      ? prisma.mediaRequest.findMany({
          where: { status: { not: "DECLINED" }, requestedBy: userId, arrInstance: "", ...baseWhere },
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
