import "server-only";
import { prisma } from "./prisma";

// Per-user "not interested" set, keyed "{tmdbId}:{MOVIE|TV}" to match the keyspace
// attachAllAvailability builds. Unlike the admin blacklist (global + cached), this
// is user-scoped and queried per discovery render (indexed on userId): it is small
// per user and only ever changes from that user's own actions, so a shared cache
// would buy little and complicate invalidation.
export async function getUserHiddenSet(userId: string): Promise<Set<string>> {
  const rows = await prisma.hiddenItem.findMany({
    where: { userId },
    select: { tmdbId: true, mediaType: true },
  });
  return new Set(rows.map((r) => `${r.tmdbId}:${r.mediaType}`));
}
