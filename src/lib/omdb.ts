import "server-only";
import { prisma } from "./prisma";
import { getCache, getCacheStale, setCache, libraryDetailsTtl } from "./tmdb-cache";
import { safeFetchTrusted, SafeFetchError } from "./safe-fetch";
import { sanitizeForLog } from "./sanitize";
import { tmdbAuth } from "./tmdb-auth";

const OMDB_BASE = "https://www.omdbapi.com";
const OMDB_FETCH_TIMEOUT_MS = 10_000;

const OMDB_NEGATIVE_TTL = 24 * 60 * 60;

// Sentinel stored in the cache to distinguish "item not in OMDB" from "never fetched" so we don't
// re-query OMDB on every page load for titles it genuinely doesn't know about.
const NOT_FOUND_SENTINEL = { _notFound: true } as const;

// In-memory dedup prevents concurrent requests from spawning multiple background revalidations for
// the same cache key during a single request burst.
const revalidating = new Set<string>();

export interface OmdbRatings {
  imdbId: string | null;
  imdbRating: string | null;
  imdbVotes: string | null;
  rottenTomatoes: string | null;
  metacritic: string | null;
}

// The OMDB API key lives in a single Setting row that changes only when an admin
// edits it. A blocking ratings batch resolves up to 200 misses and each miss
// calls getApiKey twice (once here, once in fetchAndCacheOmdbForTmdb) — without
// memoization that is ~400 identical setting.findUnique reads against the small
// Prisma pool per request. Cache the resolved value for a short window, and
// coalesce concurrent cold reads into one query, so a key change still
// propagates within seconds. Pass { fresh: true } to bypass the cache (admin
// connection test, where stale-by-up-to-TTL would be confusing).
const API_KEY_TTL_MS = 30_000;
let apiKeyCache: { value: string | null; at: number } | null = null;
let apiKeyInflight: Promise<string | null> | null = null;

async function getApiKey(opts: { fresh?: boolean } = {}): Promise<string | null> {
  if (!opts.fresh && apiKeyCache && Date.now() - apiKeyCache.at < API_KEY_TTL_MS) {
    return apiKeyCache.value;
  }
  if (!opts.fresh && apiKeyInflight) return apiKeyInflight;
  const p = (async () => {
    const row = await prisma.setting.findUnique({ where: { key: "omdbApiKey" } });
    const value = row?.value || null;
    apiKeyCache = { value, at: Date.now() };
    return value;
  })();
  if (!opts.fresh) {
    apiKeyInflight = p;
    p.finally(() => { apiKeyInflight = null; }).catch(() => {});
  }
  return p;
}

export async function getOmdbRatings(imdbId: string, releaseDate?: string | null): Promise<OmdbRatings | null> {
  const cacheKey = `omdb:${imdbId}`;
  const cached = await getCache<OmdbRatings | typeof NOT_FOUND_SENTINEL>(cacheKey);
  if (cached !== null) {
    if ("_notFound" in cached) return null;
    return cached;
  }

  const apiKey = await getApiKey();
  if (!apiKey) return null;

  try {
    const url = new URL(OMDB_BASE);
    url.searchParams.set("apikey", apiKey);
    url.searchParams.set("i", imdbId);

    const res = await safeFetchTrusted(url.toString(), { allowedHosts: ["www.omdbapi.com"], timeoutMs: OMDB_FETCH_TIMEOUT_MS });
    if (!res.ok) {
      // Transient upstream failure (5xx/429/etc.) — throw so the caller does NOT
      // write a 24h NOT_FOUND sentinel for it. Genuine "no OMDB entry" is only the
      // Response!=="True" branch below.
      throw new Error(`OMDB API returned ${res.status} for ${sanitizeForLog(imdbId)}`);
    }

    const data = await res.json() as {
      Response: string;
      Error?: string;
      imdbID?: string;
      imdbRating?: string;
      imdbVotes?: string;
      Ratings?: { Source: string; Value: string }[];
      Metascore?: string;
    };

    if (data.Response !== "True") {
      await setCache(cacheKey, NOT_FOUND_SENTINEL, OMDB_NEGATIVE_TTL);
      return null;
    }

    const rt = data.Ratings?.find((r) => r.Source === "Rotten Tomatoes")?.Value ?? null;
    const mc = data.Metascore && data.Metascore !== "N/A" ? `${data.Metascore}/100` : null;

    const result: OmdbRatings = {
      imdbId:         imdbId,
      imdbRating:     data.imdbRating && data.imdbRating !== "N/A" ? data.imdbRating : null,
      imdbVotes:      data.imdbVotes && data.imdbVotes !== "N/A" ? data.imdbVotes : null,
      rottenTomatoes: rt && rt !== "N/A" ? rt : null,
      metacritic:     mc,
        };

    await setCache(cacheKey, result, libraryDetailsTtl(releaseDate));
    return result;
  } catch (err) {

    const reason = err instanceof SafeFetchError ? err.reason : (err instanceof Error ? err.message : String(err));
    console.error(`[omdb] fetch failed for ${sanitizeForLog(imdbId)}: ${sanitizeForLog(reason)}`);
    // Transient (network/timeout/SSRF) — propagate so fetchAndCacheOmdbForTmdb's
    // catch returns without negative-caching a title that may exist.
    throw err;
  }
}

