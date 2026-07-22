import "server-only";
import { prisma } from "./prisma";

// Per-user "not interested" set, keyed "{tmdbId}:{movie|tv}" to match the keyspace
// attachAllAvailability builds. The Prisma enum stores mediaType as "MOVIE"/"TV",
// but TmdbMedia.mediaType (the filter side in attach-all.ts) is the lowercase TMDB
// casing, so the key must be lowercased here or Set.has never matches. Unlike the
// admin blacklist (global + cached), this is user-scoped and queried per discovery
// render (indexed on userId): it is small per user and only ever changes from that
// user's own actions, so a shared cache would buy little and complicate invalidation.
// Bound the per-render read. HiddenItem rows accumulate unbounded (POST /api/hidden
// is only per-minute rate-limited, so a user can amass hundreds of thousands over
// time), and this runs on EVERY discovery render — an uncapped findMany would load
// that whole set into memory each time. 10k is far beyond any real "not interested"
// list; a user past it simply won't have their oldest hides filtered (cosmetic).
const MAX_HIDDEN_SET = 10_000;

export async function getUserHiddenSet(userId: string): Promise<Set<string>> {
  const rows = await prisma.hiddenItem.findMany({
    where: { userId },
    select: { tmdbId: true, mediaType: true },
    orderBy: { createdAt: "desc" },
    take: MAX_HIDDEN_SET,
  });
  return new Set(rows.map((r) => `${r.tmdbId}:${r.mediaType.toLowerCase()}`));
}
