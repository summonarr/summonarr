// The PlexLibraryItem / JellyfinLibraryItem row builders, shared by the sync
// orchestrator and the per-source /api/sync/{plex,jellyfin} routes so a row is
// identical whichever path wrote it last.

import { plexLibraryRatingKeys, type PlexLibraryItemData } from "./plex";
import { libraryItemIds, type JellyfinLibraryItemData } from "./jellyfin";

/** Strips angle brackets and null bytes and caps the length; empty → null. */
export function sanitizeLibraryStr(s: string | null | undefined, maxLen = 1000): string | null {
  if (s == null) return null;
  return s.replace(/[<>]/g, "").replace(/\0/g, "").slice(0, maxLen) || null;
}

// `serverInstance` is required, never defaulted: every delete on these paths is
// scoped to the instance, so a row written without it lands under the schema
// default "" — moving a named server's library onto the DEFAULT server and
// un-restricting a `restricted` one (guardrail 35).

export function plexLibraryRow(tmdbId: number, d: PlexLibraryItemData, mediaType: "MOVIE" | "TV", serverInstance: string) {
  return {
    tmdbId,
    serverInstance,
    mediaType,
    filePath: d.filePath,
    plexRatingKey: d.ratingKey,
    plexRatingKeys: plexLibraryRatingKeys(d),
    title: sanitizeLibraryStr(d.title, 500) ?? "",
    year: d.year,
    overview: sanitizeLibraryStr(d.overview),
    contentRating: sanitizeLibraryStr(d.contentRating, 50),
    addedAt: d.addedAt,
  };
}

export function jellyfinLibraryRow(tmdbId: number, d: JellyfinLibraryItemData, mediaType: "MOVIE" | "TV", serverInstance: string) {
  return {
    tmdbId,
    serverInstance,
    mediaType,
    filePath: d.filePath,
    jellyfinItemId: d.itemId,
    jellyfinItemIds: libraryItemIds(d),
    title: sanitizeLibraryStr(d.title, 500) ?? "",
    year: d.year,
    overview: sanitizeLibraryStr(d.overview),
    contentRating: sanitizeLibraryStr(d.contentRating, 50),
    communityRating: d.communityRating,
    addedAt: d.addedAt,
  };
}
