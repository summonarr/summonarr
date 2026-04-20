import "server-only";
import { attachPlexAvailability } from "./plex-availability";
import { attachJellyfinAvailability } from "./jellyfin-availability";
import { attachArrPending } from "./arr-availability";
import { attachRequestedStatus } from "./request-availability";
import { attachRatingsUnified } from "./omdb-availability";
import type { TmdbMedia } from "./tmdb-types";

// All five enrichment passes run in parallel against the same input slice; results are merged by
// composite key so no pass can accidentally overwrite a field written by another.
export async function attachAllAvailability(
  items: TmdbMedia[],
  userId?: string,
  options?: { blockRatings?: boolean; skipRatings?: boolean },
): Promise<TmdbMedia[]> {
  if (items.length === 0) return items;

  const [withPlex, withJellyfin, withArr, withRequests, withRatings] = await Promise.all([
    attachPlexAvailability(items),
    attachJellyfinAvailability(items),
    attachArrPending(items),
    attachRequestedStatus(items, userId),
    options?.skipRatings
      ? Promise.resolve(items)
      : attachRatingsUnified(items, { blocking: options?.blockRatings ?? false }),
  ]);

  const plexMap     = new Map(withPlex.map((i)     => [`${i.id}:${i.mediaType}`, i.plexAvailable]));
  const jellyfinMap = new Map(withJellyfin.map((i)  => [`${i.id}:${i.mediaType}`, i.jellyfinAvailable]));
  const arrMap      = new Map(withArr.map((i)       => [`${i.id}:${i.mediaType}`, i.arrPending]));
  const reqMap      = new Map(withRequests.map((i)  => [`${i.id}:${i.mediaType}`, { requested: i.requested, requestedByMe: i.requestedByMe }]));
  const ratingsMap  = new Map(withRatings.map((i)   => [`${i.id}:${i.mediaType}`, i]));

  return items.map((item) => {
    const k = `${item.id}:${item.mediaType}`;
    return {
      ...(ratingsMap.get(k) ?? item),
      plexAvailable:     plexMap.get(k)           ?? false,
      jellyfinAvailable: jellyfinMap.get(k)        ?? false,
      arrPending:        arrMap.get(k)             ?? false,
      requested:         reqMap.get(k)?.requested     ?? false,
      requestedByMe:     reqMap.get(k)?.requestedByMe ?? false,
    };
  });
}
