import "server-only";
import { prisma } from "./prisma";
import { fetchMdblistBatch, isMdblistQuotaLocked } from "./mdblist";
import { collectAllLibraryItems, LIBRARY_PAGE_SIZE } from "./library-iterator";

const BATCH_SIZE = 200;

const MAX_PREWARM_ITEMS = 200_000;

const NOT_FOUND_DATA = JSON.stringify({ _notFound: true });

interface DetailsCacheData {
  releaseDate?: string | null;
}

export async function prewarmMdblistCache(opts: { force?: boolean } = {}): Promise<{
  total: number;
  fetched: number;
  skipped: number;
  failed: number;
  purged: number;
  quotaExhausted?: boolean;
}> {
  const force = opts.force ?? false;

  if (isMdblistQuotaLocked()) {
    console.warn("[mdblist-prewarm] MDBList quota locked — aborting before any calls");
    return { total: 0, fetched: 0, skipped: 0, failed: 0, purged: 0, quotaExhausted: true };
  }

  const apiKey = await prisma.setting.findUnique({ where: { key: "mdblistApiKey" } });
  if (!apiKey?.value) {
    console.log("[mdblist-prewarm] No MDBList API key configured — skipping");
    return { total: 0, fetched: 0, skipped: 0, failed: 0, purged: 0 };
  }

  const items = await collectAllLibraryItems(MAX_PREWARM_ITEMS);
  if (items.length >= MAX_PREWARM_ITEMS) {
    console.warn(`[mdblist-prewarm] Reached MAX_PREWARM_ITEMS (${MAX_PREWARM_ITEMS}) — library scan truncated`);
  }
  if (items.length === 0) {
    console.log("[mdblist-prewarm] No library items found — skipping");
    return { total: 0, fetched: 0, skipped: 0, failed: 0, purged: 0 };
  }

  let purged = 0;
  const mdblistKeys = items.map((i) => `mdblist:tmdb:${i.mediaType === "MOVIE" ? "movie" : "tv"}:${i.tmdbId}`);
  for (let i = 0; i < mdblistKeys.length; i += LIBRARY_PAGE_SIZE) {
    const slice = mdblistKeys.slice(i, i + LIBRARY_PAGE_SIZE);
      // By default only delete NOT_FOUND sentinels so they get a fresh chance on the next batch;
    // force=true also clears valid cached entries to trigger a full re-fetch.
    const where = force
      ? { key: { in: slice } }
      : { key: { in: slice }, data: NOT_FOUND_DATA };
    const { count } = await prisma.tmdbCache.deleteMany({ where });
    purged += count;
  }
  if (purged > 0) {
    console.log(`[mdblist-prewarm] Purged ${purged} stale/sentinel cache entries`);
  }

  const freshKeys = new Set<string>();
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

  const toFetch = items.filter((i) => {
    const key = `mdblist:tmdb:${i.mediaType === "MOVIE" ? "movie" : "tv"}:${i.tmdbId}`;
    return !freshKeys.has(key);
  });

  const skipped = items.length - toFetch.length;
  console.log(`[mdblist-prewarm] ${items.length} total — ${skipped} already fresh, fetching ${toFetch.length}…`);

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
  let failed = 0;
  let quotaHit = false;

  const movieItems = toFetch
    .filter((i) => i.mediaType === "MOVIE")
    .map((i) => ({ id: i.tmdbId, releaseDate: releaseDateByKey.get(`movie:${i.tmdbId}:details`) ?? null }));
  const tvItems = toFetch
    .filter((i) => i.mediaType === "TV")
    .map((i) => ({ id: i.tmdbId, releaseDate: releaseDateByKey.get(`tv:${i.tmdbId}:details`) ?? null }));

  // Interleave movie and TV batch pages so quota is spread evenly rather than exhausted on movies first
  const moviePages = Math.ceil(movieItems.length / BATCH_SIZE);
  const tvPages    = Math.ceil(tvItems.length    / BATCH_SIZE);
  const totalPages = Math.max(moviePages, tvPages);

  for (let page = 0; page < totalPages; page++) {
    if (isMdblistQuotaLocked()) {
      quotaHit = true;
      console.warn(`[mdblist-prewarm] Quota exhausted after ${fetched} fetches — stopping early`);
      break;
    }

    const moviePage = movieItems.slice(page * BATCH_SIZE, (page + 1) * BATCH_SIZE);
    const tvPage    = tvItems.slice(page    * BATCH_SIZE, (page + 1) * BATCH_SIZE);

    const [movieResults, tvResults] = await Promise.allSettled([
      moviePage.length > 0 ? fetchMdblistBatch(moviePage, "movie") : Promise.resolve(new Map()),
      tvPage.length    > 0 ? fetchMdblistBatch(tvPage,    "tv")    : Promise.resolve(new Map()),
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

    if (isMdblistQuotaLocked()) {
      quotaHit = true;
      console.warn(`[mdblist-prewarm] Quota hit mid-batch after ${fetched} fetches — stopping early`);
      break;
    }
  }

  console.log(`[mdblist-prewarm] Done — fetched ${fetched}, skipped ${skipped}, failed ${failed}, purged ${purged}${quotaHit ? " (quota exhausted)" : ""} / ${items.length} total`);
  return { total: items.length, fetched, skipped, failed, purged, quotaExhausted: quotaHit || undefined };
}
