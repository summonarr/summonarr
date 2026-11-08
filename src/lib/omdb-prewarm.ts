import "server-only";
import { prisma } from "./prisma";
import { fetchAndCacheOmdbForTmdb, isOmdbQuotaLocked, omdbCacheKey, type OmdbResult } from "./omdb";
import { collectAllLibraryItems, LIBRARY_PAGE_SIZE } from "./library-iterator";
import { tmdbDetailsKey } from "./tmdb-cache";
import { readDetailsReleaseDates } from "./details-release-dates";

const CONCURRENCY = 5;
const BATCH_DELAY_MS = 250;

const MAX_PREWARM_ITEMS = 200_000;

const typeOf = (i: { mediaType: "MOVIE" | "TV" }): "movie" | "tv" => (i.mediaType === "MOVIE" ? "movie" : "tv");

export interface OmdbPrewarmResult {
  total: number;
  fetched: number;
  // Authoritative misses only (TMDB has no IMDb id / OMDB knows no such title):
  // these were negative-cached. A transient failure NEVER lands here — see `failed`.
  notFound: number;
  skipped: number;
  // Rejected chains PLUS fulfilled `{ found: false, transient: true }` results,
  // `tmdbUnconfigured` misses (no TMDB token — nothing fetched or cached) and
  // `keyConfigured: false` misses (the OMDb key removed mid-run).
  // fetchAndCacheOmdbForTmdb turns every network/5xx/401/quota failure into a
  // transient miss instead of throwing, so this counter is the only way the cron
  // history (`recordCronRun(..., failed === 0)`) shows a bad key or an outage.
  failed: number;
  // Set when the in-process OMDB quota lockout cut the run short (mirrors
  // mdblist-prewarm); the unattempted items appear in no counter.
  quotaExhausted?: boolean;
}

// A configuration problem every remaining item would hit the same way: OMDb
// refused the key, no TMDB token to resolve IMDb ids, or the OMDb key removed
// mid-run. Null for an outcome that says nothing about the next item.
type ConfigStop = "keyRejected" | "tmdbUnconfigured" | "keyRemoved";

function configStopOf(r: PromiseSettledResult<OmdbResult>): ConfigStop | null {
  if (r.status !== "fulfilled" || r.value.found) return null;
  if (r.value.keyRejected) return "keyRejected";
  if (r.value.tmdbUnconfigured) return "tmdbUnconfigured";
  if (!r.value.keyConfigured) return "keyRemoved";
  return null;
}

const CONFIG_STOP_TEXT: Record<ConfigStop, string> = {
  keyRejected: "OMDb refused the API key",
  tmdbUnconfigured: "there is no TMDB read token to resolve IMDb ids with",
  keyRemoved: "the OMDb API key was removed",
};

// The counter each result lands in. A fulfilled promise can still be a
// {found:false} miss. Only a real rating is fetched, and misses split on
// `transient`: fetchAndCacheOmdbForTmdb RESOLVES (does not throw) with
// transient:true on network/timeout/5xx/bad-key/quota failures. Counting those
// as notFound would let a fully failed run (failed === 0) show as green in the
// cron history. Only an authoritative miss (negative-cached upstream) is
// notFound. Pure.
function outcomeOf(r: PromiseSettledResult<OmdbResult>): "fetched" | "notFound" | "failed" {
  if (r.status !== "fulfilled") return "failed";
  if (r.value.found) return "fetched";
  // omdb.ts already logged the per-item cause of a transient miss.
  if (r.value.transient) return "failed";
  // No TMDB token: nothing was fetched or negative-cached, so it is not an
  // authoritative miss — count it failed so the misconfiguration shows up.
  if (r.value.tmdbUnconfigured) return "failed";
  // No OMDb key (removed mid-run): nothing was asked, nothing cached.
  if (!r.value.keyConfigured) return "failed";
  return "notFound";
}

// Which OMDB rows are still fresh (more than 25% of their TTL left — the same
// rule as the other prewarms), and the IMDb ids already stored on the rows this
// pass will refresh. A title's TMDB→IMDb id never really changes, so reusing it
// skips one TMDB call per item. `data` comes along in the same freshness read
// (OMDB rows are tiny) rather than in a second query for the stale keys.
async function readOmdbRowState(keys: string[]): Promise<{ freshKeys: Set<string>; imdbIdByKey: Map<string, string> }> {
  const freshKeys = new Set<string>();
  const imdbIdByKey = new Map<string, string>();
  for (let i = 0; i < keys.length; i += LIBRARY_PAGE_SIZE) {
    const existingRows = await prisma.tmdbCache.findMany({
      where: { key: { in: keys.slice(i, i + LIBRARY_PAGE_SIZE) } },
      select: { key: true, cachedAt: true, expiresAt: true, data: true },
    });
    for (const r of existingRows) {
      const originalTtlMs = r.expiresAt.getTime() - r.cachedAt.getTime();
      if (r.expiresAt.getTime() - Date.now() > originalTtlMs * 0.25) {
        freshKeys.add(r.key);
        continue;
      }
      try {
        const parsed: unknown = JSON.parse(r.data);
        const imdbId = parsed && typeof parsed === "object" ? (parsed as { imdbId?: unknown }).imdbId : undefined;
        if (typeof imdbId === "string" && imdbId) imdbIdByKey.set(r.key, imdbId);
      } catch {
        // Unparseable row — the refresh resolves the id live as before.
      }
    }
  }
  return { freshKeys, imdbIdByKey };
}

