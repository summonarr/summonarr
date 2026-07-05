import "server-only";
import { attachPlexAvailability } from "./plex-availability";
import { attachJellyfinAvailability } from "./jellyfin-availability";
import { attachArrPending } from "./arr-availability";
import { attachRequestedStatus } from "./request-availability";
import { attachRatingsUnified } from "./omdb-availability";
import { filterBlacklisted } from "./blacklist";
import type { TmdbMedia } from "./tmdb-types";

// All five enrichment passes run in parallel against the same input slice; results are merged by
// composite key so no pass can accidentally overwrite a field written by another.
export async function attachAllAvailability(
  items: TmdbMedia[],
  userId?: string,
  options?: { blockRatings?: boolean; skipRatings?: boolean; show4k?: boolean; keepBlacklisted?: boolean },
): Promise<TmdbMedia[]> {
  if (items.length === 0) return items;

  // Hide admin-blacklisted titles from every discovery surface by default — this is
  // the single chokepoint all list routes/pages funnel through. Callers that must
  // NOT drop (the user's own requests list, the media-detail primary item) pass
  // keepBlacklisted. The request POST remains the authoritative block.
  if (!options?.keepBlacklisted) {
    items = await filterBlacklisted(items);
    if (items.length === 0) return items;
  }

  const [withPlex, withJellyfin, withArr, withRequests, withRatings] = await Promise.all([
    attachPlexAvailability(items),
    attachJellyfinAvailability(items),
    attachArrPending(items, { include4k: options?.show4k ?? false }),
    attachRequestedStatus(items, userId),
    options?.skipRatings
      ? Promise.resolve(items)
      : attachRatingsUnified(items, { blocking: options?.blockRatings ?? false }),
  ]);

  const plexMap     = new Map(withPlex.map((i)     => [`${i.id}:${i.mediaType}`, i.plexAvailable]));
  const jellyfinMap = new Map(withJellyfin.map((i)  => [`${i.id}:${i.mediaType}`, i.jellyfinAvailable]));
  const arrMap      = new Map(withArr.map((i)       => [`${i.id}:${i.mediaType}`, { arrPending: i.arrPending, arr4kPending: i.arr4kPending, arr4kAvailable: i.arr4kAvailable }]));
  const reqMap      = new Map(withRequests.map((i)  => [`${i.id}:${i.mediaType}`, { requested: i.requested, requestedByMe: i.requestedByMe }]));
  const ratingsMap  = new Map(withRatings.map((i)   => [`${i.id}:${i.mediaType}`, i]));

  return items.map((item) => {
    const k = `${item.id}:${item.mediaType}`;
    const arr = arrMap.get(k);
    return {
      ...(ratingsMap.get(k) ?? item),
      plexAvailable:     plexMap.get(k)           ?? false,
      jellyfinAvailable: jellyfinMap.get(k)        ?? false,
      arrPending:        arr?.arrPending           ?? false,
      // Only surfaced when show4k is true; left undefined otherwise so the UI shows nothing.
      arr4kPending:      arr?.arr4kPending,
      arr4kAvailable:    arr?.arr4kAvailable,
      requested:         reqMap.get(k)?.requested     ?? false,
      requestedByMe:     reqMap.get(k)?.requestedByMe ?? false,
    };
  });
}
