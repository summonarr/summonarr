import "server-only";
import { prisma } from "./prisma";
import { getCache, getCacheStale, setCache, libraryDetailsTtl, TTL } from "./tmdb-cache";
import { safeFetchTrusted, SafeFetchError } from "./safe-fetch";

const MDBLIST_REST_BASE  = "https://api.mdblist.com/";
const MDBLIST_FETCH_TIMEOUT_MS = 10_000;
const MDBLIST_BATCH_TIMEOUT_MS = 30_000;
const MDBLIST_HOSTS = ["api.mdblist.com"];

const MDBLIST_NEGATIVE_TTL = 24 * 60 * 60;

// Sentinel stored in cache to distinguish "MDBList returned no data" from "not yet fetched"
const NOT_FOUND_SENTINEL = { _notFound: true } as const;

export interface MdblistRatings {
  imdbId: string | null;
  imdbRating: string | null;
  imdbVotes: string | null;
  rottenTomatoes: string | null;
  rtAudienceScore: string | null;
  metacritic: string | null;
  traktRating: string | null;
  letterboxdRating: string | null;
  mdblistScore: string | null;
  malRating: string | null;
  rogerEbertRating: string | null;
  releasedDigital: string | null;
  trailerUrl: string | null;
}

async function getApiKey(): Promise<string | null> {
  const row = await prisma.setting.findUnique({ where: { key: "mdblistApiKey" } });
  return row?.value || null;
}

export type MdblistResult =
  | { found: true; data: MdblistRatings }
  | { found: false; keyConfigured: boolean; quotaExhausted?: boolean };

const mdblistRevalidating = new Set<string>();

// In-memory lockout for the current process lifetime — does not survive restarts, but avoids
// burning through the daily MDBList quota after a 429 or quota error body.
let quotaLockoutUntil = 0;
const QUOTA_LOCKOUT_MS = 60 * 60 * 1000;

export function isMdblistQuotaLocked(): boolean {
  return Date.now() < quotaLockoutUntil;
}

function tripQuotaLockout(reason: string) {
  quotaLockoutUntil = Date.now() + QUOTA_LOCKOUT_MS;
  console.warn(`[mdblist] Quota lockout tripped (${reason}) — suspending calls for ${QUOTA_LOCKOUT_MS / 60000} min`);
}

function isQuotaErrorMessage(msg: string | null | undefined): boolean {
  if (!msg) return false;
  const m = msg.toLowerCase();
  return m.includes("api limit") || m.includes("quota") || m.includes("rate limit") || m.includes("too many");
}

export async function fetchAndCacheMdblistForTmdb(
  tmdbId: number,
  mediaType: "movie" | "tv",
  cacheKey: string,
  releaseDate?: string | null,
): Promise<MdblistResult> {
  const apiKey = await getApiKey();
  if (!apiKey) return { found: false, keyConfigured: false };

  if (isMdblistQuotaLocked()) {
    return { found: false, keyConfigured: true, quotaExhausted: true };
  }

  try {
    const mdbType = mediaType === "tv" ? "show" : "movie";
    const url = new URL(`${MDBLIST_REST_BASE}tmdb/${mdbType}/${encodeURIComponent(String(tmdbId))}/`);
    url.searchParams.set("apikey", apiKey);

    const res = await safeFetchTrusted(url.toString(), { allowedHosts: MDBLIST_HOSTS, timeoutMs: MDBLIST_FETCH_TIMEOUT_MS });

    if (res.status === 429) {
      tripQuotaLockout(`HTTP 429 for ${mediaType}:${tmdbId}`);
      return { found: false, keyConfigured: true, quotaExhausted: true };
    }

    if (res.status === 404) {
      await setCache(cacheKey, NOT_FOUND_SENTINEL, MDBLIST_NEGATIVE_TTL);
      return { found: false, keyConfigured: true };
    }

    if (!res.ok) {
      console.log(`[mdblist] API returned ${res.status} for ${mediaType}:${tmdbId}`);
      await setCache(cacheKey, NOT_FOUND_SENTINEL, MDBLIST_NEGATIVE_TTL);
      return { found: false, keyConfigured: true };
    }

    const data = await res.json() as unknown;

    if (data && typeof data === "object" && !Array.isArray(data)) {
      const d = data as { error?: unknown; message?: string };
      const errMsg =
        typeof d.error === "string" ? d.error :
        d.error === true ? (d.message ?? "unknown") :
        null;
      if (errMsg) {
        if (isQuotaErrorMessage(errMsg)) {
          tripQuotaLockout(`${errMsg} for ${mediaType}:${tmdbId}`);
          return { found: false, keyConfigured: true, quotaExhausted: true };
        }
        console.log(`[mdblist] API error for ${mediaType}:${tmdbId}: ${encodeURIComponent(errMsg)}`);
        await setCache(cacheKey, NOT_FOUND_SENTINEL, MDBLIST_NEGATIVE_TTL);
        return { found: false, keyConfigured: true };
      }
    }

    const ratings = parseBatchItem(data as MdblistBatchRaw);

    await setCache(cacheKey, ratings, libraryDetailsTtl(releaseDate));
    return { found: true, data: ratings };
  } catch (err) {

    const reason = err instanceof SafeFetchError ? err.reason : (err instanceof Error ? err.message : String(err));
    console.error(`[mdblist] Error fetching for ${mediaType}:${tmdbId}: ${encodeURIComponent(reason)}`);
    return { found: false, keyConfigured: true };
  }
}