// Refreshes the OMDB ratings cache for every library item, skipping rows still
// within 25% of their TTL and re-fetching the rest in throttled concurrent batches.
export async function prewarmOmdbCache(opts: { signal?: AbortSignal } = {}): Promise<OmdbPrewarmResult> {
  if (isOmdbQuotaLocked()) {
    console.warn("[omdb-prewarm] OMDB quota locked — aborting before any calls");
    return { total: 0, fetched: 0, notFound: 0, skipped: 0, failed: 0, quotaExhausted: true };
  }

  const apiKey = await prisma.setting.findUnique({ where: { key: "omdbApiKey" } });
  // Trimmed, as omdb.ts's getApiKey and the cron route read it: a blank key is
  // no key, not thousands of "not found" titles.
  if (!apiKey?.value.trim()) {
    return { total: 0, fetched: 0, notFound: 0, skipped: 0, failed: 0 };
  }

  const items = await collectAllLibraryItems(MAX_PREWARM_ITEMS);
  if (items.length >= MAX_PREWARM_ITEMS) {
    console.warn(`[omdb-prewarm] Reached MAX_PREWARM_ITEMS (${MAX_PREWARM_ITEMS}) — library scan truncated`);
  }
  if (items.length === 0) {
    return { total: 0, fetched: 0, notFound: 0, skipped: 0, failed: 0 };
  }

  const { freshKeys, imdbIdByKey } = await readOmdbRowState(items.map((i) => omdbCacheKey(typeOf(i), i.tmdbId)));
  const toFetch = items.filter((i) => !freshKeys.has(omdbCacheKey(typeOf(i), i.tmdbId)));

  const skipped = items.length - toFetch.length;

  const releaseDateByKey = await readDetailsReleaseDates(toFetch.map((i) => tmdbDetailsKey(i.mediaType, i.tmdbId)));

  let fetched = 0;
  let notFound = 0;
  let failed = 0;
  let quotaHit = false;

  for (let i = 0; i < toFetch.length; i += CONCURRENCY) {
    // withAdvisoryLock aborts at DEFAULT_WORK_TIMEOUT_MS and RELEASES the lock,
    // but it cannot kill a promise — so a pass that ignores this signal keeps
    // running lock-free, and the cron's own retry starts another one alongside
    // it. Observed live: OMDB timing out at 10s/request made this walk ~6h long,
    // and stacked orphans starved the 5-connection Prisma pool into
    // "Unable to start a transaction in the given time".
    //
    // RETURN rather than throw: withAdvisoryLock's Promise.race has already
    // settled on the timeout rejection, so a throw here would surface as an
    // unhandled rejection. The partial stats are discarded by the race; stopping
    // is the whole point.
    if (opts.signal?.aborted) {
      console.warn(`[omdb-prewarm] aborted after ${fetched} fetches — the advisory lock timed out`);
      break;
    }
    if (isOmdbQuotaLocked()) {
      console.warn(`[omdb-prewarm] Quota exhausted after ${fetched} fetches — stopping early`);
      quotaHit = true;
      break;
    }

    const batch = toFetch.slice(i, i + CONCURRENCY);
    const results = await Promise.allSettled(
      batch.map((item) => {
        const type = typeOf(item);
        const releaseDate = releaseDateByKey.get(tmdbDetailsKey(type, item.tmdbId)) ?? null;
        // Force-fetch rather than getOmdbRatingsForTmdb: that getter is cache-first and
        // serves any UNEXPIRED row warm, so every row in the 0-25%-remaining band this
        // pass exists to renew would be "refreshed" with no upstream call at all (and
        // still counted as fetched below). Mirrors mdblist-prewarm/tmdb-prewarm, which
        // both call their fetch-and-store entry point directly. The stored imdbId (when
        // the prior row had one) skips the TMDB external_ids resolve per item.
        return fetchAndCacheOmdbForTmdb(item.tmdbId, type, releaseDate, imdbIdByKey.get(omdbCacheKey(type, item.tmdbId)) ?? null);
      })
    );
    for (const r of results) {
      const outcome = outcomeOf(r);
      if (outcome === "fetched") fetched++;
      else if (outcome === "notFound") notFound++;
      else failed++;
      if (r.status === "rejected") console.warn("[omdb-prewarm] item failed:", r.reason);
    }
    // A whole batch failing for one configuration reason means every item left
    // would fail the same way, each with no request at all: stop instead of
    // walking (and sleeping through) the rest of the library under the lock.
    // The items not asked count failed, as they would have.
    const stop = configStopOf(results[0]);
    if (stop && results.every((r) => configStopOf(r) === stop)) {
      const rest = toFetch.length - (i + batch.length);
      failed += rest;
      console.warn(`[omdb-prewarm] ${CONFIG_STOP_TEXT[stop]} — stopping; ${rest} item(s) not asked`);
      break;
    }
    if (isOmdbQuotaLocked()) {
      console.warn(`[omdb-prewarm] Quota hit mid-batch after ${fetched} fetches — stopping early`);
      quotaHit = true;
      break;
    }
    if (i + CONCURRENCY < toFetch.length) {
      await new Promise((resolve) => setTimeout(resolve, BATCH_DELAY_MS));
    }
  }

  return { total: items.length, fetched, notFound, skipped, failed, ...(quotaHit ? { quotaExhausted: true } : {}) };
}
