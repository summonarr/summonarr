import { prisma } from "@/lib/prisma";
import type { TmdbMedia } from "@/lib/tmdb-types";

// Availability is derived solely from the local cache — freshness depends on the last sync run.
// Split by mediaType so each query becomes `tmdbId: { in: [...] }` — the composite
// (tmdbId, mediaType, serverInstance) PK serves this cleanly on its leading columns. Replaces
// the prior wide `OR: items.map(...)` pattern which the planner could not optimize for
// 100+-row rails (mirrors arr-availability.ts).
//
// `visibleInstances` is the caller's per-user allowlist of Plex server slugs (see
// media-visibility.ts): a server marked `restricted` contributes availability ONLY to users
// granted `view` on it. Required, and a concrete list rather than a predicate — an omitted
// argument is a type error instead of a silent leak, and a list can't close over request
// state in this shared module. Deployments with no restricted server pass every configured
// slug, so the clause is satisfied by every row and the answer is unchanged.
export async function attachPlexAvailability(
  items: TmdbMedia[],
  visibleInstances: string[],
): Promise<TmdbMedia[]> {
  if (items.length === 0) return items;

  const movieIds = items.filter((i) => i.mediaType === "movie").map((i) => i.id);
  const tvIds = items.filter((i) => i.mediaType === "tv").map((i) => i.id);

  const [movieRows, tvRows] = await Promise.all([
    movieIds.length > 0
      ? prisma.plexLibraryItem.findMany({
          where: { mediaType: "MOVIE", tmdbId: { in: movieIds }, serverInstance: { in: visibleInstances } },
          select: { tmdbId: true },
        })
      : Promise.resolve([]),
    tvIds.length > 0
      ? prisma.plexLibraryItem.findMany({
          where: { mediaType: "TV", tmdbId: { in: tvIds }, serverInstance: { in: visibleInstances } },
          select: { tmdbId: true },
        })
      : Promise.resolve([]),
  ]);

  const movieSet = new Set(movieRows.map((r) => r.tmdbId));
  const tvSet = new Set(tvRows.map((r) => r.tmdbId));

  return items.map((r) => ({
    ...r,
    plexAvailable:
      r.mediaType === "movie" ? movieSet.has(r.id) : tvSet.has(r.id),
  }));
}
