import "server-only";
import { prisma } from "./prisma";
import { getCache, setCache, TTL } from "./tmdb-cache";
import { safeFetchTrusted } from "./safe-fetch";
import type { TmdbMedia } from "./tmdb-types";

const TRAKT_BASE = "https://api.trakt.tv";
const TRAKT_TIMEOUT_MS = 15_000;

// In-process lockout prevents hammering Trakt after a 429 — suspended for 1 hour on any rate-limit response
let quotaLockoutUntil = 0;
const QUOTA_LOCKOUT_MS = 60 * 60 * 1000;

function isTraktQuotaLocked(): boolean {
  return Date.now() < quotaLockoutUntil;
}

function tripQuotaLockout(reason: string) {
  quotaLockoutUntil = Date.now() + QUOTA_LOCKOUT_MS;
  console.warn(`[trakt] Quota lockout tripped (${reason}) — suspending calls for ${QUOTA_LOCKOUT_MS / 60000} min`);
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

interface TraktTrendingMovie {
  watchers: number;
  movie: TraktMovie;
}

interface TraktTrendingShow {
  watchers: number;
  show: TraktShow;
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
    tripQuotaLockout("HTTP 429");
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

async function fetchPages<T>(path: string, pages: number, limit: number): Promise<T[]> {
  const results = await Promise.allSettled(
    Array.from({ length: pages }, (_, i) =>
      traktFetch<T[]>(path, { page: String(i + 1), limit: String(limit) }),
    ),
  );
  return results.flatMap((r) => (r.status === "fulfilled" ? r.value : []));
}

export async function getTraktPopularMovies(pages = 5): Promise<TmdbMedia[]> {
  const key = "trakt:popular:movies";
  const cached = await getCache<TmdbMedia[]>(key);
  if (cached?.length) return cached;

  const apiKey = await getApiKey();
  if (!apiKey) return [];

  try {
    const raw = await fetchPages<TraktMovie>("/movies/popular", pages, 100);
    const seen = new Set<number>();
    const result = raw
      .map(normalizeMovie)
      .filter((m): m is TmdbMedia => m !== null && !seen.has(m.id) && (seen.add(m.id), true));
    if (result.length > 0) await setCache(key, result, TTL.DISCOVER);
    return result;
  } catch (err) {
    console.error("[trakt] Failed to fetch popular movies:", err);
    return [];
  }
}

export async function getTraktPopularTV(pages = 5): Promise<TmdbMedia[]> {
  const key = "trakt:popular:tv";
  const cached = await getCache<TmdbMedia[]>(key);
  if (cached?.length) return cached;

  const apiKey = await getApiKey();
  if (!apiKey) return [];

  try {
    const raw = await fetchPages<TraktShow>("/shows/popular", pages, 100);
    const seen = new Set<number>();
    const result = raw
      .map(normalizeShow)
      .filter((m): m is TmdbMedia => m !== null && !seen.has(m.id) && (seen.add(m.id), true));
    if (result.length > 0) await setCache(key, result, TTL.DISCOVER);
    return result;
  } catch (err) {
    console.error("[trakt] Failed to fetch popular TV:", err);
    return [];
  }
}

export async function getTraktTrendingMovies(pages = 3): Promise<TmdbMedia[]> {
  const key = "trakt:trending:movies";
  const cached = await getCache<TmdbMedia[]>(key);
  if (cached?.length) return cached;

  const apiKey = await getApiKey();
  if (!apiKey) return [];

  try {
    const raw = await fetchPages<TraktTrendingMovie>("/movies/trending", pages, 100);
    const seen = new Set<number>();
    const result = raw
      .map((r) => normalizeMovie(r.movie))
      .filter((m): m is TmdbMedia => m !== null && !seen.has(m.id) && (seen.add(m.id), true));
    if (result.length > 0) await setCache(key, result, TTL.DISCOVER);
    return result;
  } catch (err) {
    console.error("[trakt] Failed to fetch trending movies:", err);
    return [];
  }
}

export async function getTraktTrendingTV(pages = 3): Promise<TmdbMedia[]> {
  const key = "trakt:trending:tv";
  const cached = await getCache<TmdbMedia[]>(key);
  if (cached?.length) return cached;

  const apiKey = await getApiKey();
  if (!apiKey) return [];

  try {
    const raw = await fetchPages<TraktTrendingShow>("/shows/trending", pages, 100);
    const seen = new Set<number>();
    const result = raw
      .map((r) => normalizeShow(r.show))
      .filter((m): m is TmdbMedia => m !== null && !seen.has(m.id) && (seen.add(m.id), true));
    if (result.length > 0) await setCache(key, result, TTL.DISCOVER);
    return result;
  } catch (err) {
    console.error("[trakt] Failed to fetch trending TV:", err);
    return [];
  }
}

export async function testTraktConnection(): Promise<string> {
  const movies = await traktFetch<TraktMovie[]>("/movies/popular", { limit: "1" });
  if (!movies.length) throw new Error("Empty response from Trakt");
  return movies[0].title;
}
