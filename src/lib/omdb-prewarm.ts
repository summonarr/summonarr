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
  // fetchAndCacheOmdbForTmdb swallows every network/5xx/401/quota failure into a
  // transient miss, so this counter is the only thing that lets the cron ledger
  // (`recordCronRun(..., failed === 0)`) turn red on a bad key or an outage.
  failed: number;
  // Set when the in-process OMDB quota lockout cut the run short (mirrors
  // mdblist-prewarm); the unattempted items appear in no counter.
  quotaExhausted?: boolean;
}

// Refreshes the OMDB ratings cache for every library item, skipping rows still
// within 25% of their TTL and re-fetching the rest in throttled concurrent batches.
export async function prewarmOmdbCache(): Promise<OmdbPrewarmResult> {
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
  // Stored imdbIds from the rows this pass is about to refresh: the tmdb→imdb
  // mapping is effectively immutable, so re-buying it from TMDB for a row that
  // already carries the id doubled the run's upstream call count. `data` rides
  // along in the existing freshness read (omdb rows are a handful of bytes).
  const imdbIdByKey = new Map<string, string>();
  const omdbKeys = items.map((i) => `omdb:tmdb:${i.mediaType === "MOVIE" ? "movie" : "tv"}:${i.tmdbId}`);
  for (let i = 0; i < omdbKeys.length; i += LIBRARY_PAGE_SIZE) {
    const slice = omdbKeys.slice(i, i + LIBRARY_PAGE_SIZE);
    const existingRows = await prisma.tmdbCache.findMany({
      where: { key: { in: slice } },
      select: { key: true, cachedAt: true, expiresAt: true, data: true },
    });
    for (const r of existingRows) {
      // Same 25% remaining-TTL threshold used by tmdb-prewarm to decide whether a row is "fresh enough"
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
      // A fulfilled promise can still be a {found:false} miss. Count only an
      // actual rating hit as fetched, and split the misses on `transient`:
      // fetchAndCacheOmdbForTmdb catches every network/timeout/5xx/401
      // "Invalid API key"/quota failure and RESOLVES with transient:true (its
      // only remaining rejection is the getApiKey read before its try), so a
      // run against a rotated-bad key or an OMDB/TMDB outage used to settle
      // every item as notFound with failed=0 — and the cron ledger, which
      // derives ok from `failed === 0`, recorded the fully-failed run green.
      // Only an authoritative miss (negative-cached upstream) is notFound.
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
