import "server-only";
import { prisma } from "./prisma";
import { setCache, libraryDetailsTtl } from "./tmdb-cache";
import { upsertTmdbMediaCore } from "./tmdb-core-sync";
import { safeFetchTrusted, SafeFetchError } from "./safe-fetch";
import { iterateLibrary, LIBRARY_PAGE_SIZE } from "./library-iterator";
import type { LibraryItem } from "./library-iterator";
import { tmdbAuth } from "./tmdb-auth";
import type { TmdbMedia } from "./tmdb-types";

const CONCURRENCY = 5;
const BATCH_DELAY_MS = 250;

const MAX_PREWARM_ITEMS = 200_000;
const TMDB_FETCH_TIMEOUT_MS = 15_000;

const TMDB_BASE = "https://api.themoviedb.org/3";

interface RawSeason {
  season_number: number;
  episode_count: number;
  air_date?: string | null;
  poster_path?: string | null;
  name?: string;
  overview?: string;
}

interface RawItem {
  id: number;
  title?: string;
  name?: string;
  overview?: string;
  poster_path?: string | null;
  backdrop_path?: string | null;
  release_date?: string;
  first_air_date?: string;
  vote_average?: number;
  seasons?: RawSeason[];

  runtime?: number;
  status?: string;
  tagline?: string;
  imdb_id?: string;
  genres?: { id: number; name: string }[];
  production_companies?: { id: number; name: string }[];
  number_of_seasons?: number;
  number_of_episodes?: number;
}

async function fetchAndStore(tmdbId: number, mediaType: "MOVIE" | "TV"): Promise<void> {
  const type = mediaType === "MOVIE" ? "movie" : "tv";
  const auth = tmdbAuth();
  if (!auth) return;

  const url = new URL(`${TMDB_BASE}/${type}/${tmdbId}`);
  for (const [k, v] of Object.entries(auth.query)) url.searchParams.set(k, v);
  if (mediaType === "TV") url.searchParams.set("append_to_response", "seasons");

  let res: Response;
  try {
    // Use safeFetchTrusted instead of Next.js fetch so the request bypasses the Next cache and
    // never gets deduped or revalidated against a stale store entry.
    res = await safeFetchTrusted(url.toString(), {
      allowedHosts: ["api.themoviedb.org"],
      headers: auth.headers,
      timeoutMs: TMDB_FETCH_TIMEOUT_MS,
    });
  } catch (err) {
    if (err instanceof SafeFetchError) {
      console.warn(`[prewarm] TMDB ${type}:${tmdbId} → ${err.reason} (${err.message})`);
      return;
    }
    throw err;
  }
  if (!res.ok) {
    if (res.status !== 404) {
      console.warn(`[prewarm] TMDB ${type}:${tmdbId} → HTTP ${res.status}`);
    }
    return;
  }

  const raw: RawItem = await res.json();
  const rawDate = mediaType === "MOVIE" ? raw.release_date : raw.first_air_date;

  const seasons = mediaType === "TV"
    ? (raw.seasons ?? [])
        .filter((s) => s.season_number > 0 && s.episode_count > 0)
        .map((s) => ({
          seasonNumber: s.season_number,
          episodeCount: s.episode_count,
          airDate: s.air_date ?? null,
          posterPath: s.poster_path ?? null,
          name: s.name ?? `Season ${s.season_number}`,
          overview: s.overview ?? "",
        }))
    : undefined;

  const title = (mediaType === "MOVIE" ? raw.title : raw.name) ?? "";
  const releaseYear = rawDate ? rawDate.substring(0, 4) : "Unknown";
  await setCache(`${type}:${tmdbId}:details`, {
    id: raw.id,
    mediaType: type,
    title,
    overview: raw.overview ?? null,
    posterPath: raw.poster_path ?? null,
    backdropPath: raw.backdrop_path ?? null,
    releaseDate: rawDate ?? null,
    releaseYear,
    voteAverage: raw.vote_average ?? 0,
    ...(seasons !== undefined && { seasons }),

    genres:          raw.genres?.map((g) => g.name) ?? [],
    studios:         raw.production_companies?.map((c) => c.name) ?? [],
    tagline:         raw.tagline ?? null,
    status:          raw.status ?? null,
    imdbId:          raw.imdb_id ?? null,
    runtime:         raw.runtime ?? null,
    numberOfSeasons: raw.number_of_seasons ?? null,
    numberOfEpisodes: raw.number_of_episodes ?? null,
  }, libraryDetailsTtl(rawDate));
  await upsertTmdbMediaCore({
    id: raw.id,
    mediaType: type,
    title,
    overview: raw.overview ?? "",
    posterPath: raw.poster_path ?? null,
    backdropPath: raw.backdrop_path ?? null,
    releaseDate: rawDate ?? null,
    releaseYear,
    voteAverage: raw.vote_average ?? 0,
  });
}

