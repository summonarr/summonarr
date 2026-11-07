import "server-only";
import { attachPlexAvailability } from "./plex-availability";
import { attachJellyfinAvailability } from "./jellyfin-availability";
import { attachArrPending } from "./arr-availability";
import { attachRequestedStatus } from "./request-availability";
import { attachRatingsUnified } from "./omdb-availability";
import { getBlacklistSet, blacklistKey } from "./blacklist";
import { getUserHiddenSet, hiddenKeyOf } from "./hidden";
import { getVisibleServerInstancesForUserId } from "./media-visibility";
import type { TmdbMedia } from "./tmdb-types";
import { localizeMedia } from "./tmdb-localize";
import { getContentLocale } from "./i18n/server";

// All five enrichment passes (plus the content-language overlay) run in parallel against the same input slice; results are merged by
// composite key so no pass can accidentally overwrite a field written by another.
//
// Generic over the item type: a caller's own fields (a rank, play counts) come
// back typed, because every result starts from the caller's item.
export async function attachAllAvailability<T extends TmdbMedia>(
  items: T[],
  userId?: string,
  options?: { blockRatings?: boolean; skipRatings?: boolean; show4k?: boolean; includeHidden?: boolean },
): Promise<T[]> {
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
  //
  // Per-user media-server visibility is resolved HERE for the same reason: a Plex/Jellyfin
  // server marked `restricted` contributes availability only to users granted `view` on it,
  // and this chokepoint already carries the userId every one of its 28 call sites passes.
  // Enforcing in the data layer (rather than masking in the UI the way badge-visibility.ts
  // does) is what keeps a restricted server out of the raw JSON these routes return.
  const wantHidden = !!userId && !options?.includeHidden;
  const [blSet, hiddenSet, visible] = await Promise.all([
    getBlacklistSet(),
    wantHidden ? getUserHiddenSet(userId as string) : Promise.resolve<Set<string>>(new Set()),
    getVisibleServerInstancesForUserId(userId),
  ]);

  // The caller's "not interested" titles leave BEFORE enrichment (no-op when
  // the set is empty or the caller opted out via includeHidden): enriched first,
  // they still cost library and request lookups, ratings misses (MDBList/OMDB
  // calls) and translation fetches whose results were then thrown away.
  const work = hiddenSet.size === 0 ? items : items.filter((i) => !hiddenSet.has(hiddenKeyOf(i)));
  if (work.length === 0) return work;

  // The viewer's language for TMDB text (titles, overviews), resolved from the
  // request like the UI's own language. English — and any call outside a request
  // scope — is a no-op that returns `work` itself.
  const [withPlex, withJellyfin, withArr, withRequests, withRatings, localized] = await Promise.all([
    attachPlexAvailability(work, visible.plex),
    attachJellyfinAvailability(work, visible.jellyfin),
    attachArrPending(work, { include4k: options?.show4k ?? false }),
    attachRequestedStatus(work, userId),
    options?.skipRatings
      ? Promise.resolve(work)
      : attachRatingsUnified(work, { blocking: options?.blockRatings ?? false }),
    getContentLocale().then((locale) => localizeMedia(work, locale)),
  ]);

  const plexMap     = new Map(withPlex.map((i)     => [`${i.id}:${i.mediaType}`, i.plexAvailable]));
  const jellyfinMap = new Map(withJellyfin.map((i)  => [`${i.id}:${i.mediaType}`, i.jellyfinAvailable]));
  const arrMap      = new Map(withArr.map((i)       => [`${i.id}:${i.mediaType}`, { arrPending: i.arrPending, arr4kPending: i.arr4kPending, arr4kAvailable: i.arr4kAvailable }]));
  const reqMap      = new Map(withRequests.map((i)  => [`${i.id}:${i.mediaType}`, { requested: i.requested, requestedByMe: i.requestedByMe }]));
  const ratingsMap  = new Map(withRatings.map((i)   => [`${i.id}:${i.mediaType}`, i]));
  const textMap     = localized === work ? null : new Map(localized.map((i) => [`${i.id}:${i.mediaType}`, i]));

  return work.map((item) => {
    const k = `${item.id}:${item.mediaType}`;
    const arr = arrMap.get(k);
    const text = textMap?.get(k);
    return {
      // The caller's item first, so its own fields survive whatever shape the
      // ratings pass returns; the ratings fields then win over it.
      ...item,
      ...ratingsMap.get(k),
      // Only the overlay's own fields — never let it overwrite enrichment.
      ...(text
        ? {
            title: text.title,
            overview: text.overview,
            tagline: text.tagline,
            posterPath: text.posterPath,
            originalTitle: text.originalTitle,
            genres: text.genres,
            genreList: text.genreList,
          }
        : {}),
      plexAvailable:     plexMap.get(k)           ?? false,
      jellyfinAvailable: jellyfinMap.get(k)        ?? false,
      arrPending:        arr?.arrPending           ?? false,
      // Only surfaced when show4k is true; left undefined otherwise so the UI shows nothing.
      arr4kPending:      arr?.arr4kPending,
      arr4kAvailable:    arr?.arr4kAvailable,
      requested:         reqMap.get(k)?.requested     ?? false,
      requestedByMe:     reqMap.get(k)?.requestedByMe ?? false,
      ...(blSet.size > 0 && blSet.has(blacklistKey(item.id, item.mediaType)) ? { blacklisted: true } : {}),
    } as T;
  });
}
