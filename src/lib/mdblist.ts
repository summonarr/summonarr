import "server-only";
import { prisma } from "./prisma";
import { getCache, getCacheStale, setCache, libraryDetailsTtl, TTL } from "./tmdb-cache";
import { safeFetchTrusted, SafeFetchError } from "./safe-fetch";
import { sanitizeForLog } from "./sanitize";
import { mapLimit } from "./concurrency";

// Bounded concurrency for the per-page cache upserts. A full 200-item page used
// to write its rows with a sequential await-in-loop (~200 serial Postgres
// round-trips on the blocking ratings-attach path); flush them a few at a time
// instead without saturating the small Prisma pool.
const MDBLIST_CACHE_WRITE_CONCURRENCY = 8;

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

// The MDBList API key lives in a single Setting row that changes only when an admin
// edits it. A blocking ratings batch resolves up to 200 misses and each miss calls
// getApiKey twice (once in getMdblistRatingsForTmdb, once in fetchAndCacheMdblistForTmdb)
// — without memoization that is ~400 identical setting.findUnique reads against the
// small Prisma pool per request. Cache the resolved value for a short window, and
// coalesce concurrent cold reads into one query, so a key change still propagates
// within seconds. Pass { fresh: true } to bypass the cache (admin connection test,
// where stale-by-up-to-TTL would be confusing).
const API_KEY_TTL_MS = 30_000;
let apiKeyCache: { value: string | null; at: number } | null = null;
let apiKeyInflight: Promise<string | null> | null = null;

async function getApiKey(opts: { fresh?: boolean } = {}): Promise<string | null> {
  if (!opts.fresh && apiKeyCache && Date.now() - apiKeyCache.at < API_KEY_TTL_MS) {
    return apiKeyCache.value;
  }
  if (!opts.fresh && apiKeyInflight) return apiKeyInflight;
  const p = (async () => {
    const row = await prisma.setting.findUnique({ where: { key: "mdblistApiKey" } });
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

export type MdblistResult =
  | { found: true; data: MdblistRatings }
  // `transient` marks a failure that is NOT an authoritative "no ratings" — a 5xx,
  // network/timeout, quota lockout, or a partial/error response — so callers must not
  // pin a null/not-found result into a long-lived cache.
  | { found: false; keyConfigured: boolean; quotaExhausted?: boolean; transient?: boolean };

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
  console.warn(`[mdblist] Quota lockout tripped (${sanitizeForLog(reason)}) — suspending calls for ${QUOTA_LOCKOUT_MS / 60000} min`);
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
    return { found: false, keyConfigured: true, quotaExhausted: true, transient: true };
  }

  try {
    const mdbType = mediaType === "tv" ? "show" : "movie";
    const url = new URL(`${MDBLIST_REST_BASE}tmdb/${mdbType}/${encodeURIComponent(String(tmdbId))}/`);
    url.searchParams.set("apikey", apiKey);

    const res = await safeFetchTrusted(url.toString(), { allowedHosts: MDBLIST_HOSTS, timeoutMs: MDBLIST_FETCH_TIMEOUT_MS });

    if (res.status === 429) {
      tripQuotaLockout(`HTTP 429 for ${mediaType}:${tmdbId}`);
      return { found: false, keyConfigured: true, quotaExhausted: true, transient: true };
    }

    if (res.status === 404) {
      await setCache(cacheKey, NOT_FOUND_SENTINEL, MDBLIST_NEGATIVE_TTL);
      return { found: false, keyConfigured: true };
    }

    if (!res.ok) {
      console.warn(`[mdblist] API returned ${sanitizeForLog(res.status)} for ${sanitizeForLog(mediaType)}:${sanitizeForLog(tmdbId)}`);
      // A transient 5xx must NOT be negative-cached — that would suppress a valid
      // item's ratings for the full 24h TTL. Only a 404 (handled above) is a real
      // "not found" worth caching. Matches the batch path's reasoning.
      return { found: false, keyConfigured: true, transient: true };
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
          return { found: false, keyConfigured: true, quotaExhausted: true, transient: true };
        }
        console.warn(`[mdblist] API error for ${sanitizeForLog(mediaType)}:${sanitizeForLog(tmdbId)}: ${sanitizeForLog(errMsg)}`);
        // A 200-with-error-body (other than 404, handled above as a real not-found) is an
        // app-level error that may be transient — do NOT negative-cache it for 24h, or a
        // valid item's ratings stay suppressed for the full TTL. Matches the 5xx reasoning.
        return { found: false, keyConfigured: true, transient: true };
      }
    }

    const ratings = parseBatchItem(data as MdblistBatchRaw);

    await setCache(cacheKey, ratings, libraryDetailsTtl(releaseDate));
    return { found: true, data: ratings };
  } catch (err) {

    const reason = err instanceof SafeFetchError ? err.reason : (err instanceof Error ? err.message : String(err));
    console.error(`[mdblist] Error fetching for ${sanitizeForLog(mediaType)}:${tmdbId}: ${sanitizeForLog(reason)}`);
    return { found: false, keyConfigured: true, transient: true };
  }
}

const MDBLIST_BATCH_SIZE = 200;

