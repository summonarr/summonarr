import "server-only";
import { prisma } from "./prisma";
import { checkMdblistPause, fetchMdblistBatch, mdblistCacheKey, mdblistPause, newMdblistBatchBreaker } from "./mdblist";
import { collectAllLibraryItems, LIBRARY_PAGE_SIZE } from "./library-iterator";
import { tmdbDetailsKey } from "./tmdb-cache";
import { readDetailsReleaseDates } from "./details-release-dates";

// Titles per MDBList batch request.
const BATCH_SIZE = 200;

const BACKGROUND = { background: true } as const;

// Safety cap on how many library titles one run will look at.
const MAX_PREWARM_ITEMS = 200_000;

// The exact stored text of a "not found" cache row (see NOT_FOUND_SENTINEL in mdblist.ts).
const NOT_FOUND_DATA = JSON.stringify({ _notFound: true });

const typeOf = (i: { mediaType: "MOVIE" | "TV" }): "movie" | "tv" => (i.mediaType === "MOVIE" ? "movie" : "tv");

// Refreshes MDBList ratings cache for every library item, purging stale/NOT_FOUND
// rows and re-fetching in interleaved movie/TV batch pages, stopping early on quota.
export async function prewarmMdblistCache(opts: { force?: boolean; signal?: AbortSignal } = {}): Promise<{
  total: number;
  fetched: number;
  skipped: number;
  failed: number;
  purged: number;
  quotaExhausted?: boolean;
}> {
  const force = opts.force ?? false;

  // A background job: it stops at the reserve the plan setting keeps for pages.
  const startPause = await checkMdblistPause(BACKGROUND);
  if (startPause) {
    console.warn(startPause === "locked"
      ? "[mdblist-prewarm] MDBList quota locked — aborting before any calls"
      : "[mdblist-prewarm] MDBList's daily budget for background jobs is used up — aborting before any calls");
    return { total: 0, fetched: 0, skipped: 0, failed: 0, purged: 0, quotaExhausted: true };
  }

  const apiKey = await prisma.setting.findUnique({ where: { key: "mdblistApiKey" } });
  // Trimmed, as mdblist.ts reads it: a blank key is no key.
  if (!apiKey?.value.trim()) {
    return { total: 0, fetched: 0, skipped: 0, failed: 0, purged: 0 };
  }

  const items = await collectAllLibraryItems(MAX_PREWARM_ITEMS);
  if (items.length >= MAX_PREWARM_ITEMS) {
    console.warn(`[mdblist-prewarm] Reached MAX_PREWARM_ITEMS (${MAX_PREWARM_ITEMS}) — library scan truncated`);
  }
  if (items.length === 0) {
    return { total: 0, fetched: 0, skipped: 0, failed: 0, purged: 0 };
  }

  let purged = 0;
  const mdblistKeys = items.map((i) => mdblistCacheKey(typeOf(i), i.tmdbId));
  for (let i = 0; i < mdblistKeys.length; i += LIBRARY_PAGE_SIZE) {
    const slice = mdblistKeys.slice(i, i + LIBRARY_PAGE_SIZE);
    // Only "not found" markers are deleted here, so those titles get a fresh try.
    // Valid rows are never deleted, even with force=true: the refetch below can
    // stop early (quota, upstream outage), and deleting first would leave every
    // title it didn't reach with no ratings at all. Instead, force skips the
    // freshness check below and each row is overwritten in place.
    const where = { key: { in: slice }, data: NOT_FOUND_DATA };
    const { count } = await prisma.tmdbCache.deleteMany({ where });
    purged += count;
  }

  const freshKeys = new Set<string>();
  if (!force) {
    for (let i = 0; i < mdblistKeys.length; i += LIBRARY_PAGE_SIZE) {
      const slice = mdblistKeys.slice(i, i + LIBRARY_PAGE_SIZE);
      const existingRows = await prisma.tmdbCache.findMany({
        where: { key: { in: slice } },
        select: { key: true, cachedAt: true, expiresAt: true },
      });
      // Same 25% remaining-TTL threshold used across all prewarm passes
      for (const r of existingRows) {
        const originalTtlMs = r.expiresAt.getTime() - r.cachedAt.getTime();
        if (r.expiresAt.getTime() - Date.now() > originalTtlMs * 0.25) freshKeys.add(r.key);
      }
    }
  }

  const toFetch = force ? items : items.filter((i) => !freshKeys.has(mdblistCacheKey(typeOf(i), i.tmdbId)));

  const skipped = items.length - toFetch.length;

  const releaseDateByKey = await readDetailsReleaseDates(toFetch.map((i) => tmdbDetailsKey(i.mediaType, i.tmdbId)));

  let fetched = 0;
  let failed = 0;
  let quotaHit = false;

  const movieItems = toFetch
    .filter((i) => i.mediaType === "MOVIE")
    .map((i) => ({ id: i.tmdbId, releaseDate: releaseDateByKey.get(tmdbDetailsKey("movie", i.tmdbId)) ?? null }));
  const tvItems = toFetch
    .filter((i) => i.mediaType === "TV")
    .map((i) => ({ id: i.tmdbId, releaseDate: releaseDateByKey.get(tmdbDetailsKey("tv", i.tmdbId)) ?? null }));

  // Interleave movie and TV batch pages so quota is spread evenly rather than exhausted on movies first
  const moviePages = Math.ceil(movieItems.length / BATCH_SIZE);
  const tvPages    = Math.ceil(tvItems.length    / BATCH_SIZE);
  const totalPages = Math.max(moviePages, tvPages);

  // One failure breaker per media type for the whole run. fetchMdblistBatch's own
  // breaker lives for one call, and each call here is one page, so it could
  // never trip: a persistent 5xx (or an invalid key answering 200-with-error)
  // would cost a request per page to the end of the library. A type whose
  // breaker tripped sends nothing more; the other carries on.
  const breakers = { movie: newMdblistBatchBreaker(), tv: newMdblistBatchBreaker() };

  for (let page = 0; page < totalPages; page++) {
    // Stop when the advisory lock times out: withAdvisoryLock has already released
    // the lock, so carrying on would run unprotected (guardrail 41).
    if (opts.signal?.aborted) {
      console.warn(`[mdblist-prewarm] aborted after ${fetched} fetches — the advisory lock timed out`);
      break;
    }
    const pageStart = mdblistPause(BACKGROUND);
    if (pageStart) {
      quotaHit = true;
      console.warn(pageStart === "locked"
        ? `[mdblist-prewarm] Quota exhausted after ${fetched} fetches — stopping early`
        : `[mdblist-prewarm] Daily budget for background jobs used up after ${fetched} fetches — stopping early`);
      break;
    }

    const moviePage = breakers.movie.tripped ? [] : movieItems.slice(page * BATCH_SIZE, (page + 1) * BATCH_SIZE);
    const tvPage    = breakers.tv.tripped    ? [] : tvItems.slice(page    * BATCH_SIZE, (page + 1) * BATCH_SIZE);
    if (moviePage.length === 0 && tvPage.length === 0) {
      // Only a tripped breaker can empty both before the last page.
      console.warn(`[mdblist-prewarm] MDBList kept failing — stopping after ${fetched} fetches`);
      break;
    }

    const [movieResults, tvResults] = await Promise.allSettled([
      moviePage.length > 0 ? fetchMdblistBatch(moviePage, "movie", { ...BACKGROUND, breaker: breakers.movie }) : Promise.resolve(new Map()),
      tvPage.length    > 0 ? fetchMdblistBatch(tvPage,    "tv",    { ...BACKGROUND, breaker: breakers.tv }) : Promise.resolve(new Map()),
    ]);

    if (movieResults.status === "fulfilled") {
      fetched += movieResults.value.size;
    } else {
      failed += moviePage.length;
      console.warn("[mdblist-prewarm] movie batch failed:", movieResults.reason);
    }

    if (tvResults.status === "fulfilled") {
      fetched += tvResults.value.size;
    } else {
      failed += tvPage.length;
      console.warn("[mdblist-prewarm] tv batch failed:", tvResults.reason);
    }

    const pageEnd = mdblistPause(BACKGROUND);
    if (pageEnd) {
      quotaHit = true;
      console.warn(pageEnd === "locked"
        ? `[mdblist-prewarm] Quota hit mid-batch after ${fetched} fetches — stopping early`
        : `[mdblist-prewarm] Daily budget for background jobs used up mid-batch after ${fetched} fetches — stopping early`);
      break;
    }
  }

  return { total: items.length, fetched, skipped, failed, purged, quotaExhausted: quotaHit || undefined };
}