async function processPrewarmPage(
  page: LibraryItem[],
  stats: { fetched: number; backfilled: number; skipped: number; failed: number },
): Promise<void> {
  const cacheKey = (i: LibraryItem) =>
    `${i.mediaType === "MOVIE" ? "movie" : "tv"}:${i.tmdbId}:details`;

  const keys = page.map(cacheKey);
  const cacheRows = await prisma.tmdbCache.findMany({
    where: { key: { in: keys } },
    select: { key: true, cachedAt: true, expiresAt: true },
  });
  const freshKeySet = new Set<string>();
  // "Fresh" means the row still has more than 25% of its original TTL remaining — below that threshold
  // it's cheaper to re-fetch now than risk a cache miss in production during peak traffic.
  for (const r of cacheRows) {
    const originalTtlMs = r.expiresAt.getTime() - r.cachedAt.getTime();
    if (r.expiresAt.getTime() - Date.now() > originalTtlMs * 0.25) freshKeySet.add(r.key);
  }

  const freshItems = page.filter((i) => freshKeySet.has(cacheKey(i)));
  const staleItems = page.filter((i) => !freshKeySet.has(cacheKey(i)));

  if (freshItems.length > 0) {
    const coreRows = await prisma.tmdbMediaCore.findMany({
      where: { OR: freshItems.map((x) => ({ tmdbId: x.tmdbId, mediaType: x.mediaType })) },
      select: { tmdbId: true, mediaType: true },
    });
    const coreSet = new Set(coreRows.map((r) => `${r.tmdbId}:${r.mediaType}`));

    // Items with a fresh TmdbCache entry but no TmdbMediaCore row missed a previous upsert; backfill
    // from the cached JSON rather than making a live TMDB request.
    const toBackfill = freshItems.filter((i) => !coreSet.has(`${i.tmdbId}:${i.mediaType}`));
    stats.skipped += freshItems.length - toBackfill.length;

    if (toBackfill.length > 0) {
      const backfillKeys = toBackfill.map(cacheKey);
      const cachedRows = await prisma.tmdbCache.findMany({
        where: { key: { in: backfillKeys } },
        select: { data: true },
      });
      for (const row of cachedRows) {
        try {
          await upsertTmdbMediaCore(JSON.parse(row.data) as TmdbMedia);
          stats.backfilled++;
        } catch (err) {
          stats.failed++;
          console.warn("[prewarm] TmdbMediaCore backfill from cache failed:", err);
        }
      }
    }
  }

  for (let i = 0; i < staleItems.length; i += CONCURRENCY) {
    const batch = staleItems.slice(i, i + CONCURRENCY);
    const results = await Promise.allSettled(
      batch.map((item) => fetchAndStore(item.tmdbId, item.mediaType)),
    );
    for (const r of results) {
      if (r.status === "fulfilled") stats.fetched++;
      else { stats.failed++; console.warn("[prewarm] item failed:", r.reason); }
    }
    if (i + CONCURRENCY < staleItems.length) {
      await new Promise((resolve) => setTimeout(resolve, BATCH_DELAY_MS));
    }
  }
}

export async function prewarmLibraryCache(): Promise<{ total: number; fetched: number; backfilled: number; skipped: number; failed: number }> {
  if (!tmdbAuth()) {
    console.log("[prewarm] No TMDB credentials set — skipping library cache pre-warm");
    return { total: 0, fetched: 0, backfilled: 0, skipped: 0, failed: 0 };
  }

  const seen = new Set<string>();
  let total = 0;
  const stats = { fetched: 0, backfilled: 0, skipped: 0, failed: 0 };

  const sources = ["plex", "jellyfin"] as const;
  const mediaTypes = ["MOVIE", "TV"] as const;

  let pageBuffer: LibraryItem[] = [];

  const flushPage = async () => {
    if (pageBuffer.length === 0) return;
    await processPrewarmPage(pageBuffer, stats);
    pageBuffer = [];
  };

  outer: for (const source of sources) {
    for (const mediaType of mediaTypes) {
      for await (const item of iterateLibrary(source, mediaType)) {
        const k = `${item.tmdbId}:${item.mediaType}`;
        if (seen.has(k)) continue;
        seen.add(k);
        total++;
        pageBuffer.push(item);

        if (pageBuffer.length >= LIBRARY_PAGE_SIZE) await flushPage();
        if (total >= MAX_PREWARM_ITEMS) {
          console.warn(`[prewarm] Reached MAX_PREWARM_ITEMS (${MAX_PREWARM_ITEMS}) — library scan truncated`);
          break outer;
        }
      }
    }
  }

  await flushPage();

  if (total === 0) {
    console.log("[prewarm] No library items found — skipping TMDB pre-warm");
    return { total: 0, ...stats };
  }

  console.log(`[prewarm] Done — fetched ${stats.fetched}, backfilled ${stats.backfilled}, skipped ${stats.skipped}, failed ${stats.failed} / ${total} total`);
  return { total, ...stats };
}
