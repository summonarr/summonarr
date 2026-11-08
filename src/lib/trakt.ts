import "server-only";
import { prisma } from "./prisma";
import { getCache, setCache, TTL } from "./tmdb-cache";
import { safeFetchTrusted } from "./safe-fetch";
import { coalesce } from "./concurrency";
import { processSingleton } from "./process-singleton";
import type { TmdbMedia } from "./tmdb-types";

const TRAKT_BASE = "https://api.trakt.tv";
const TRAKT_TIMEOUT_MS = 15_000;

// In-process lockout prevents hammering Trakt after a 429. Process-wide
// (guardrail 27a): a per-chunk `let` let a lockout tripped by the warm cron go
// unseen by the page renders.
const lockout = processSingleton("trakt:lockout", () => ({ until: 0 }));
// Ceiling for the lockout, and the fallback when Trakt sends no Retry-After.
// Deliberately different from the OMDB/MDBList 60-min constants: those guard a
// DAILY quota, whereas Trakt's limits are short rolling windows (its
// UNAUTHED_API_GET_LIMIT is a 5-minute window) and it documents Retry-After on
// 429 — so we honor that header, clamped to [30s, 1h].
const QUOTA_LOCKOUT_MS = 60 * 60 * 1000;
const QUOTA_LOCKOUT_MIN_MS = 30 * 1000;

function isTraktQuotaLocked(): boolean {
  return Date.now() < lockout.until;
}

// Pure clamp (exported for tests): a Retry-After (ms) is honored within
// [30s, 1h]; absent falls back to the 1h ceiling.
export function clampTraktLockoutMs(retryAfterMs?: number): number {
  return Math.min(Math.max(retryAfterMs ?? QUOTA_LOCKOUT_MS, QUOTA_LOCKOUT_MIN_MS), QUOTA_LOCKOUT_MS);
}

function tripQuotaLockout(reason: string, retryAfterMs?: number) {
  const ms = clampTraktLockoutMs(retryAfterMs);
  lockout.until = Date.now() + ms;
  console.warn(`[trakt] Quota lockout tripped (${reason}) — suspending calls for ${(ms / 60000).toFixed(1)} min`);
}

async function getApiKey(): Promise<string | null> {
  const row = await prisma.setting.findUnique({ where: { key: "traktClientId" } });
  return row?.value || null;
}

function traktHeaders(apiKey: string): Record<string, string> {
  return {
    "Content-Type": "application/json",
    "trakt-api-version": "2",
    "trakt-api-key": apiKey,
  };
}

// One GET to Trakt with the configured client id: the ONE request path, so a 429
// trips the lockout (honoring Retry-After) whoever made the call — the admin's
// connection test included. A body that is not read is cancelled: an unread
// body holds its socket until GC.
async function traktGetJson(apiKey: string, path: string, params?: Record<string, string>): Promise<unknown> {
  const url = new URL(path, TRAKT_BASE);
  if (params) {
    for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
  }

  const res = await safeFetchTrusted(url.toString(), {
    allowedHosts: ["api.trakt.tv"],
    headers: traktHeaders(apiKey),
    timeoutMs: TRAKT_TIMEOUT_MS,
  });

  if (res.status === 429) {
    res.body?.cancel().catch(() => {});
    // Honor Trakt's Retry-After (seconds) when present — its rate windows are
    // short, so a fixed 1h lockout over-suspends a transient burst.
    const ra = Number(res.headers.get("retry-after"));
    tripQuotaLockout("HTTP 429", Number.isFinite(ra) && ra > 0 ? ra * 1000 : undefined);
    throw new Error("Trakt rate limited");
  }

  if (!res.ok) {
    res.body?.cancel().catch(() => {});
    throw new Error(`Trakt ${res.status}: ${res.statusText}`);
  }
  return res.json();
}

// A popular-list row → a TmdbMedia skeleton, or null for a row that is not one
// (not an object, no positive integer tmdb id — we have no way to look those up
// in the TMDB cache). One bad row is dropped; the rest of the page stands. Pure.
function normalize(row: unknown, mediaType: "movie" | "tv"): TmdbMedia | null {
  if (!row || typeof row !== "object") return null;
  const r = row as { title?: unknown; year?: unknown; ids?: unknown };
  const tmdb = r.ids && typeof r.ids === "object" ? (r.ids as { tmdb?: unknown }).tmdb : undefined;
  if (typeof tmdb !== "number" || !Number.isSafeInteger(tmdb) || tmdb <= 0) return null;
  return {
    id: tmdb,
    mediaType,
    title: typeof r.title === "string" ? r.title : "",
    overview: "",
    posterPath: null,
    backdropPath: null,
    releaseDate: null,
    releaseYear: typeof r.year === "number" && Number.isSafeInteger(r.year) && r.year > 0 ? String(r.year) : null,
    voteAverage: 0,
  };
}

