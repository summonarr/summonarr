import "server-only";
import { prisma } from "./prisma";
import type { MediaType } from "@/generated/prisma";

// The blacklist is a small admin-maintained table that changes only when an admin
// adds/removes a title. Discovery marks against it on every list render (the title
// stays visible but is flagged unrequestable), so cache the resolved key set for a
// short window and coalesce concurrent cold
// reads into one query (mirrors getApiKey in omdb.ts). invalidateBlacklistCache()
// is called by the admin add/remove routes so a change propagates immediately;
// the TTL is only a backstop against a missed invalidation on another replica.
const BLACKLIST_TTL_MS = 30_000;
let cache: { set: Set<string>; at: number } | null = null;
let inflight: Promise<Set<string>> | null = null;

// Canonical key: "{tmdbId}:{MOVIE|TV}". Accepts either the Prisma enum casing
// (MOVIE/TV) or the TMDB-layer casing (movie/tv) so both the request chokepoint
// and the discovery marking share one keyspace.
export function blacklistKey(tmdbId: number, mediaType: string): string {
  const mt = mediaType === "movie" ? "MOVIE" : mediaType === "tv" ? "TV" : mediaType;
  return `${tmdbId}:${mt}`;
}

export async function getBlacklistSet(): Promise<Set<string>> {
  if (cache && Date.now() - cache.at < BLACKLIST_TTL_MS) return cache.set;
  if (inflight) return inflight;
  const p = (async () => {
    const rows = await prisma.blacklistItem.findMany({ select: { tmdbId: true, mediaType: true } });
    const set = new Set(rows.map((r) => `${r.tmdbId}:${r.mediaType}`));
    cache = { set, at: Date.now() };
    return set;
  })();
  inflight = p;
  p.finally(() => {
    inflight = null;
  }).catch(() => {});
  return p;
}

export function invalidateBlacklistCache(): void {
  cache = null;
}

// Hard-block check for the request chokepoint. mediaType is the Prisma enum casing.
export async function isBlacklisted(tmdbId: number, mediaType: MediaType): Promise<boolean> {
  const set = await getBlacklistSet();
  return set.has(`${tmdbId}:${mediaType}`);
}
