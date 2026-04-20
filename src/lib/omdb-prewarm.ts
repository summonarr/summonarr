import "server-only";
import { prisma } from "./prisma";
import { getOmdbRatingsForTmdb } from "./omdb";
import { collectAllLibraryItems, LIBRARY_PAGE_SIZE } from "./library-iterator";

const CONCURRENCY = 5;
const BATCH_DELAY_MS = 250;

const MAX_PREWARM_ITEMS = 200_000;

interface DetailsCacheData {
  releaseDate?: string | null;
}

export async function prewarmOmdbCache(): Promise<{
  total: number;
  fetched: number;
  skipped: number;
  failed: number;
}> {
  const apiKey = await prisma.setting.findUnique({ where: { key: "omdbApiKey" } });
  if (!apiKey?.value) {
    console.log("[omdb-prewarm] No OMDB API key configured — skipping");
    return { total: 0, fetched: 0, skipped: 0, failed: 0 };
  }

  const items = await collectAllLibraryItems(MAX_PREWARM_ITEMS);
  if (items.length >= MAX_PREWARM_ITEMS) {
    console.warn(`[omdb-prewarm] Reached MAX_PREWARM_ITEMS (${MAX_PREWARM_ITEMS}) — library scan truncated`);
  }
  if (items.length === 0) {
    console.log("[omdb-prewarm] No library items found — skipping");
    return { total: 0, fetched: 0, skipped: 0, failed: 0 };
  }

  const freshKeys = new Set<string>();
  const omdbKeys = items.map((i) => `omdb:tmdb:${i.mediaType === "MOVIE" ? "movie" : "tv"}:${i.tmdbId}`);
  for (let i = 0; i < omdbKeys.length; i += LIBRARY_PAGE_SIZE) {
    const slice = omdbKeys.slice(i, i + LIBRARY_PAGE_SIZE);
    const existingRows = await prisma.tmdbCache.findMany({
      where: { key: { in: slice } },
      select: { key: true, cachedAt: true, expiresAt: true },
    });
    for (const r of existingRows) {
      // Same 25% remaining-TTL threshold used by tmdb-prewarm to decide whether a row is "fresh enough"
      const originalTtlMs = r.expiresAt.getTime() - r.cachedAt.getTime();
      if (r.expiresAt.getTime() - Date.now() > originalTtlMs * 0.25) freshKeys.add(r.key);
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
  let failed = 0;

  for (let i = 0; i < toFetch.length; i += CONCURRENCY) {
    const batch = toFetch.slice(i, i + CONCURRENCY);
    const results = await Promise.allSettled(
      batch.map((item) => {
        const type = item.mediaType === "MOVIE" ? "movie" : "tv";
        const releaseDate = releaseDateByKey.get(`${type}:${item.tmdbId}:details`) ?? null;
        return getOmdbRatingsForTmdb(item.tmdbId, type, releaseDate);
      })
    );
    for (const r of results) {
      if (r.status === "fulfilled") fetched++;
      else { failed++; console.warn("[omdb-prewarm] item failed:", r.reason); }
    }
    if (i + CONCURRENCY < toFetch.length) {
      await new Promise((resolve) => setTimeout(resolve, BATCH_DELAY_MS));
    }
  }

  return { total: items.length, fetched, skipped, failed };
}
