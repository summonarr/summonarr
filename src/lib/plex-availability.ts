import { prisma } from "@/lib/prisma";
import type { TmdbMedia } from "@/lib/tmdb-types";

// Availability is derived solely from the local cache — freshness depends on the last sync run.
export async function attachPlexAvailability(items: TmdbMedia[]): Promise<TmdbMedia[]> {
  if (items.length === 0) return items;

  const rows = await prisma.plexLibraryItem.findMany({
    where: {
      OR: items.map((r) => ({
        tmdbId: r.id,
        mediaType: r.mediaType === "movie" ? ("MOVIE" as const) : ("TV" as const),
      })),
    },
    select: { tmdbId: true, mediaType: true },
  });

  const plexSet = new Set(rows.map((r) => `${r.tmdbId}:${r.mediaType}`));

  return items.map((r) => ({
    ...r,
    plexAvailable: plexSet.has(`${r.id}:${r.mediaType === "movie" ? "MOVIE" : "TV"}`),
  }));
}