const MDBLIST_BATCH_SIZE = 200;

type MdblistBatchRaw = {
  id?: number | null;
  title?: string;
  imdb_id?: string | null;
  type?: string;
  year?: number | null;
  score?: number | null;
  trailer?: string | null;
  released_digital?: string | null;
  ratings?: { source: string; value: number | null; score?: number | null; votes?: number | null }[];
};

function parseBatchItem(raw: MdblistBatchRaw): MdblistRatings {

  // MDBList source names vary across API versions; multiple aliases are checked per source
  const findSrc = (...names: string[]) => {
    const arr = raw.ratings ?? [];
    for (const n of names) {
      const hit = arr.find((s) => s.source === n);
      if (hit) return hit;
    }
    return undefined;
  };
  const imdb             = findSrc("imdb");
  const tomatoes         = findSrc("tomatoes");
  const tomatoesAudience = findSrc("audience", "tomatoesaudience", "popcornrating");
  const mc               = findSrc("metacritic");
  const trakt            = findSrc("trakt");
  const letterboxd       = findSrc("letterboxd", "letterrating");
  const mal              = findSrc("mal", "myanimelist");
  const ebert            = findSrc("rogerebert");

  return {
    imdbId:           raw.imdb_id || null,
    imdbRating:       imdb?.value != null             ? String(imdb.value)                          : null,
    imdbVotes:        imdb?.votes                     ? String(imdb.votes)                          : null,
    rottenTomatoes:   tomatoes?.value != null         ? `${Math.round(tomatoes.value)}%`            : null,
    rtAudienceScore:  tomatoesAudience?.value != null ? `${Math.round(tomatoesAudience.value)}%`   : null,
    metacritic:       mc?.value != null               ? `${Math.round(mc.value)}/100`               : null,
    traktRating:      trakt?.value != null            ? String(Math.round(trakt.value))             : null,
    letterboxdRating: letterboxd?.value != null       ? String(letterboxd.value)                    : null,
    mdblistScore:     raw.score != null               ? String(Math.round(raw.score))               : null,
    malRating:        mal?.value != null              ? String(mal.value)                           : null,
    rogerEbertRating: ebert?.value != null            ? String(ebert.value)                         : null,
    releasedDigital:  raw.released_digital || null,
    trailerUrl:       raw.trailer || null,
  };
}

