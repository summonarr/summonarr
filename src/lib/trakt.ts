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

interface TraktIds {
  trakt?: number;
  slug?: string;
  imdb?: string;
  tmdb?: number;
  tvdb?: number;
}

// A popular-list row: /movies/popular and /shows/popular answer the same shape.
interface TraktTitle {
  title: string;
  year: number | null;
  ids: TraktIds;
}

function traktHeaders(apiKey: string): Record<string, string> {
  return {
    "Content-Type": "application/json",
    "trakt-api-version": "2",
    "trakt-api-key": apiKey,
  };
}

async function traktFetch<T>(path: string, params?: Record<string, string>): Promise<T> {
  const apiKey = await getApiKey();
  if (!apiKey) throw new Error("Trakt client ID not configured");
  if (isTraktQuotaLocked()) throw new Error("Trakt quota lockout active");

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
    // Honor Trakt's Retry-After (seconds) when present — its rate windows are
    // short, so a fixed 1h lockout over-suspends a transient burst.
    const ra = Number(res.headers.get("retry-after"));
    tripQuotaLockout("HTTP 429", Number.isFinite(ra) && ra > 0 ? ra * 1000 : undefined);
    throw new Error("Trakt rate limited");
  }

  if (!res.ok) throw new Error(`Trakt ${res.status}: ${res.statusText}`);
  return res.json() as Promise<T>;
}

// Trakt items without a tmdb id are silently dropped — we have no way to look them up in the TMDB cache
function normalize(m: TraktTitle, mediaType: "movie" | "tv"): TmdbMedia | null {
  if (!m.ids.tmdb) return null;
  return {
    id: m.ids.tmdb,
    mediaType,
    title: m.title ?? "",
    overview: "",
    posterPath: null,
    backdropPath: null,
    releaseDate: null,
    releaseYear: m.year ? String(m.year) : null,
    voteAverage: 0,
  };
}

// `complete` reports whether EVERY page fulfilled. The helpers below serve a
// partial result (the page still renders) but cache only a complete one —
// allSettled swallows per-page failures, so caching a partial would pin a
// truncated list (or, if page 1 failed, one missing its head) for the full
// 12h TTL, and the warm cron's cache-first read could never repair it
// (mirrors the tmdb.ts list-helper all-fulfilled gate).
async function fetchPages<T>(path: string, pages: number, limit: number): Promise<{ items: T[]; complete: boolean }> {
  const results = await Promise.allSettled(
    Array.from({ length: pages }, (_, i) =>
      traktFetch<T[]>(path, { page: String(i + 1), limit: String(limit) }),
    ),
  );
  return {
    items: results.flatMap((r) => (r.status === "fulfilled" ? r.value : [])),
    complete: results.every((r) => r.status === "fulfilled"),
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

// The whole cache-check-then-fan-out body is wrapped in coalesce() keyed on the
// cache key, so simultaneous cold-cache callers (the /top page and
// /api/top-rated both call the popular pair per request) share ONE page fan-out
// instead of multiplying it — guardrail 31's list-helper shape.
async function getTraktPopular(mediaType: "movie" | "tv", pages: number): Promise<TmdbMedia[]> {
  const key = traktPopularKey(mediaType, pages);
  return coalesce(key, async () => {
  const cached = await getCache<TmdbMedia[]>(key);
  if (cached?.length) return cached;

  const apiKey = await getApiKey();
  if (!apiKey) return [];

  try {
    const { items, complete } = await fetchPages<TraktTitle>(POPULAR[mediaType].path, pages, 100);
    const seen = new Set<number>();
    const result = items
      .map((m) => normalize(m, mediaType))
      .filter((m): m is TmdbMedia => m !== null && !seen.has(m.id) && (seen.add(m.id), true));
    if (complete && result.length > 0) await setCache(key, result, TTL.DISCOVER);
    return result;
  } catch (err) {
    console.error(`[trakt] Failed to fetch ${POPULAR[mediaType].label}:`, err);
    return [];
  }
  });
}

export function getTraktPopularMovies(pages: number = DEFAULT_POPULAR_PAGES): Promise<TmdbMedia[]> {
  return getTraktPopular("movie", pages);
}

export function getTraktPopularTV(pages: number = DEFAULT_POPULAR_PAGES): Promise<TmdbMedia[]> {
  return getTraktPopular("tv", pages);
}

// Admin connection test. Intentionally bypasses the quota lockout (inline
// traktFetch minus the isTraktQuotaLocked check) so a recovered or replaced
// client id can be verified immediately instead of waiting out the remainder
// of the 1h suspension — mirrors testOmdbConnection / the MDBList test.
export async function testTraktConnection(): Promise<string> {
  const apiKey = await getApiKey();
  if (!apiKey) throw new Error("Trakt client ID not configured");

  const url = new URL("/movies/popular", TRAKT_BASE);
  url.searchParams.set("limit", "1");
  const res = await safeFetchTrusted(url.toString(), {
    allowedHosts: ["api.trakt.tv"],
    headers: traktHeaders(apiKey),
    timeoutMs: TRAKT_TIMEOUT_MS,
  });
  if (!res.ok) throw new Error(`Trakt ${res.status}: ${res.statusText}`);

  const movies = await res.json() as TraktTitle[];
  if (!Array.isArray(movies) || !movies.length) throw new Error("Empty response from Trakt");
  return movies[0].title;
}
