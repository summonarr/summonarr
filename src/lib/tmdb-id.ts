// TMDB ids are stored in INT4 columns (PlexLibraryItem.tmdbId,
// JellyfinLibraryItem.tmdbId, TVEpisodeCache.tmdbId, MediaRequest.tmdbId, …).
// A value that clears `Number.isInteger(id) && id > 0` but exceeds INT4 throws
// out of Prisma at the first keyed read — an unhandled 500 for a malformed query
// string. Every route that takes a tmdbId from the client applies this ONE
// bound so the siblings agree (issues/route.ts documents the same trap for
// season/episode numbers). Zero-import so client code may use it too.
export const MAX_TMDB_ID = 2_147_483_647;

export function isTmdbIdInRange(id: number): boolean {
  return Number.isInteger(id) && id > 0 && id <= MAX_TMDB_ID;
}
