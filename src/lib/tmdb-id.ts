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

// A tmdbId taken from a URL path segment, accepted only in its canonical
// spelling: digits with no leading zero. `parseInt` read "550abc" and "1.5" as
// 550 and 1, and `Number` read "1e3", "0x3E8", " 1000 " and "1000.0" as 1000, so
// one title answered under URLs that weren't its own and "1.5" reached TMDB.
// Returns null for anything else. NOT range-checked (a canonical value can still
// pass INT4): callers apply isTmdbIdInRange next, so a route can tell the two
// failures apart.
export function parseTmdbIdParam(raw: string): number | null {
  return /^[1-9][0-9]*$/.test(raw) ? Number(raw) : null;
}
