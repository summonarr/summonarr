import { prisma } from "@/lib/prisma";
import type { TmdbMedia } from "@/lib/tmdb-types";

// "Pending" means the item exists in the Radarr/Sonarr wanted table — it does NOT confirm the item
// is actively downloading.  A negative result here only means it isn't tracked, not that it's absent.
export async function attachArrPending(items: TmdbMedia[]): Promise<TmdbMedia[]> {
  if (items.length === 0) return items;

  const movieIds = items.filter((i) => i.mediaType === "movie").map((i) => i.id);
  const tvIds    = items.filter((i) => i.mediaType === "tv").map((i) => i.id);

  const [radarrRows, sonarrRows] = await Promise.all([
    movieIds.length > 0
      ? prisma.radarrWantedItem.findMany({ where: { tmdbId: { in: movieIds } }, select: { tmdbId: true } })
      : Promise.resolve([]),
    tvIds.length > 0
      ? prisma.sonarrWantedItem.findMany({ where: { tmdbId: { in: tvIds } }, select: { tmdbId: true } })
      : Promise.resolve([]),
  ]);

  const radarrSet = new Set(radarrRows.map((r) => r.tmdbId));
  const sonarrSet = new Set(sonarrRows.map((r) => r.tmdbId));

  return items.map((item) => ({
    ...item,
    arrPending:
      item.mediaType === "movie"
        ? radarrSet.has(item.id)
        : sonarrSet.has(item.id),
  }));
}
