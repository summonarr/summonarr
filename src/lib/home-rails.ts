// The home feed's pure rail shaping, shared by GET /api/home (the native
// clients' feed) and the web home page (src/app/(app)/page.tsx).
import type { TmdbMedia } from "./tmdb-types";

/** Which servers a viewer is shown (their pinned server, or both). */
export interface RailVisibility {
  hideAvailable: boolean;
  showPlex: boolean;
  showJellyfin: boolean;
}

export const mediaKey = (m: Pick<TmdbMedia, "mediaType" | "id">): string => `${m.mediaType}-${m.id}`;

/** Flattens several rails into one list, keeping the first occurrence of each title. */
export function dedupeUnion(lists: readonly (readonly TmdbMedia[])[]): TmdbMedia[] {
  const seen = new Set<string>();
  const out: TmdbMedia[] = [];
  for (const list of lists) {
    for (const m of list) {
      const k = mediaKey(m);
      if (seen.has(k)) continue;
      seen.add(k);
      out.push(m);
    }
  }
  return out;
}

/**
 * The one "Hide Available drops this" rule, shared by projectRail and
 * emptiedByHideAvailable so a rail and its empty-state message can't disagree
 * about which titles count as available.
 */
export function availableToViewer(e: TmdbMedia, vis: Pick<RailVisibility, "showPlex" | "showJellyfin">): boolean {
  return (vis.showPlex && !!e.plexAvailable) || (vis.showJellyfin && !!e.jellyfinAvailable);
}

/**
 * A rail's raw items as their enriched versions, at most `limit`. A title
 * missing from `enriched` was filtered on purpose by attachAllAvailability (the
 * viewer hid it): it is dropped, never put back as the raw item. With
 * hideAvailable, a title available on a server the viewer is SHOWN is dropped —
 * a Plex-pinned viewer keeps Jellyfin-only titles, and vice versa.
 */
export function projectRail(
  raw: readonly TmdbMedia[],
  enriched: ReadonlyMap<string, TmdbMedia>,
  vis: RailVisibility,
  limit: number,
): TmdbMedia[] {
  const out: TmdbMedia[] = [];
  for (const m of raw) {
    const e = enriched.get(mediaKey(m));
    if (!e) continue;
    if (vis.hideAvailable && availableToViewer(e, vis)) continue;
    out.push(e);
    if (out.length >= limit) break;
  }
  return out;
}

/**
 * True when Hide Available is what emptied a rail: at least one of its titles
 * survived the hidden-title filter and every such title was dropped as
 * available. A rail that is empty for any OTHER reason — a failed TMDB call, a
 * new user with no For You shelf, titles the user hid — must not claim
 * "everything here is already on your server".
 */
export function emptiedByHideAvailable(
  raw: readonly TmdbMedia[],
  enriched: ReadonlyMap<string, TmdbMedia>,
  vis: RailVisibility,
): boolean {
  if (!vis.hideAvailable) return false;
  let seen = false;
  for (const m of raw) {
    const e = enriched.get(mediaKey(m));
    if (!e) continue;
    if (!availableToViewer(e, vis)) return false;
    seen = true;
  }
  return seen;
}

/**
 * The featured movie and show (the first of each on the trending rail) and the
 * trending rail without them, so a featured title isn't shown twice.
 */
export function splitFeatured(trending: readonly TmdbMedia[]): { featured: TmdbMedia[]; rest: TmdbMedia[] } {
  const featured = [
    trending.find((m) => m.mediaType === "movie"),
    trending.find((m) => m.mediaType === "tv"),
  ].filter((m): m is TmdbMedia => m != null);
  const featuredKeys = new Set(featured.map(mediaKey));
  return { featured, rest: trending.filter((m) => !featuredKeys.has(mediaKey(m))) };
}
