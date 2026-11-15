import "server-only";
import { prisma } from "./prisma";
import { processSingleton } from "./process-singleton";
import type { MediaType } from "@/generated/prisma";

// The blacklist is a small admin-maintained table that changes only when an admin
// adds/removes a title. Discovery marks against it on every list render (the title
// stays visible but is flagged unrequestable), so cache the resolved key set for a
// short window and share one query between callers that arrive while the cache is
// empty (mirrors getApiKey in omdb.ts). invalidateBlacklistCache()
// is called by the admin add/remove routes so a change propagates immediately;
// the TTL is only a backstop against a missed invalidation on another replica.
const BLACKLIST_TTL_MS = 30_000;
// Process-wide, not module-level: this module is compiled into several server
// chunks, and the admin routes that invalidate live in a different chunk from
// the request path that reads. One shared object makes an invalidation reach
// every copy.
const state = processSingleton("blacklist:cache", () => ({
  cache: null as { set: Set<string>; at: number } | null,
  inflight: null as Promise<Set<string>> | null,
  // Identity of the current cold read. invalidateBlacklistCache() nulls it, so a
  // read that began before an admin blacklist change can detect on resolve that
  // it is stale and must not repopulate the cache.
  inflightToken: null as object | null,
}));

// Canonical key: "{tmdbId}:{MOVIE|TV}". Accepts either the Prisma enum casing
// (MOVIE/TV) or the TMDB-layer casing (movie/tv) so both the request chokepoint
// and the discovery marking share one keyspace.
export function blacklistKey(tmdbId: number, mediaType: string): string {
  const mt = mediaType === "movie" ? "MOVIE" : mediaType === "tv" ? "TV" : mediaType;
  return `${tmdbId}:${mt}`;
}

export async function getBlacklistSet(): Promise<Set<string>> {
  if (state.cache && Date.now() - state.cache.at < BLACKLIST_TTL_MS) return state.cache.set;
  if (state.inflight) return state.inflight;
  const token = {};
  state.inflightToken = token;
  const p = (async () => {
    const rows = await prisma.blacklistItem.findMany({ select: { tmdbId: true, mediaType: true } });
    const set = new Set(rows.map((r) => `${r.tmdbId}:${r.mediaType}`));
    // Only publish to cache if this read is still current. An invalidation
    // between query start and resolve nulls `inflightToken`, so a read that began
    // before an admin blacklist change cannot repopulate the cache with pre-change data.
    if (state.inflightToken === token) state.cache = { set, at: Date.now() };
    return set;
  })();
  state.inflight = p;
  p.finally(() => {
    if (state.inflight === p) state.inflight = null;
  }).catch(() => {});
  return p;
}

export function invalidateBlacklistCache(): void {
  state.cache = null;
  state.inflight = null;
  state.inflightToken = null;
}

// Hard-block check for the request chokepoint. mediaType is the Prisma enum casing.
export async function isBlacklisted(tmdbId: number, mediaType: MediaType): Promise<boolean> {
  const set = await getBlacklistSet();
  return set.has(`${tmdbId}:${mediaType}`);
}
