import { prisma } from "@/lib/prisma";
import type { TmdbMedia } from "@/lib/tmdb-types";

// "Pending" means the item exists in the Radarr/Sonarr wanted table — it does NOT confirm the item
// is actively downloading.  A negative result here only means it isn't tracked, not that it's absent.
//
// `include4k` additionally resolves the 4K instance partitions: arr4kAvailable (the 4K Radarr/Sonarr
// has the file) and arr4kPending (wanted in 4K but not yet fetched). It's off by default so HD-only
// callers run exactly the queries they always did; the 4K rows only exist when a 4K instance is synced.
export async function attachArrPending(
  items: TmdbMedia[],
  opts?: { include4k?: boolean },
): Promise<TmdbMedia[]> {
  if (items.length === 0) return items;
  const include4k = opts?.include4k ?? false;

  const movieIds = items.filter((i) => i.mediaType === "movie").map((i) => i.id);
  const tvIds    = items.filter((i) => i.mediaType === "tv").map((i) => i.id);

  const [radarrRows, sonarrRows, radarr4kWanted, sonarr4kWanted, radarr4kAvail, sonarr4kAvail] = await Promise.all([
    movieIds.length > 0
      ? prisma.radarrWantedItem.findMany({ where: { tmdbId: { in: movieIds }, is4k: false }, select: { tmdbId: true } })
      : Promise.resolve([]),
    tvIds.length > 0
      ? prisma.sonarrWantedItem.findMany({ where: { tmdbId: { in: tvIds }, is4k: false }, select: { tmdbId: true } })
      : Promise.resolve([]),
    include4k && movieIds.length > 0
      ? prisma.radarrWantedItem.findMany({ where: { tmdbId: { in: movieIds }, is4k: true }, select: { tmdbId: true } })
      : Promise.resolve([]),
    include4k && tvIds.length > 0
      ? prisma.sonarrWantedItem.findMany({ where: { tmdbId: { in: tvIds }, is4k: true }, select: { tmdbId: true } })
      : Promise.resolve([]),
    include4k && movieIds.length > 0
      ? prisma.radarrAvailableItem.findMany({ where: { tmdbId: { in: movieIds }, is4k: true }, select: { tmdbId: true } })
      : Promise.resolve([]),
    include4k && tvIds.length > 0
      ? prisma.sonarrAvailableItem.findMany({ where: { tmdbId: { in: tvIds }, is4k: true }, select: { tmdbId: true } })
      : Promise.resolve([]),
  ]);

  const radarrSet = new Set(radarrRows.map((r) => r.tmdbId));
  const sonarrSet = new Set(sonarrRows.map((r) => r.tmdbId));
  const radarr4kWantedSet = new Set(radarr4kWanted.map((r) => r.tmdbId));
  const sonarr4kWantedSet = new Set(sonarr4kWanted.map((r) => r.tmdbId));
  const radarr4kAvailSet  = new Set(radarr4kAvail.map((r) => r.tmdbId));
  const sonarr4kAvailSet  = new Set(sonarr4kAvail.map((r) => r.tmdbId));

  return items.map((item) => {
    const isMovie = item.mediaType === "movie";
    return {
      ...item,
      arrPending: isMovie ? radarrSet.has(item.id) : sonarrSet.has(item.id),
      ...(include4k
        ? {
            arr4kAvailable: isMovie ? radarr4kAvailSet.has(item.id) : sonarr4kAvailSet.has(item.id),
            arr4kPending:   isMovie ? radarr4kWantedSet.has(item.id) : sonarr4kWantedSet.has(item.id),
          }
        : {}),
    };
  });
}
