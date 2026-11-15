import "server-only";
import { attachPlexAvailability } from "./plex-availability";
import { attachJellyfinAvailability } from "./jellyfin-availability";
import { attachArrPending } from "./arr-availability";
import { attachRequestedStatus } from "./request-availability";
import { attachRatingsUnified } from "./omdb-availability";
import { coldLookupAdmitter } from "./ratings-cold-budget";
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
  options?: {
    blockRatings?: boolean;
    skipRatings?: boolean;
    show4k?: boolean;
    includeHidden?: boolean;
    // Leave TMDB text in English: for a caller that shows only a slice of a
    // long list and localizes that slice itself (localizeMedia), rather than
    // fetching translations for titles it never renders.
    skipLocalize?: boolean;
    // With blockRatings: how many OMDb chains the request waits for; the rest
    // of the cold titles are warmed after the response.
    maxBlockingRatingMisses?: number;
  },
): Promise<T[]> {
  if (items.length === 0) return items;

  // Admin-blacklisted titles stay VISIBLE in discovery but are marked so the UI can
  // show an "unavailable to request" state — the request POST is the authoritative
  // block. This is the single chokepoint all list routes/pages funnel through.
  //
  // Per-user "not interested" (HiddenItem) titles, by contrast, are REMOVED from the
  // returned list. Because this is the shared chokepoint, hiding takes effect across
  // every discovery surface at once. Opt out with includeHidden for the few callers
  // that must still show a hidden title: the item the user is actively viewing,
  // their own requests list and a search by name. Anonymous callers (no userId) are never filtered.
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
      : attachRatingsUnified(work, {
          blocking: options?.blockRatings ?? false,
          // A signed-in viewer's cold titles — fetched in the request or warmed
          // after it — draw on that user's one cold-lookup budget
          // (ratings-cold-budget.ts). Callers with no user are not limited.
          ...(userId ? { admitMiss: coldLookupAdmitter(userId) } : {}),
          ...(options?.maxBlockingRatingMisses !== undefined ? { maxBlockingMisses: options.maxBlockingRatingMisses } : {}),
        }),
    options?.skipLocalize ? Promise.resolve(work) : getContentLocale().then((locale) => localizeMedia(work, locale)),
  ]);

  const plex = byMediaKey(withPlex);
  const jellyfin = byMediaKey(withJellyfin);
  const arr = byMediaKey(withArr);
  const requests = byMediaKey(withRequests);
  const ratings = byMediaKey(withRatings);
  const text = localized === work ? null : byMediaKey(localized);

  return work.map((item): T => {
    const k = mediaKey(item);
    const a = arr.get(k);
    const r = requests.get(k);
    return {
      // The caller's item first, so its own fields survive whatever shape the
      // ratings pass returns; the ratings fields then win over it.
      ...item,
      ...ratings.get(k),
      ...localizedText(text?.get(k)),
      plexAvailable:     plex.get(k)?.plexAvailable         ?? false,
      jellyfinAvailable: jellyfin.get(k)?.jellyfinAvailable ?? false,
      arrPending:        a?.arrPending                      ?? false,
      // Only surfaced when show4k is true; left undefined otherwise so the UI shows nothing.
      arr4kPending:      a?.arr4kPending,
      arr4kAvailable:    a?.arr4kAvailable,
      requested:         r?.requested                       ?? false,
      requestedByMe:     r?.requestedByMe                   ?? false,
      ...(blSet.size > 0 && blSet.has(blacklistKey(item.id, item.mediaType)) ? { blacklisted: true } : {}),
    };
  });
}

// One title's identity across the passes: TMDB ids are per media type.
const mediaKey = (i: Pick<TmdbMedia, "id" | "mediaType">) => `${i.id}:${i.mediaType}`;

// A pass's answer by title, so each field is read from the pass that owns it
// and no pass can overwrite another's.
function byMediaKey<U extends Pick<TmdbMedia, "id" | "mediaType">>(list: readonly U[]): Map<string, U> {
  return new Map(list.map((i) => [mediaKey(i), i]));
}

// Only the overlay's own fields — never let it overwrite enrichment.
function localizedText(t: TmdbMedia | undefined): Partial<TmdbMedia> {
  if (!t) return {};
  return {
    title: t.title,
    overview: t.overview,
    tagline: t.tagline,
    posterPath: t.posterPath,
    originalTitle: t.originalTitle,
    genres: t.genres,
    genreList: t.genreList,
  };
}