export async function fetchMdblistBatch(
  items: { id: number; releaseDate?: string | null }[],
  mediaType: "movie" | "tv",
): Promise<Map<number, MdblistRatings>> {
  const result = new Map<number, MdblistRatings>();
  if (items.length === 0) return result;

  const apiKey = await getApiKey();
  if (!apiKey) return result;
  if (isMdblistQuotaLocked()) return result;

  const mdbType = mediaType === "tv" ? "show" : "movie";
  const url = new URL(`${MDBLIST_REST_BASE}tmdb/${mdbType}/`);
  url.searchParams.set("apikey", apiKey);

  for (let offset = 0; offset < items.length; offset += MDBLIST_BATCH_SIZE) {
    const page = items.slice(offset, offset + MDBLIST_BATCH_SIZE);
    const ids  = page.map((item) => item.id);

    let res: Response | null = null;
    try {
      const body = JSON.stringify({ ids });

      for (let attempt = 0; attempt < 2; attempt++) {
        res = await safeFetchTrusted(url.toString(), {
          allowedHosts: MDBLIST_HOSTS,
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body,
          timeoutMs: MDBLIST_BATCH_TIMEOUT_MS,
        });
        if (res.status !== 503) break;
        if (attempt === 0) {
          await new Promise((r) => setTimeout(r, 1500));
        }
      }
      if (!res) break;

      if (res.status === 429) {
        tripQuotaLockout(`HTTP 429 on batch ${mediaType}`);
        break;
      }

      if (!res.ok) {
        console.log(`[mdblist] batch ${mediaType} returned ${res.status}`);

        continue;
      }

      const data = await res.json() as unknown;

      if (data && typeof data === "object" && !Array.isArray(data)) {
        const d = data as { error?: unknown; message?: string };
        const errMsg = typeof d.error === "string" ? d.error : d.error === true ? (d.message ?? "unknown") : null;
        if (errMsg && isQuotaErrorMessage(errMsg)) {
          tripQuotaLockout(`${errMsg} on batch ${mediaType}`);
          break;
        }
      }

      const arr = Array.isArray(data) ? (data as MdblistBatchRaw[]) : [];

      for (let i = 0; i < arr.length; i++) {
        const raw = arr[i];

        // MDBList batch responses may return items in a different order than the request; match by ID
        // first and fall back to positional index only when the response item lacks an ID.
        const pageItem = raw.id != null
          ? (page.find((p) => p.id === raw.id) ?? page[i])
          : page[i];
        const tmdbId = raw.id ?? pageItem.id;
        if (!tmdbId) continue;

        const ratings = parseBatchItem(raw);
        result.set(tmdbId, ratings);

        const cacheKey = `mdblist:tmdb:${mediaType}:${tmdbId}`;
        await setCache(cacheKey, ratings, libraryDetailsTtl(pageItem.releaseDate));
      }

      if (arr.length > 0) {
        // Any request ID that was absent from the response body is genuinely not in MDBList;
        // negative-cache it to avoid re-requesting the same item on every prewarm run.
        for (const item of page) {
          if (!result.has(item.id)) {
            const cacheKey = `mdblist:tmdb:${mediaType}:${item.id}`;
            await setCache(cacheKey, NOT_FOUND_SENTINEL, MDBLIST_NEGATIVE_TTL);
          }
        }
      } else {
        // An empty array likely means MDBList had a transient issue, not that all items are absent —
        // skip negative-caching to avoid poisoning future lookups.
        console.warn(`[mdblist] batch ${mediaType} returned empty array for ${page.length} items — skipping NOT_FOUND caching`);
      }
    } catch (err) {
      const reason = err instanceof SafeFetchError ? err.reason : (err instanceof Error ? err.message : String(err));
      console.error(`[mdblist] batch error for ${mediaType}: ${reason}`);
    }
  }

  return result;
}

export async function getMdblistRatingsForTmdb(
  tmdbId: number,
  mediaType: "movie" | "tv",
  releaseDate?: string | null,
): Promise<MdblistResult> {
  const cacheKey = `mdblist:tmdb:${mediaType}:${tmdbId}`;
  const { value: cached, isStale } = await getCacheStale<MdblistRatings | typeof NOT_FOUND_SENTINEL>(cacheKey);

  if (cached !== null) {
    if (isStale) {
      const revalKey = `mdblist:tmdb:${mediaType}:${tmdbId}`;
      if (!mdblistRevalidating.has(revalKey)) {
        mdblistRevalidating.add(revalKey);
        fetchAndCacheMdblistForTmdb(tmdbId, mediaType, cacheKey, releaseDate).catch(() => {}).finally(() => {
          mdblistRevalidating.delete(revalKey);
        });
      }
    }
    if ("_notFound" in cached) return { found: false, keyConfigured: true };
    return { found: true, data: cached };
  }

  const apiKey = await getApiKey();
  if (!apiKey) {
    console.log(`[mdblist] No API key configured — skipping for ${mediaType}:${tmdbId}`);
    return { found: false, keyConfigured: false };
  }

  return fetchAndCacheMdblistForTmdb(tmdbId, mediaType, cacheKey, releaseDate);
}

export async function testMdblistConnection(): Promise<string> {
  const apiKey = await getApiKey();
  if (!apiKey) throw new Error("No MDBList API key configured");

  const url = new URL(`${MDBLIST_REST_BASE}tmdb/show/1396/`);
  url.searchParams.set("apikey", apiKey);

  const res = await safeFetchTrusted(url.toString(), { allowedHosts: MDBLIST_HOSTS, timeoutMs: MDBLIST_FETCH_TIMEOUT_MS });
  if (!res.ok) throw new Error(`MDBList returned HTTP ${res.status}`);

  const data = await res.json() as {
    error?: boolean | string;
    message?: string;
    title?: string;
  };

  const errMsg =
    typeof data.error === "string" ? data.error :
    data.error === true ? (data.message ?? "unknown error") :
    null;

  if (errMsg) throw new Error(`MDBList: ${errMsg}`);
  return data.title ?? "OK";
}

