// The read-through cache behind every memoized play-history aggregate, its
// generation guard (guardrail 19b), and the /popular cache that the same
// invalidation flushes.
import { processSingleton } from "./process-singleton";
import { coalesce } from "./concurrency";
import type { PopularRanking } from "./play-history-popular";

// Process-wide (see process-singleton.ts): this module is compiled into the
// route chunks that FINALIZE sessions and delete history (and call
// clearActivityCache) and separately into the page chunks that READ the stats.
// A per-chunk Map meant the invalidation never reached the admin pages, which
// kept serving pre-finalize/pre-delete aggregates for the full TTL.
const activityCache = processSingleton(
  "play-history:activityCache",
  () => new Map<string, { data: unknown; expiresAt: number }>(),
);
// Bumped by every clearActivityCache(). A computation reads it BEFORE it starts
// and stores its result only if no clear landed meanwhile. Without it, a stats
// fan-out that began before a session finalized finished AFTER the clear and
// re-cached the pre-finalize numbers for the whole TTL, silently undoing the
// invalidation. Process-wide for the same reason as the cache itself.
const activityCacheGeneration = processSingleton(
  "play-history:activityCacheGeneration",
  () => ({ n: 0 }),
);
export const STATS_TTL = 5 * 60 * 1000;
export const CALENDAR_TTL = 30 * 60 * 1000;
export const REWATCHED_TTL = 10 * 60 * 1000;

// The /popular rankings, one per (mediaType, sort) — so at most nine entries.
// Process-wide for the same reason as activityCache — clearActivityCache flushes it.
export const popularCache = processSingleton(
  "play-history:popularRankings",
  () => new Map<string, { data: PopularRanking; expiresAt: number }>(),
);

// Each part is NAME-tagged, not positional. Absent params were simply skipped, so the
// key was an unlabelled join and two different filter sets could produce the same one:
// `?source=MOVIE` is not a valid source, so appendPlayHistoryFilter ignores it and the
// query runs UNFILTERED — but the value still entered the key, colliding with a
// legitimate `?mediaType=MOVIE`. The unfiltered series was then served as the
// movies-only one (and vice versa) for the whole TTL.
export function getCacheKey(prefix: string, params: Record<string, unknown>): string {
  const parts = [prefix];
  if (params.days) parts.push(`d=${String(params.days)}`);
  if (params.source) parts.push(`s=${String(params.source)}`);
  if (params.mediaType) parts.push(`m=${String(params.mediaType)}`);
  if (params.limit) parts.push(`n=${String(params.limit)}`);
  // Every aggregate that buckets by hour or day passes the statistics zone.
  if (params.zone) parts.push(`z=${String(params.zone)}`);
  return parts.join(":");
}

function getCached<T>(key: string): T | null {
  const entry = activityCache.get(key);
  if (!entry) return null;
  if (entry.expiresAt <= Date.now()) {
    activityCache.delete(key);
    return null;
  }
  return entry.data as T;
}

// Bound the cache: heatmap-cell keys embed arbitrary userId/day/dow/hour combos,
// so distinct keys are effectively unbounded and getCached only evicts a key when
// it is re-accessed after expiry. Cap the map so a long-lived process can't grow it
// without bound — sweep expired entries first, then evict oldest-inserted (Map keeps
// insertion order) until under the cap.
const ACTIVITY_CACHE_MAX = 500;

// `generation` is activityCacheGeneration.n as read BEFORE the data was computed
// (activityGeneration()). A clear since then means the data may predate a write
// the clear was meant to surface, so it is returned to the caller but not stored.
function setCached<T>(key: string, data: T, ttlMs: number, generation: number): void {
  if (generation !== activityCacheGeneration.n) return;
  if (activityCache.size >= ACTIVITY_CACHE_MAX && !activityCache.has(key)) {
    const now = Date.now();
    for (const [k, v] of activityCache) {
      if (v.expiresAt <= now) activityCache.delete(k);
    }
    while (activityCache.size >= ACTIVITY_CACHE_MAX) {
      const oldest = activityCache.keys().next().value;
      if (oldest === undefined) break;
      activityCache.delete(oldest);
    }
  }
  activityCache.set(key, { data, expiresAt: Date.now() + ttlMs });
}

export function activityGeneration(): number {
  return activityCacheGeneration.n;
}

// The current activity-cache generation, for a cache that lives OUTSIDE this
// module but is fed by the same PlayHistory rows (the never-watched report):
// it compares generations instead of being cleared, so a finalize still drops it.
export function currentActivityGeneration(): number {
  return activityGeneration();
}

// Read-through for the memoized aggregates. Concurrent cold loads of one key —
// two admins, the iOS app, the warm cron — share ONE computation instead of each
// running the full fan-out on the five-connection pool (guardrail 31). The
// coalesce key carries the generation, so a request arriving after a clear
// starts a fresh computation rather than joining one that predates the clear.
export function memoizeActivity<T>(key: string, ttlMs: number, compute: () => Promise<T>): Promise<T> {
  const cached = getCached<T>(key);
  if (cached) return Promise.resolve(cached);
  const generation = activityGeneration();
  return coalesce(`play-history:${generation}:${key}`, async () => {
    const result = await compute();
    setCached(key, result, ttlMs, generation);
    return result;
  });
}

export function clearActivityCache(): void {
  activityCacheGeneration.n++;
  activityCache.clear();
  // popularCache has its own 5-min TTL but is fed by the same PlayHistory rows. Without
  // flushing it here a freshly-finalized session can take up to 5 minutes to surface on
  // /popular, and deletions take 5 minutes to drop a title out.
  popularCache.clear();
}
