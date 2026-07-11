import { prisma } from "@/lib/prisma";
import type { TmdbMedia } from "@/lib/tmdb-types";

// "Pending" means the item exists in the Radarr/Sonarr wanted table — it does NOT confirm the item
// is actively downloading.  A negative result here only means it isn't tracked, not that it's absent.
//
// Multi-instance: one unfiltered query per table returns the (tmdbId, arrInstance) rows for every
// configured instance. From those we derive:
//   arrPending                    — wanted at the DEFAULT instance ("")            [back-compat]
//   arr4kPending / arr4kAvailable — wanted/available at the "4k" instance          [back-compat, gated by include4k]
//   arrInstances                  — the full per-slug { pending, available } map    [named-instance UI]
export async function attachArrPending(
  items: TmdbMedia[],
  opts?: { include4k?: boolean },
): Promise<TmdbMedia[]> {
  if (items.length === 0) return items;
  const include4k = opts?.include4k ?? false;

  const movieIds = items.filter((i) => i.mediaType === "movie").map((i) => i.id);
  const tvIds    = items.filter((i) => i.mediaType === "tv").map((i) => i.id);

  const [radarrWanted, sonarrWanted, radarrAvail, sonarrAvail] = await Promise.all([
    movieIds.length > 0
      ? prisma.radarrWantedItem.findMany({ where: { tmdbId: { in: movieIds } }, select: { tmdbId: true, arrInstance: true } })
      : Promise.resolve([]),
    tvIds.length > 0
      ? prisma.sonarrWantedItem.findMany({ where: { tmdbId: { in: tvIds } }, select: { tmdbId: true, arrInstance: true } })
      : Promise.resolve([]),
    movieIds.length > 0
      ? prisma.radarrAvailableItem.findMany({ where: { tmdbId: { in: movieIds } }, select: { tmdbId: true, arrInstance: true } })
      : Promise.resolve([]),
    tvIds.length > 0
      ? prisma.sonarrAvailableItem.findMany({ where: { tmdbId: { in: tvIds } }, select: { tmdbId: true, arrInstance: true } })
      : Promise.resolve([]),
  ]);

  // tmdbId → (slug → { pending, available }) for movies and TV separately.
  const movieMap = new Map<number, Map<string, { pending: boolean; available: boolean }>>();
  const tvMap    = new Map<number, Map<string, { pending: boolean; available: boolean }>>();
  const bump = (
    m: Map<number, Map<string, { pending: boolean; available: boolean }>>,
    tmdbId: number,
    slug: string,
    field: "pending" | "available",
  ) => {
    let bySlug = m.get(tmdbId);
    if (!bySlug) { bySlug = new Map(); m.set(tmdbId, bySlug); }
    const cur = bySlug.get(slug) ?? { pending: false, available: false };
    cur[field] = true;
    bySlug.set(slug, cur);
  };
  for (const r of radarrWanted) bump(movieMap, r.tmdbId, r.arrInstance, "pending");
  for (const r of radarrAvail)  bump(movieMap, r.tmdbId, r.arrInstance, "available");
  for (const r of sonarrWanted) bump(tvMap, r.tmdbId, r.arrInstance, "pending");
  for (const r of sonarrAvail)  bump(tvMap, r.tmdbId, r.arrInstance, "available");

  return items.map((item) => {
    const isMovie = item.mediaType === "movie";
    const bySlug = (isMovie ? movieMap : tvMap).get(item.id);
    const arrInstances = bySlug ? Object.fromEntries(bySlug) : undefined;
    const def = bySlug?.get("");
    const fourK = bySlug?.get("4k");
    return {
      ...item,
      arrPending: def?.pending ?? false,
      ...(arrInstances ? { arrInstances } : {}),
      ...(include4k
        ? {
            arr4kAvailable: fourK?.available ?? false,
            arr4kPending: fourK?.pending ?? false,
          }
        : {}),
    };
  });
}
