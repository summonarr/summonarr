import "server-only";
import { prisma } from "./prisma";
import { getCache, setCache, TTL } from "./tmdb-cache";
import { safeFetchTrusted } from "./safe-fetch";
import { coalesce } from "./concurrency";
import type { TmdbMedia } from "./tmdb-types";

const TRAKT_BASE = "https://api.trakt.tv";
const TRAKT_TIMEOUT_MS = 15_000;

// In-process lockout prevents hammering Trakt after a 429.
let quotaLockoutUntil = 0;
// Ceiling for the lockout, and the fallback when Trakt sends no Retry-After.
// Deliberately different from the OMDB/MDBList 60-min constants: those guard a
// DAILY quota, whereas Trakt's limits are short rolling windows (its
// UNAUTHED_API_GET_LIMIT is a 5-minute window) and it documents Retry-After on
// 429 — so we honor that header, clamped to [30s, 1h].
const QUOTA_LOCKOUT_MS = 60 * 60 * 1000;
const QUOTA_LOCKOUT_MIN_MS = 30 * 1000;

function isTraktQuotaLocked(): boolean {
  return Date.now() < quotaLockoutUntil;
}

// Pure clamp (exported for tests): a Retry-After (ms) is honored within
// [30s, 1h]; absent falls back to the 1h ceiling.
export function clampTraktLockoutMs(retryAfterMs?: number): number {
  return Math.min(Math.max(retryAfterMs ?? QUOTA_LOCKOUT_MS, QUOTA_LOCKOUT_MIN_MS), QUOTA_LOCKOUT_MS);
}

function tripQuotaLockout(reason: string, retryAfterMs?: number) {
  const ms = clampTraktLockoutMs(retryAfterMs);
  quotaLockoutUntil = Date.now() + ms;
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

interface TraktMovie {
  title: string;
  year: number | null;
  ids: TraktIds;
}

interface TraktShow {
  title: string;
  year: number | null;
  ids: TraktIds;
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
    headers: {
      "Content-Type": "application/json",
      "trakt-api-version": "2",
      "trakt-api-key": apiKey,
    },
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
function normalizeMovie(m: TraktMovie): TmdbMedia | null {
  if (!m.ids.tmdb) return null;
  return {
    id: m.ids.tmdb,
    mediaType: "movie",
    title: m.title ?? "",
    overview: "",
    posterPath: null,
    backdropPath: null,
    releaseDate: null,
    releaseYear: m.year ? String(m.year) : null,
    voteAverage: 0,
  };
}

function normalizeShow(s: TraktShow): TmdbMedia | null {
  if (!s.ids.tmdb) return null;
  return {
    id: s.ids.tmdb,
    mediaType: "tv",
    title: s.title ?? "",
    overview: "",
    posterPath: null,
    backdropPath: null,
    releaseDate: null,
    releaseYear: s.year ? String(s.year) : null,
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

// Each helper wraps its whole cache-check-then-fan-out body in coalesce()
// keyed on its cache key, so simultaneous cold-cache callers (the /top page
// and /api/top-rated both call the popular pair per request) share ONE 3-5
// page fan-out instead of multiplying it — guardrail 31's list-helper shape.
export async function getTraktPopularMovies(pages = 5): Promise<TmdbMedia[]> {
  const key = "trakt:popular:movies";
  return coalesce(key, async () => {
  const cached = await getCache<TmdbMedia[]>(key);
  if (cached?.length) return cached;

  const apiKey = await getApiKey();
  if (!apiKey) return [];

  try {
    const { items, complete } = await fetchPages<TraktMovie>("/movies/popular", pages, 100);
    const seen = new Set<number>();
    const result = items
      .map(normalizeMovie)
      .filter((m): m is TmdbMedia => m !== null && !seen.has(m.id) && (seen.add(m.id), true));
    if (complete && result.length > 0) await setCache(key, result, TTL.DISCOVER);
    return result;
  } catch (err) {
    console.error("[trakt] Failed to fetch popular movies:", err);
    return [];
  }
  });
}

export async function getTraktPopularTV(pages = 5): Promise<TmdbMedia[]> {
  const key = "trakt:popular:tv";
  return coalesce(key, async () => {
  const cached = await getCache<TmdbMedia[]>(key);
  if (cached?.length) return cached;

  const apiKey = await getApiKey();
  if (!apiKey) return [];

  try {
    const { items, complete } = await fetchPages<TraktShow>("/shows/popular", pages, 100);
    const seen = new Set<number>();
    const result = items
      .map(normalizeShow)
      .filter((m): m is TmdbMedia => m !== null && !seen.has(m.id) && (seen.add(m.id), true));
    if (complete && result.length > 0) await setCache(key, result, TTL.DISCOVER);
    return result;
  } catch (err) {
    console.error("[trakt] Failed to fetch popular TV:", err);
    return [];
  }
  });
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
    headers: {
      "Content-Type": "application/json",
      "trakt-api-version": "2",
      "trakt-api-key": apiKey,
    },
    timeoutMs: TRAKT_TIMEOUT_MS,
  });
  if (!res.ok) throw new Error(`Trakt ${res.status}: ${res.statusText}`);

  const movies = await res.json() as TraktMovie[];
  if (!Array.isArray(movies) || !movies.length) throw new Error("Empty response from Trakt");
  return movies[0].title;
}
