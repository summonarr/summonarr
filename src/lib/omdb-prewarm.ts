import "server-only";
import { prisma } from "./prisma";
import { fetchAndCacheOmdbForTmdb, isOmdbQuotaLocked } from "./omdb";
import { collectAllLibraryItems, LIBRARY_PAGE_SIZE } from "./library-iterator";

const CONCURRENCY = 5;
const BATCH_DELAY_MS = 250;

const MAX_PREWARM_ITEMS = 200_000;

interface DetailsCacheData {
  releaseDate?: string | null;
}

export interface OmdbPrewarmResult {
  total: number;
  fetched: number;
  // Authoritative misses only (TMDB has no IMDb id / OMDB knows no such title):
  // these were negative-cached. A transient failure NEVER lands here — see `failed`.
  notFound: number;
  skipped: number;
  // Rejected chains PLUS fulfilled `{ found: false, transient: true }` results.
  // fetchAndCacheOmdbForTmdb turns every network/5xx/401/quota failure into a
  // transient miss instead of throwing, so this counter is the only way the cron
  // history (`recordCronRun(..., failed === 0)`) shows a bad key or an outage.
  failed: number;
  // Set when the in-process OMDB quota lockout cut the run short (mirrors
  // mdblist-prewarm); the unattempted items appear in no counter.
  quotaExhausted?: boolean;
}

// Refreshes the OMDB ratings cache for every library item, skipping rows still
// within 25% of their TTL and re-fetching the rest in throttled concurrent batches.
export async function prewarmOmdbCache(opts: { signal?: AbortSignal } = {}): Promise<OmdbPrewarmResult> {
  if (isOmdbQuotaLocked()) {
    console.warn("[omdb-prewarm] OMDB quota locked — aborting before any calls");
    return { total: 0, fetched: 0, notFound: 0, skipped: 0, failed: 0, quotaExhausted: true };
  }

  const apiKey = await prisma.setting.findUnique({ where: { key: "omdbApiKey" } });
  if (!apiKey?.value) {
    return { total: 0, fetched: 0, notFound: 0, skipped: 0, failed: 0 };
  }

  const items = await collectAllLibraryItems(MAX_PREWARM_ITEMS);
  if (items.length >= MAX_PREWARM_ITEMS) {
    console.warn(`[omdb-prewarm] Reached MAX_PREWARM_ITEMS (${MAX_PREWARM_ITEMS}) — library scan truncated`);
  }
  if (items.length === 0) {
    return { total: 0, fetched: 0, notFound: 0, skipped: 0, failed: 0 };
  }

  const freshKeys = new Set<string>();
  // IMDb ids already stored on the rows this pass will refresh. A title's
  // TMDB→IMDb id never really changes, so reusing it skips one TMDB call per
  // item. `data` comes along in the same freshness read (OMDB rows are tiny).
  const imdbIdByKey = new Map<string, string>();
  const omdbKeys = items.map((i) => `omdb:tmdb:${i.mediaType === "MOVIE" ? "movie" : "tv"}:${i.tmdbId}`);
  for (let i = 0; i < omdbKeys.length; i += LIBRARY_PAGE_SIZE) {
    const slice = omdbKeys.slice(i, i + LIBRARY_PAGE_SIZE);
    const existingRows = await prisma.tmdbCache.findMany({
      where: { key: { in: slice } },
      select: { key: true, cachedAt: true, expiresAt: true, data: true },
    });
    for (const r of existingRows) {
      // "Fresh enough" = more than 25% of the row's TTL left (same rule as the other prewarms)
      const originalTtlMs = r.expiresAt.getTime() - r.cachedAt.getTime();
      if (r.expiresAt.getTime() - Date.now() > originalTtlMs * 0.25) {
        freshKeys.add(r.key);
        continue;
      }
      try {
        const parsed = JSON.parse(r.data) as { imdbId?: unknown };
        if (typeof parsed?.imdbId === "string" && parsed.imdbId) imdbIdByKey.set(r.key, parsed.imdbId);
      } catch {
        // Unparseable row — the refresh below resolves the id live as before.
      }
    }
  }

  const toFetch = items.filter((i) => {
    const key = `omdb:tmdb:${i.mediaType === "MOVIE" ? "movie" : "tv"}:${i.tmdbId}`;
    return !freshKeys.has(key);
  });

  const skipped = items.length - toFetch.length;

  const releaseDateByKey = new Map<string, string | null>();
  const detailKeys = toFetch.map((i) => `${i.mediaType === "MOVIE" ? "movie" : "tv"}:${i.tmdbId}:details`);
  for (let i = 0; i < detailKeys.length; i += LIBRARY_PAGE_SIZE) {
    const slice = detailKeys.slice(i, i + LIBRARY_PAGE_SIZE);
    const detailRows = await prisma.tmdbCache.findMany({
      where: { key: { in: slice } },
      select: { key: true, data: true },
    });
    for (const row of detailRows) {
      try {
        const parsed = JSON.parse(row.data) as DetailsCacheData;
        releaseDateByKey.set(row.key, parsed.releaseDate ?? null);
      } catch {
        releaseDateByKey.set(row.key, null);
      }
    }
  }

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
        const type = item.mediaType === "MOVIE" ? "movie" : "tv";
        const key = `omdb:tmdb:${type}:${item.tmdbId}`;
        const releaseDate = releaseDateByKey.get(`${type}:${item.tmdbId}:details`) ?? null;
        // Force-fetch rather than getOmdbRatingsForTmdb: that getter is cache-first and
        // serves any UNEXPIRED row warm, so every row in the 0-25%-remaining band this
        // pass exists to renew would be "refreshed" with no upstream call at all (and
        // still counted as fetched below). Mirrors mdblist-prewarm/tmdb-prewarm, which
        // both call their fetch-and-store entry point directly. The stored imdbId (when
        // the prior row had one) skips the TMDB external_ids resolve per item.
        return fetchAndCacheOmdbForTmdb(item.tmdbId, type, key, releaseDate, imdbIdByKey.get(key) ?? null);
      })
    );
    for (const r of results) {
      // A fulfilled promise can still be a {found:false} miss. Count only a real
      // rating as fetched, and split misses on `transient`: fetchAndCacheOmdbForTmdb
      // RESOLVES (does not throw) with transient:true on network/timeout/5xx/bad-key/
      // quota failures. Counting those as notFound would let a fully failed run
      // (failed === 0) show as green in the cron history. Only an authoritative
      // miss (negative-cached upstream) is notFound.
      if (r.status === "fulfilled") {
        if (r.value.found) fetched++;
        else if (r.value.transient) failed++; // omdb.ts already logged the per-item cause
        else notFound++;
      } else { failed++; console.warn("[omdb-prewarm] item failed:", r.reason); }
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
