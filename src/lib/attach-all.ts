import "server-only";
import { attachPlexAvailability } from "./plex-availability";
import { attachJellyfinAvailability } from "./jellyfin-availability";
import { attachArrPending } from "./arr-availability";
import { attachRequestedStatus } from "./request-availability";
import { attachRatingsUnified } from "./omdb-availability";
import { getBlacklistSet, blacklistKey } from "./blacklist";
import { getUserHiddenSet } from "./hidden";
import type { TmdbMedia } from "./tmdb-types";

// All five enrichment passes run in parallel against the same input slice; results are merged by
// composite key so no pass can accidentally overwrite a field written by another.
export async function attachAllAvailability(
  items: TmdbMedia[],
  userId?: string,
  options?: { blockRatings?: boolean; skipRatings?: boolean; show4k?: boolean; includeHidden?: boolean },
): Promise<TmdbMedia[]> {
  if (items.length === 0) return items;

  // Admin-blacklisted titles stay VISIBLE in discovery but are marked so the UI can
  // show an "unavailable to request" state — the request POST is the authoritative
  // block. This is the single chokepoint all list routes/pages funnel through.
  //
  // Per-user "not interested" (HiddenItem) titles, by contrast, are REMOVED from the
  // returned list. Because this is the shared chokepoint, hiding takes effect across
  // every discovery surface at once. Opt out with includeHidden for the few callers
  // that must still show a hidden title: the item the user is actively viewing and
  // their own requests list. Anonymous callers (no userId) are never filtered.
  const wantHidden = !!userId && !options?.includeHidden;
  const [blSet, hiddenSet] = await Promise.all([
    getBlacklistSet(),
    wantHidden ? getUserHiddenSet(userId as string) : Promise.resolve<Set<string>>(new Set()),
  ]);

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

  const enriched = items.map((item) => {
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
      ...(blSet.size > 0 && blSet.has(blacklistKey(item.id, item.mediaType)) ? { blacklisted: true } : {}),
    };
  });

  // Drop the caller's "not interested" titles (no-op when the set is empty or the
  // caller opted out via includeHidden).
  if (hiddenSet.size === 0) return enriched;
  return enriched.filter((i) => !hiddenSet.has(`${i.id}:${i.mediaType}`));
}
