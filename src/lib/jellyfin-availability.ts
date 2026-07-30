import { prisma } from "@/lib/prisma";
import type { TmdbMedia } from "@/lib/tmdb-types";

// Availability is derived solely from the local cache — freshness depends on the last sync run.
// Split by mediaType so each query becomes `tmdbId: { in: [...] }` — the composite
// (tmdbId, mediaType, serverInstance) PK serves this cleanly on its leading columns. Replaces
// the prior wide `OR: items.map(...)` pattern.
//
// `visibleInstances` is the caller's per-user allowlist of Jellyfin server slugs — see
// attachPlexAvailability in plex-availability.ts for the full rationale.
export async function attachJellyfinAvailability(
  items: TmdbMedia[],
  visibleInstances: string[],
): Promise<TmdbMedia[]> {
  if (items.length === 0) return items;

  const movieIds = items.filter((i) => i.mediaType === "movie").map((i) => i.id);
  const tvIds = items.filter((i) => i.mediaType === "tv").map((i) => i.id);

  const [movieRows, tvRows] = await Promise.all([
    movieIds.length > 0
      ? prisma.jellyfinLibraryItem.findMany({
          where: { mediaType: "MOVIE", tmdbId: { in: movieIds }, serverInstance: { in: visibleInstances } },
          select: { tmdbId: true },
        })
      : Promise.resolve([]),
    tvIds.length > 0
      ? prisma.jellyfinLibraryItem.findMany({
          where: { mediaType: "TV", tmdbId: { in: tvIds }, serverInstance: { in: visibleInstances } },
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