export type MdblistBatchRaw = {
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

// Exported for direct unit coverage (tests/mdblist-parse.test.mts) — pure parser, no I/O.
export function parseBatchItem(raw: MdblistBatchRaw): MdblistRatings {

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
        console.warn(`[mdblist] batch ${mediaType} returned ${res.status}`);

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

      // Collect the page's cache upserts and flush them with bounded concurrency
      // below, rather than awaiting each one serially in-loop.
      const cacheWrites: Array<() => Promise<unknown>> = [];
      // Rows that resolved to no REQUESTED item (a foreign id, or an id-less row
      // past the page's end). They must not count toward "the response covered
      // the full request" below, or the requested ids they displaced get a 24h
      // NOT_FOUND sentinel MDBList never actually answered for.
      let unmatchedRows = 0;

      for (let i = 0; i < arr.length; i++) {
        const raw = arr[i];

        // MDBList batch responses may return items in a different order than the
        // request; match by ID, falling back to positional index ONLY when the
        // response item lacks an ID. A row whose id isn't in the page must NOT
        // fall back positionally — that mis-binds it to the wrong requested item
        // (wrong TTL, foreign id in the result map).
        const pageItem = raw.id != null
          ? page.find((p) => p.id === raw.id)
          : page[i];
        // MDBList can return MORE items than requested (or unmatched ids), so
        // page.find()/page[i] can be undefined — guard before any property access
        // or the whole 200-item batch throws and silently yields zero ratings.
        if (!pageItem) {
          unmatchedRows++;
          continue;
        }
        const tmdbId = raw.id ?? pageItem.id;
        if (!tmdbId) continue;

        const ratings = parseBatchItem(raw);
        result.set(tmdbId, ratings);

        const cacheKey = `mdblist:tmdb:${mediaType}:${tmdbId}`;
        const ttl = libraryDetailsTtl(pageItem.releaseDate);
        cacheWrites.push(() => setCache(cacheKey, ratings, ttl));
      }

      if (arr.length >= page.length && unmatchedRows === 0) {
        // Only negative-cache when the response covered the full request AND every
        // row mapped to a requested id. MDBList normally echoes one entry per
        // requested id (with null ratings for ones it has no data on), so a short
        // response means a truncated/partial batch, not genuine absence — and a
        // full-count response padded with unmatched rows didn't actually answer
        // for the ids those rows displaced. Caching either case's omitted ids
        // would suppress their ratings for 24h even though they exist.
        for (const item of page) {
          if (!result.has(item.id)) {
            const cacheKey = `mdblist:tmdb:${mediaType}:${item.id}`;
            cacheWrites.push(() => setCache(cacheKey, NOT_FOUND_SENTINEL, MDBLIST_NEGATIVE_TTL));
          }
        }
      } else if (arr.length === 0) {
        // An empty array likely means MDBList had a transient issue, not that all items are absent —
        // skip negative-caching to avoid poisoning future lookups.
        console.warn(`[mdblist] batch ${mediaType} returned empty array for ${page.length} items — skipping NOT_FOUND caching`);
      } else if (unmatchedRows > 0) {
        console.warn(`[mdblist] batch ${mediaType} returned ${unmatchedRows} unmatched row(s) (${arr.length} rows for ${page.length} ids) — skipping NOT_FOUND caching for omitted ids`);
      } else {
        console.warn(`[mdblist] batch ${mediaType} returned partial response (${arr.length}/${page.length}) — skipping NOT_FOUND caching for omitted ids`);
      }

      // Flush this page's cache writes a few at a time. A rejection propagates to
      // the surrounding catch (same as the old serial await), which logs and
      // moves on to the next page — caching is best-effort.
      await mapLimit(cacheWrites, MDBLIST_CACHE_WRITE_CONCURRENCY, (w) => w());
    } catch (err) {
      const reason = err instanceof SafeFetchError ? err.reason : (err instanceof Error ? err.message : String(err));
      console.error(`[mdblist] batch error for ${mediaType}: ${reason}`);
    }
  }

  return result;
}

// Coalesce concurrent cold-miss callers — see omdb.ts inflightCold rationale.
const mdblistInflightCold = new Map<string, Promise<MdblistResult>>();

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
  if (!apiKey) return { found: false, keyConfigured: false };

  const existing = mdblistInflightCold.get(cacheKey);
  if (existing) return existing;
  const p = fetchAndCacheMdblistForTmdb(tmdbId, mediaType, cacheKey, releaseDate)
    .finally(() => mdblistInflightCold.delete(cacheKey));
  mdblistInflightCold.set(cacheKey, p);
  return p;
}

export async function testMdblistConnection(): Promise<string> {
  const apiKey = await getApiKey({ fresh: true });
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

    const data = await res.json() as unknown;
    // MDBList signals quota/auth failures as HTTP 200 with an { error } object
    // body (same shape the single-item path handles). Returning that object as
    // a list crashed getMdblistTopRated on `lists.map` — surface the error,
    // trip the lockout on quota messages, and only ever return an array.
    if (data && typeof data === "object" && !Array.isArray(data)) {
      const d = data as { error?: unknown; message?: string };
      const errMsg = typeof d.error === "string" ? d.error : d.error === true ? (d.message ?? "unknown") : null;
      if (errMsg) {
        if (isQuotaErrorMessage(errMsg)) tripQuotaLockout(`${errMsg} on top lists`);
        console.warn(`[mdblist] top lists API error: ${sanitizeForLog(errMsg)}`);
      }
    }
    if (!Array.isArray(data)) return [];
    const lists = data as MdblistListMeta[];
    if (lists.length > 0) await setCache(key, lists, TTL.DISCOVER);
    return lists;
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
