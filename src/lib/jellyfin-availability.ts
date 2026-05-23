import { prisma } from "@/lib/prisma";
import type { TmdbMedia } from "@/lib/tmdb-types";

// Availability is derived solely from the local cache — freshness depends on the last sync run.
// Split by mediaType so each query becomes `tmdbId: { in: [...] }` — the composite (tmdbId, mediaType)
// PK serves this cleanly. Replaces the prior wide `OR: items.map(...)` pattern.
export async function attachJellyfinAvailability(items: TmdbMedia[]): Promise<TmdbMedia[]> {
  if (items.length === 0) return items;

  const movieIds = items.filter((i) => i.mediaType === "movie").map((i) => i.id);
  const tvIds = items.filter((i) => i.mediaType === "tv").map((i) => i.id);

  const [movieRows, tvRows] = await Promise.all([
    movieIds.length > 0
      ? prisma.jellyfinLibraryItem.findMany({
          where: { mediaType: "MOVIE", tmdbId: { in: movieIds } },
          select: { tmdbId: true },
        })
      : Promise.resolve([]),
    tvIds.length > 0
      ? prisma.jellyfinLibraryItem.findMany({
          where: { mediaType: "TV", tmdbId: { in: tvIds } },
          select: { tmdbId: true },
        })
      : Promise.resolve([]),
  ]);

  const movieSet = new Set(movieRows.map((r) => r.tmdbId));
  const tvSet = new Set(tvRows.map((r) => r.tmdbId));

  return items.map((r) => ({
    ...r,
    jellyfinAvailable:
      r.mediaType === "movie" ? movieSet.has(r.id) : tvSet.has(r.id),
  }));
}