import type { TmdbMedia } from "./tmdb-types";

interface MdblistListMeta {
  id: number;
  name: string;
  slug: string;
  items: number;
  likes: number;
}

interface MdblistListItem {
  id: number;
  rank: number;
  title: string;
  year: number | null;
  mediatype: string;
  imdb_id: string | null;
  tmdb_id: number | null;
  score: number | null;
}

export async function getMdblistTopLists(limit = 10): Promise<MdblistListMeta[]> {
  const key = "mdblist:top-lists";
  const cached = await getCache<MdblistListMeta[]>(key);
  if (cached?.length) return cached;

  const apiKey = await getApiKey();
  if (!apiKey) return [];
  if (isMdblistQuotaLocked()) return [];

  try {
    const url = new URL(`${MDBLIST_REST_BASE}lists/top`);
    url.searchParams.set("apikey", apiKey);
    url.searchParams.set("limit", String(limit));

    const res = await safeFetchTrusted(url.toString(), { allowedHosts: MDBLIST_HOSTS, timeoutMs: MDBLIST_FETCH_TIMEOUT_MS });
    if (res.status === 429) { tripQuotaLockout("HTTP 429 on top lists"); return []; }
    if (!res.ok) return [];

    const data = await res.json() as MdblistListMeta[];
    if (data?.length > 0) await setCache(key, data, TTL.DISCOVER);
    return data;
  } catch (err) {
    console.error("[mdblist] Failed to fetch top lists:", err);
    return [];
  }
}

export async function getMdblistListItems(
  listId: number,
  mediaType?: "movie" | "tv",
): Promise<TmdbMedia[]> {
  const key = `mdblist:list:${listId}:${mediaType ?? "all"}`;
  const cached = await getCache<TmdbMedia[]>(key);
  if (cached?.length) return cached;

  const apiKey = await getApiKey();
  if (!apiKey) return [];
  if (isMdblistQuotaLocked()) return [];

  try {
    const url = new URL(`${MDBLIST_REST_BASE}lists/${listId}/items`);
    url.searchParams.set("apikey", apiKey);

    const res = await safeFetchTrusted(url.toString(), { allowedHosts: MDBLIST_HOSTS, timeoutMs: MDBLIST_FETCH_TIMEOUT_MS });
    if (res.status === 429) { tripQuotaLockout("HTTP 429 on list items"); return []; }
    if (!res.ok) return [];

    const data = await res.json() as MdblistListItem[];
    if (!Array.isArray(data)) return [];

    const seen = new Set<number>();
    const result: TmdbMedia[] = [];
    for (const item of data) {
      if (!item.tmdb_id || item.tmdb_id <= 0) continue;
      const itemType = item.mediatype === "show" ? "tv" : "movie";
      if (mediaType && itemType !== mediaType) continue;
      if (seen.has(item.tmdb_id)) continue;
      seen.add(item.tmdb_id);

      result.push({
        id: item.tmdb_id,
        mediaType: itemType as "movie" | "tv",
        title: item.title ?? "",
        overview: "",
        posterPath: null,
        backdropPath: null,
        releaseDate: null,
        releaseYear: item.year ? String(item.year) : null,
        voteAverage: 0,
      });
    }

    if (result.length > 0) await setCache(key, result, TTL.DISCOVER);
    return result;
  } catch (err) {
    console.error("[mdblist] Failed to fetch list items:", err);
    return [];
  }
}

export async function getMdblistTopRated(
  mediaType: "movie" | "tv",
  maxLists = 5,
): Promise<TmdbMedia[]> {
  const key = `mdblist:top-rated:${mediaType}`;
  const cached = await getCache<TmdbMedia[]>(key);
  if (cached?.length) return cached;

  const lists = await getMdblistTopLists(maxLists);
  if (lists.length === 0) return [];

  const allItems = await Promise.all(
    lists.map((l) => getMdblistListItems(l.id, mediaType)),
  );

  const seen = new Set<number>();
  const result: TmdbMedia[] = [];
  for (const items of allItems) {
    for (const item of items) {
      if (!seen.has(item.id)) {
        seen.add(item.id);
        result.push(item);
      }
    }
  }

  if (result.length > 0) await setCache(key, result, TTL.DISCOVER);
  return result;
}