export async function testOmdbConnection(): Promise<string> {
  const apiKey = await getApiKey({ fresh: true });
  if (!apiKey) throw new Error("No OMDB API key configured");

  const url = new URL(OMDB_BASE);
  url.searchParams.set("apikey", apiKey);
  url.searchParams.set("i", "tt0133093");

  const res = await safeFetchTrusted(url.toString(), { allowedHosts: ["www.omdbapi.com"], timeoutMs: OMDB_FETCH_TIMEOUT_MS });
  if (!res.ok) throw new Error(`OMDB returned HTTP ${res.status}`);

  const data = await res.json() as { Response: string; Title?: string; Error?: string };
  if (data.Response !== "True") throw new Error(data.Error ?? "OMDB API key invalid");
  return data.Title ?? "OK";
}

export type OmdbResult =
  | { found: true; data: OmdbRatings }
  | { found: false; keyConfigured: boolean };

// OMDB only accepts IMDb IDs, not TMDB IDs — we must resolve via TMDB's external_ids endpoint first.
// If TMDB returns no IMDb ID the item has no OMDB entry and is negative-cached immediately.
export async function fetchAndCacheOmdbForTmdb(
  tmdbId: number,
  mediaType: "movie" | "tv",
  cacheKey: string,
  releaseDate?: string | null,
): Promise<OmdbResult> {
  const apiKey = await getApiKey();
  if (!apiKey) return { found: false, keyConfigured: false };

  try {
    const auth = tmdbAuth();
    if (!auth) return { found: false, keyConfigured: true };

    const extUrl = new URL(`https://api.themoviedb.org/3/${mediaType}/${tmdbId}/external_ids`);
    for (const [k, v] of Object.entries(auth.query)) extUrl.searchParams.set(k, v);
    const extRes = await safeFetchTrusted(extUrl.toString(), {
      allowedHosts: ["api.themoviedb.org"],
      headers: auth.headers,
      timeoutMs: OMDB_FETCH_TIMEOUT_MS,
    });
    if (!extRes.ok) {
      console.warn(`[omdb] TMDB external_ids fetch failed (${sanitizeForLog(extRes.status)}) for ${sanitizeForLog(mediaType)}:${sanitizeForLog(tmdbId)}`);
      return { found: false, keyConfigured: true };
    }

    const ext = await extRes.json() as { imdb_id?: string | null };

    const omdbRatings = ext.imdb_id ? await getOmdbRatings(ext.imdb_id, releaseDate) : null;

    if (!omdbRatings) {
      await setCache(cacheKey, NOT_FOUND_SENTINEL, OMDB_NEGATIVE_TTL);
      return { found: false, keyConfigured: true };
    }

    const ratings: OmdbRatings = {
      imdbId:         ext.imdb_id ?? null,
      imdbRating:     omdbRatings.imdbRating,
      imdbVotes:      omdbRatings.imdbVotes,
      rottenTomatoes: omdbRatings.rottenTomatoes,
      metacritic:     omdbRatings.metacritic,
    };
    await setCache(cacheKey, ratings, libraryDetailsTtl(releaseDate));
    return { found: true, data: ratings };
  } catch (err) {

    const msg = err instanceof SafeFetchError
      ? `${err.reason}: ${err.message}`
      : err instanceof Error ? err.message : String(err);
    console.error(`[omdb] Error fetching for ${sanitizeForLog(mediaType)}:${tmdbId}: ${sanitizeForLog(msg)}`);
    return { found: false, keyConfigured: true };
  }
}

// In-flight cold-miss fetches keyed by cacheKey. Concurrent callers for the same
// (mediaType, tmdbId) reuse the existing promise instead of fanning out a herd
// of upstream requests when the cache is cold. The pre-existing `revalidating`
// Set only covered the SWR-revalidation path, leaving cold-miss susceptible to
// a stampede when many pages load simultaneously.
const inflightCold = new Map<string, Promise<OmdbResult>>();

export async function getOmdbRatingsForTmdb(
  tmdbId: number,
  mediaType: "movie" | "tv",
  releaseDate?: string | null,
): Promise<OmdbResult> {
  const cacheKey = `omdb:tmdb:${mediaType}:${tmdbId}`;
  const { value: cached, isStale } = await getCacheStale<OmdbRatings | typeof NOT_FOUND_SENTINEL>(cacheKey);

  if (cached !== null) {
    if (isStale) {
      const revalKey = `omdb:tmdb:${mediaType}:${tmdbId}`;
      if (!revalidating.has(revalKey)) {
        revalidating.add(revalKey);
        fetchAndCacheOmdbForTmdb(tmdbId, mediaType, cacheKey, releaseDate).catch(() => {}).finally(() => {
          revalidating.delete(revalKey);
        });
      }
    }
    if ("_notFound" in cached) return { found: false, keyConfigured: true };
    return { found: true, data: cached };
  }

  const apiKey = await getApiKey();
  if (!apiKey) return { found: false, keyConfigured: false };

  const existing = inflightCold.get(cacheKey);
  if (existing) return existing;
  const p = fetchAndCacheOmdbForTmdb(tmdbId, mediaType, cacheKey, releaseDate)
    .finally(() => inflightCold.delete(cacheKey));
  inflightCold.set(cacheKey, p);
  return p;
}
