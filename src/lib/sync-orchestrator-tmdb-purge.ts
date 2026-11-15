// Sync orchestrator (sync-orchestrator.ts): the tail purge of expired TmdbCache rows.
import { prisma } from "./prisma";
import { SERVE_STALE_DETAILS_WHERE, SERVE_STALE_RATINGS_WHERE } from "./tmdb-cache";

// The tail purge below reaps every expired TmdbCache row, but the two ratings namespaces
// are a deliberate serve-stale surface: an expired row is still a hit. Give them a long
// grace so a provider outage falls back to the previous values instead of no badges at
// all. `:tmdb:` is load-bearing — bare `mdblist:`/`omdb:` also match the list caches
// (and the legacy `omdb:<imdbId>` rows, whose writer was removed — they should simply
// expire out).
const STALE_RATINGS_GRACE_MS = 30 * 24 * 60 * 60 * 1000;
// Shared with getCache's lazy delete (tmdb-cache.ts), which skips the same
// namespaces, so the two can't drift.
const STALE_RATINGS_KEY_PREFIXES = SERVE_STALE_RATINGS_WHERE;

// The `:details` blobs are a serve-stale surface too: the admin dashboard reads
// them via getCacheStaleMany and the library prewarm's carry-forward reads the
// previous row at rewrite time — an immediate purge collapses both to cold
// misses within one SYNC_INTERVAL of expiry. A shorter grace than the ratings
// namespaces keeps table growth modest. The endsWith pin keeps every sibling
// namespace (credits, suggestions, seasons, the `:details:missing` prewarm
// tombstones) expiring immediately.
const STALE_DETAILS_GRACE_MS = 7 * 24 * 60 * 60 * 1000;
const STALE_DETAILS_KEY_SHAPES = SERVE_STALE_DETAILS_WHERE;

export async function purgeExpiredTmdbCache(): Promise<void> {
  try {
    // The ratings namespaces AND the :details blobs are read through
    // getCacheStale/getCacheStaleMany, which deliberately never delete an expired
    // row — an expired row is still a HIT, served immediately and revalidated
    // after the response. This purge was the only thing deleting them, within one
    // SYNC_INTERVAL of expiry, collapsing those serve-stale windows to under an
    // hour and turning a stale hit into a cold miss for the rest of the row's
    // life. Reap each namespace on its own grace instead. The ratings prefixes
    // must carry `:tmdb:`: bare `mdblist:`/`omdb:` also match the list caches,
    // which should still expire immediately.
    await prisma.tmdbCache.deleteMany({
      // `NOT: { OR: [...] }`, not a bare `NOT: [...]`: the shapes are mutually
      // exclusive, so if a list-NOT compiled to NOT(a AND b) the exclusion would be
      // a silent no-op. The nested form is unambiguously "none of these shapes".
      where: {
        expiresAt: { lt: new Date() },
        NOT: { OR: [...STALE_RATINGS_KEY_PREFIXES, ...STALE_DETAILS_KEY_SHAPES] },
      },
    });
    await prisma.tmdbCache.deleteMany({
      where: {
        expiresAt: { lt: new Date(Date.now() - STALE_RATINGS_GRACE_MS) },
        OR: STALE_RATINGS_KEY_PREFIXES,
      },
    });
    await prisma.tmdbCache.deleteMany({
      where: {
        expiresAt: { lt: new Date(Date.now() - STALE_DETAILS_GRACE_MS) },
        OR: STALE_DETAILS_KEY_SHAPES,
      },
    });
  } catch (err) {
    console.error("[sync] TMDB cache purge failed:", err);
  }
}