// `complete` reports whether EVERY page fulfilled. The helpers below serve a
// partial result (the page still renders) but cache only a complete one —
// allSettled swallows per-page failures, so caching a partial would pin a
// truncated list (or, if page 1 failed, one missing its head) for the full
// 12h TTL, and the warm cron's cache-first read could never repair it
// (mirrors the tmdb.ts list-helper all-fulfilled gate).
async function fetchPages(apiKey: string, path: string, pages: number, limit: number): Promise<{ items: unknown[]; complete: boolean }> {
  const results = await Promise.allSettled(
    Array.from({ length: pages }, (_, i) =>
      traktGetJson(apiKey, path, { page: String(i + 1), limit: String(limit) }),
    ),
  );
  return {
    items: results.flatMap((r) => (r.status === "fulfilled" && Array.isArray(r.value) ? r.value : [])),
    complete: results.every((r) => r.status === "fulfilled" && Array.isArray(r.value)),
  };
}

// Pages of 100 each list reads.
const DEFAULT_POPULAR_PAGES = 5;

const POPULAR = {
  movie: { key: "trakt:popular:movies", path: "/movies/popular", label: "popular movies" },
  tv: { key: "trakt:popular:tv", path: "/shows/popular", label: "popular TV" },
} as const;

// The cache (and coalesce) key. The page count changes the list, so a caller
// asking for another count gets its own entry; every production caller uses
// the default, whose key is unchanged.
function traktPopularKey(mediaType: "movie" | "tv", pages: number = DEFAULT_POPULAR_PAGES): string {
  const base = POPULAR[mediaType].key;
  return pages === DEFAULT_POPULAR_PAGES ? base : `${base}:pages=${pages}`;
}

// A popular list and whether it is the whole answer: false when Trakt was
// locked out, a page failed or the fan-out threw, so a caller can tell an
// outage from a list that is simply short. An unconfigured client id is an
// answer (complete, empty): there is nothing to fetch.
export interface TraktPopularList {
  items: TmdbMedia[];
  complete: boolean;
}

// The whole cache-check-then-fan-out body is wrapped in coalesce() keyed on the
// cache key, so simultaneous cold-cache callers (the /top page and
// /api/top-rated both call the popular pair per request) share ONE page fan-out
// instead of multiplying it — guardrail 31's list-helper shape.
function getTraktPopular(mediaType: "movie" | "tv", pages: number): Promise<TraktPopularList> {
  const key = traktPopularKey(mediaType, pages);
  return coalesce(key, async (): Promise<TraktPopularList> => {
  const cached = await getCache<TmdbMedia[]>(key);
  if (cached?.length) return { items: cached, complete: true };
  // While locked out, nothing is asked — not even the client id from the DB.
  if (isTraktQuotaLocked()) return { items: [], complete: false };

  const apiKey = await getApiKey();
  if (!apiKey) return { items: [], complete: true };

  try {
    // The key read once here serves every page.
    const { items, complete } = await fetchPages(apiKey, POPULAR[mediaType].path, pages, 100);
    const seen = new Set<number>();
    const result = items
      .map((m) => normalize(m, mediaType))
      .filter((m): m is TmdbMedia => m !== null && !seen.has(m.id) && (seen.add(m.id), true));
    if (complete && result.length > 0) await setCache(key, result, TTL.DISCOVER);
    return { items: result, complete };
  } catch (err) {
    console.error(`[trakt] Failed to fetch ${POPULAR[mediaType].label}:`, err);
    return { items: [], complete: false };
  }
  });
}

export async function getTraktPopularMovies(pages: number = DEFAULT_POPULAR_PAGES): Promise<TmdbMedia[]> {
  return (await getTraktPopular("movie", pages)).items;
}

export async function getTraktPopularTV(pages: number = DEFAULT_POPULAR_PAGES): Promise<TmdbMedia[]> {
  return (await getTraktPopular("tv", pages)).items;
}

/** The default popular list with its completeness (see TraktPopularList). */
export function getTraktPopularWithStatus(mediaType: "movie" | "tv"): Promise<TraktPopularList> {
  return getTraktPopular(mediaType, DEFAULT_POPULAR_PAGES);
}

// Admin connection test. Intentionally bypasses the quota lockout (it calls
// traktGetJson directly, without the list helpers' lockout check) so a recovered or
// replaced client id can be verified immediately instead of waiting out the
// remainder of the 1h suspension — mirrors testOmdbConnection / the MDBList
// test. A 429 it gets still trips the lockout for the list helpers.
export async function testTraktConnection(): Promise<string> {
  const apiKey = await getApiKey();
  if (!apiKey) throw new Error("Trakt client ID not configured");

  const movies = await traktGetJson(apiKey, "/movies/popular", { limit: "1" });
  const first: unknown = Array.isArray(movies) ? movies[0] : undefined;
  if (!first) throw new Error("Empty response from Trakt");
  const title = (first as { title?: unknown }).title;
  return typeof title === "string" ? title : "OK";
}
