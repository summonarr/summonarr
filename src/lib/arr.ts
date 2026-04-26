import { prisma } from "./prisma";
import { safeFetchAdminConfigured, safeFetchTrusted } from "./safe-fetch";
import { sanitizeForLog } from "./sanitize";
import { getCache, setCache, TTL } from "./tmdb-cache";
import { tmdbAuth } from "./tmdb-auth";

const QUALITY_PROFILE_TTL_MS = 10 * 60 * 1000;
const QUEUE_STATE_TTL_MS = 15 * 1000;
const qualityProfileCache = new Map<string, { ids: Set<number> | null; expiresAt: number }>();
const queueCache = new Map<string, { tmdbIds: Set<number>; tvdbIds: Set<number>; expiresAt: number }>();

// Resolved mappings are stable for a year; unresolved ones re-try daily in case TMDB eventually adds the show
const TVDB_TO_TMDB_TTL_RESOLVED   = 365 * 24 * 60 * 60;
const TVDB_TO_TMDB_TTL_UNRESOLVED =        24 * 60 * 60;
type TvdbToTmdbCache = { tmdbId: number | null };

async function resolveTvdbToTmdb(tvdbIds: number[]): Promise<Map<number, number>> {
  const result = new Map<number, number>();
  if (tvdbIds.length === 0) return result;

  const uncached: number[] = [];
  for (const tvdbId of tvdbIds) {
    const cached = await getCache<TvdbToTmdbCache>(`tvdb-to-tmdb:${tvdbId}`);
    if (cached) {
      if (cached.tmdbId !== null) result.set(tvdbId, cached.tmdbId);
    } else {
      uncached.push(tvdbId);
    }
  }
  if (uncached.length === 0) return result;

  const reqRows = await prisma.mediaRequest.findMany({
    where: { mediaType: "TV", tvdbId: { in: uncached } },
    select: { tvdbId: true, tmdbId: true },
  });
  const fromReq = new Map(
    reqRows.filter((r) => r.tvdbId != null).map((r) => [r.tvdbId!, r.tmdbId])
  );
  const stillUnknown: number[] = [];
  for (const tvdbId of uncached) {
    const tmdbId = fromReq.get(tvdbId);
    if (tmdbId !== undefined) {
      result.set(tvdbId, tmdbId);
      await setCache(`tvdb-to-tmdb:${tvdbId}`, { tmdbId }, TVDB_TO_TMDB_TTL_RESOLVED);
    } else {
      stillUnknown.push(tvdbId);
    }
  }
  if (stillUnknown.length === 0) return result;

  const auth = tmdbAuth();
  if (!auth) return result;

  const CONCURRENCY = 5;
  for (let i = 0; i < stillUnknown.length; i += CONCURRENCY) {
    const batch = stillUnknown.slice(i, i + CONCURRENCY);
    await Promise.all(batch.map(async (tvdbId) => {
      try {
        const url = new URL(`https://api.themoviedb.org/3/find/${tvdbId}`);
        url.searchParams.set("external_source", "tvdb_id");
        for (const [k, v] of Object.entries(auth.query)) url.searchParams.set(k, v);
        const res = await safeFetchTrusted(url.toString(), {
          allowedHosts: ["api.themoviedb.org"],
          headers: auth.headers,
          timeoutMs: 10_000,
        });
        if (!res.ok) return;
        const data = await res.json() as { tv_results?: { id: number }[] };
        const tmdbId = data.tv_results?.[0]?.id ?? null;
        await setCache(
          `tvdb-to-tmdb:${tvdbId}`,
          { tmdbId } satisfies TvdbToTmdbCache,
          tmdbId !== null ? TVDB_TO_TMDB_TTL_RESOLVED : TVDB_TO_TMDB_TTL_UNRESOLVED,
        );
        if (tmdbId !== null) result.set(tvdbId, tmdbId);
      } catch {

      }
    }));
  }
  return result;
}

export type ArrCfg = { url: string; apiKey: string };

type ArrCfgFull = ArrCfg & { rootFolder?: string; qualityProfileId?: number };

export async function getArrCfg(service: "radarr" | "sonarr"): Promise<ArrCfg | null> {
  const cfg = await getCfg(service);
  if (!cfg) return null;
  return { url: cfg.url, apiKey: cfg.apiKey };
}

async function getCfg(service: "radarr" | "sonarr"): Promise<ArrCfgFull | null> {
  const urlKey      = service === "radarr" ? "radarrUrl"              : "sonarrUrl";
  const keyKey      = service === "radarr" ? "radarrApiKey"           : "sonarrApiKey";
  const folderKey   = service === "radarr" ? "radarrRootFolder"       : "sonarrRootFolder";
  const profileKey  = service === "radarr" ? "radarrQualityProfileId" : "sonarrQualityProfileId";
  const rows = await prisma.setting.findMany({
    where: { key: { in: [urlKey, keyKey, folderKey, profileKey] } },
  });
  const map = Object.fromEntries(rows.map((r) => [r.key, r.value]));
  if (!map[urlKey] || !map[keyKey]) return null;
  return {
    url: map[urlKey].replace(/\/$/, ""),
    apiKey: map[keyKey],
    rootFolder: map[folderKey],
    qualityProfileId: map[profileKey] ? Number(map[profileKey]) : undefined,
  };
}

export class ArrResponseError extends Error {
  constructor(
    public readonly status: number,
    public readonly body: string,
  ) {
    super(`Arr service returned a non-200 response (${status})`);
  }
}

const ARR_FETCH_TIMEOUT_MS = 30_000;

// Raised from 10 MB — libraries with >3k movies were being silently truncated at the old cap
const ARR_FETCH_MAX_BYTES = 50 * 1024 * 1024;

export async function arrFetch<T>(cfg: ArrCfg, path: string, options: RequestInit = {}): Promise<T> {

  const { signal, method, body } = options;
  const res = await safeFetchAdminConfigured(`${cfg.url}${path}`, {
    method,
    body,
    ...(signal ? { signal } : {}),
    cache: "no-store",
    timeoutMs: ARR_FETCH_TIMEOUT_MS,
    maxResponseBytes: ARR_FETCH_MAX_BYTES,
    headers: { "X-Api-Key": cfg.apiKey, "Content-Type": "application/json", ...(options.headers ?? {}) },
  });
  if (!res.ok) {
    const text = await res.text().catch(() => res.statusText);
    console.error(`[arr] ${sanitizeForLog(path)} → ${res.status}`);
    throw new ArrResponseError(res.status, text);
  }

  return res.json() as Promise<T>;
}

function isDuplicate(err: unknown): boolean {
  if (err instanceof ArrResponseError) {
    return err.status === 400 && /already (been )?added/i.test(err.body);
  }
  return /already (been )?added/i.test(String(err));
}

export function arrErrorMessage(err: unknown): string {
  if (err instanceof ArrResponseError) {
    if (err.status === 401 || err.status === 403) return `Arr authentication failed (${err.status}) — check the API key`;
    if (err.status === 404) return `Item not found in arr (${err.status})`;
    if (err.status >= 500) return `Arr server error (${err.status}) — check the arr service logs`;
    return `Arr request failed (${err.status})`;
  }
  if (err instanceof Error) return err.message;
  return "Arr request failed";
}

async function getAllowedQualityIds(cfg: ArrCfg, profileId?: number): Promise<Set<number> | null> {
  if (!profileId) return null;
  const cacheKey = `${cfg.url}::${profileId}`;
  const now = Date.now();
  const cached = qualityProfileCache.get(cacheKey);
  if (cached && cached.expiresAt > now) return cached.ids;
  try {
    const profiles = await arrFetch<{ id: number; items: { quality?: { id: number }; allowed: boolean; items?: { quality?: { id: number }; allowed: boolean }[] }[] }[]>(
      cfg, "/api/v3/qualityprofile"
    );
    const profile = profiles.find((p) => p.id === profileId);
    if (!profile) {
      qualityProfileCache.set(cacheKey, { ids: null, expiresAt: now + QUALITY_PROFILE_TTL_MS });
      return null;
    }
    const ids = new Set<number>();
    for (const item of profile.items) {
      if (!item.allowed) continue;
      if (item.items?.length) {
        for (const sub of item.items) {
          if (sub.allowed && sub.quality?.id != null) ids.add(sub.quality.id);
        }
      } else if (item.quality?.id != null) {
        ids.add(item.quality.id);
      }
    }
    qualityProfileCache.set(cacheKey, { ids, expiresAt: now + QUALITY_PROFILE_TTL_MS });
    return ids;
  } catch {
    return null;
  }
}

function filterAndSortReleases(releases: ArrRelease[], allowedIds: Set<number> | null): ArrRelease[] {
  const downloadable = releases.filter((r) => r.downloadAllowed);
  return downloadable.sort((a, b) => {
    const aMatch = allowedIds ? (allowedIds.has(a.quality.quality.id) ? 1 : 0) : 1;
    const bMatch = allowedIds ? (allowedIds.has(b.quality.quality.id) ? 1 : 0) : 1;
    if (bMatch !== aMatch) return bMatch - aMatch;
    if (b.qualityWeight !== a.qualityWeight) return b.qualityWeight - a.qualityWeight;
    return (b.seeders ?? 0) - (a.seeders ?? 0);
  });
}

export interface ArrRelease {
  guid: string;
  title: string;
  size: number;
  indexerId: number;
  indexer: string;
  quality: { quality: { id: number; name: string }; revision: { version: number } };
  qualityWeight: number;
  protocol: "torrent" | "usenet";
  seeders: number | null;
  leechers: number | null;
  age: number;
  rejected: boolean;
  rejections: string[];
  downloadAllowed: boolean;
}

export async function addMovieToRadarr(tmdbId: number): Promise<void> {
  const cfg = await getCfg("radarr");
  if (!cfg) throw new Error("Radarr is not configured");

  const [movies, rootFolders, profiles] = await Promise.all([
    arrFetch<{ title: string; tmdbId: number; year: number; images: object[]; titleSlug: string; digitalRelease?: string; physicalRelease?: string }[]>(
      cfg, `/api/v3/movie/lookup?term=tmdb:${tmdbId}`
    ),
    cfg.rootFolder
      ? Promise.resolve<{ path: string }[]>([])
      : arrFetch<{ path: string }[]>(cfg, "/api/v3/rootfolder"),
    cfg.qualityProfileId
      ? Promise.resolve<{ id: number }[]>([])
      : arrFetch<{ id: number }[]>(cfg, "/api/v3/qualityprofile"),
  ]);

  if (!movies.length) throw new Error(`Radarr: no movie found for tmdbId ${tmdbId}`);
  if (!cfg.rootFolder && !rootFolders.length) throw new Error("Radarr: no root folders configured");
  if (!cfg.qualityProfileId && !profiles.length) throw new Error("Radarr: no quality profiles configured");

  const rootFolderPath = cfg.rootFolder ?? rootFolders[0].path;
  const qualityProfileId = cfg.qualityProfileId ?? profiles[0].id;

  const movie = movies[0];
  const now = new Date();
  const releaseDates = [movie.digitalRelease, movie.physicalRelease]
    .filter(Boolean)
    .map((d) => new Date(d!));
  const movieReleased = releaseDates.length > 0
    ? releaseDates.some((d) => d <= now)
    : movie.year > 0 && movie.year < now.getFullYear();

  try {
    await arrFetch<unknown>(cfg, "/api/v3/movie", {
      method: "POST",
      body: JSON.stringify({
        ...movie,
        rootFolderPath,
        qualityProfileId,
        monitored: true,
        addOptions: { searchForMovie: movieReleased },
      }),
    });
  } catch (err) {
    if (isDuplicate(err)) {
      console.warn("[arr] movie already in Radarr — skipping add, request may need manual review", { tmdbId });
      return;
    }
    throw err;
  }
}

export async function getRadarrWantedTmdbIds(): Promise<{ wanted: Set<number>; available: Set<number> } | null> {
  const cfg = await getCfg("radarr");
  if (!cfg) return { wanted: new Set(), available: new Set() };
  try {
    const movies = await arrFetch<{ tmdbId: number; hasFile: boolean }[]>(cfg, "/api/v3/movie");
    const wanted = new Set(movies.filter((m) => !m.hasFile).map((m) => m.tmdbId));
    const available = new Set(movies.filter((m) => m.hasFile).map((m) => m.tmdbId));
    return { wanted, available };
  } catch (err) {
    console.error("[arr] getRadarrWantedTmdbIds failed:", err instanceof Error ? err.message : err);
    return null;
  }
}

export async function getSonarrWantedTmdbIds(): Promise<{ wanted: Set<number>; available: Set<number> } | null> {
  const cfg = await getCfg("sonarr");
  if (!cfg) return { wanted: new Set(), available: new Set() };
  try {
    const series = await arrFetch<{ tvdbId: number; tmdbId?: number; status: string; statistics: { episodeFileCount: number; totalEpisodeCount: number } }[]>(
      cfg, "/api/v3/series"
    );
    const wanted = new Set<number>();
    const available = new Set<number>();
    const wantedNeedsResolve: number[] = [];
    const availableNeedsResolve: number[] = [];
    for (const s of series) {

      const allDownloaded = s.statistics.episodeFileCount >= s.statistics.totalEpisodeCount;
      // Ongoing series with partial files are "available"; ended series only when fully downloaded
      const isAvailable = s.statistics.episodeFileCount > 0 &&
        (s.status !== "ended" || allDownloaded);
      const isWanted = !isAvailable;

      if (typeof s.tmdbId === "number" && Number.isInteger(s.tmdbId) && s.tmdbId > 0) {
        if (isWanted) wanted.add(s.tmdbId); else available.add(s.tmdbId);
      } else if (typeof s.tvdbId === "number" && Number.isInteger(s.tvdbId) && s.tvdbId > 0) {
        if (isWanted) wantedNeedsResolve.push(s.tvdbId); else availableNeedsResolve.push(s.tvdbId);
      }
    }
    const allNeedsResolve = [...new Set([...wantedNeedsResolve, ...availableNeedsResolve])];
    if (allNeedsResolve.length > 0) {
      const map = await resolveTvdbToTmdb(allNeedsResolve);
      for (const tvdbId of wantedNeedsResolve) {
        const tmdbId = map.get(tvdbId);
        if (tmdbId !== undefined) wanted.add(tmdbId);
      }
      for (const tvdbId of availableNeedsResolve) {
        const tmdbId = map.get(tvdbId);
        if (tmdbId !== undefined) available.add(tmdbId);
      }
    }
    return { wanted, available };
  } catch (err) {
    console.error("[arr] getSonarrWantedTmdbIds failed:", err instanceof Error ? err.message : err);
    return null;
  }
}

export async function getMovieReleaseInfo(tmdbId: number): Promise<{
  digitalRelease: string | null;
  physicalRelease: string | null;
} | null> {
  const auth = tmdbAuth();
  if (!auth) return null;
  const cacheKey = `movie:${tmdbId}:details`;
  try {
    type TmdbMovieDetails = { release_date?: string };
    let details = await getCache<TmdbMovieDetails>(cacheKey);
    if (!details) {
      const url = new URL(`https://api.themoviedb.org/3/movie/${tmdbId}`);
      for (const [k, v] of Object.entries(auth.query)) url.searchParams.set(k, v);
      const res = await safeFetchTrusted(url.toString(), {
        allowedHosts: ["api.themoviedb.org"],
        headers: auth.headers,
        timeoutMs: 10_000,
      });
      if (!res.ok) return null;
      details = await res.json() as TmdbMovieDetails;
      await setCache(cacheKey, details, TTL.DETAILS);
    }
    const releaseDate = details.release_date ?? null;
    return { digitalRelease: releaseDate, physicalRelease: releaseDate };
  } catch { return null; }
}

export async function getSeriesFirstAired(tmdbId: number): Promise<string | null> {
  const cfg = await getCfg("sonarr");
  if (!cfg) return null;
  try {
    const results = await arrFetch<{ firstAired?: string }[]>(
      cfg, `/api/v3/series/lookup?term=tmdb:${tmdbId}`
    );
    return results[0]?.firstAired ?? null;
  } catch { return null; }
}

export async function isMovieWantedInRadarr(tmdbId: number): Promise<boolean> {
  const cfg = await getCfg("radarr");
  if (!cfg) return false;
  try {
    const movies = await arrFetch<{ tmdbId: number; hasFile: boolean }[]>(
      cfg, `/api/v3/movie?tmdbId=${tmdbId}`
    );
    return movies.some((m) => m.tmdbId === tmdbId && !m.hasFile);
  } catch {
    return false;
  }
}

export async function isSeriesWantedInSonarr(tmdbId: number): Promise<boolean> {
  const cfg = await getCfg("sonarr");
  if (!cfg) return false;
  try {
    const lookup = await arrFetch<{ tvdbId: number }[]>(
      cfg, `/api/v3/series/lookup?term=tmdb:${tmdbId}`
    );
    if (!lookup.length) return false;
    const { tvdbId } = lookup[0];
    const library = await arrFetch<{ tvdbId: number; statistics: { episodeFileCount: number } }[]>(
      cfg, "/api/v3/series"
    );
    const match = library.find((s) => s.tvdbId === tvdbId);
    return !!match && match.statistics.episodeFileCount === 0;
  } catch {
    return false;
  }
}

export async function isMovieInRadarrLibrary(tmdbId: number): Promise<boolean> {
  const cfg = await getCfg("radarr");
  if (!cfg) return false;
  try {
    const movies = await arrFetch<{ tmdbId: number }[]>(
      cfg, `/api/v3/movie?tmdbId=${tmdbId}`
    );
    return movies.some((m) => m.tmdbId === tmdbId);
  } catch { return false; }
}

export async function isMovieAvailableInRadarr(tmdbId: number): Promise<boolean> {
  const cfg = await getCfg("radarr");
  if (!cfg) return false;
  try {
    const movies = await arrFetch<{ tmdbId: number; hasFile: boolean }[]>(
      cfg, `/api/v3/movie?tmdbId=${tmdbId}`
    );
    return movies.some((m) => m.tmdbId === tmdbId && m.hasFile);
  } catch { return false; }
}

export async function searchMovieInRadarr(tmdbId: number): Promise<void> {
  const cfg = await getCfg("radarr");
  if (!cfg) throw new Error("Radarr is not configured");
  const movies = await arrFetch<{ id: number; tmdbId: number }[]>(cfg, `/api/v3/movie?tmdbId=${tmdbId}`);
  const movie = movies.find((m) => m.tmdbId === tmdbId);
  if (!movie) throw new Error("Movie not found in Radarr library");
  await arrFetch<unknown>(cfg, "/api/v3/command", {
    method: "POST",
    body: JSON.stringify({ name: "MoviesSearch", movieIds: [movie.id] }),
  });
}

export async function getReleasesForMovie(tmdbId: number): Promise<ArrRelease[]> {
  const cfg = await getCfg("radarr");
  if (!cfg) throw new Error("Radarr is not configured");

  const movies = await arrFetch<{ id: number; tmdbId: number }[]>(cfg, `/api/v3/movie?tmdbId=${tmdbId}`);
  const movie = movies.find((m) => m.tmdbId === tmdbId);
  if (!movie) throw new Error("Movie not found in Radarr library");

  const [releases, allowedQualityIds] = await Promise.all([
    arrFetch<ArrRelease[]>(cfg, `/api/v3/release?movieId=${movie.id}`),
    getAllowedQualityIds(cfg, cfg.qualityProfileId),
  ]);

  return filterAndSortReleases(releases, allowedQualityIds);
}

export async function grabMovieRelease(tmdbId: number, guid: string, indexerId: number): Promise<void> {
  const cfg = await getCfg("radarr");
  if (!cfg) throw new Error("Radarr is not configured");

  const movies = await arrFetch<{ id: number; tmdbId: number }[]>(cfg, `/api/v3/movie?tmdbId=${tmdbId}`);
  const movie = movies.find((m) => m.tmdbId === tmdbId);
  if (!movie) throw new Error("Movie not found in Radarr library");

  await arrFetch<unknown>(cfg, "/api/v3/release", {
    method: "POST",
    body: JSON.stringify({ guid, indexerId, movieId: movie.id }),
  });
}

async function getRadarrQueueSet(cfg: ArrCfg): Promise<Set<number>> {
  const now = Date.now();
  const cacheKey = `radarr::${cfg.url}`;
  const cached = queueCache.get(cacheKey);
  if (cached && cached.expiresAt > now) return cached.tmdbIds;
  try {
    const queue = await arrFetch<{ records: { movie?: { tmdbId: number } }[] }>(
      cfg, "/api/v3/queue?pageSize=200&includeMovie=true"
    );
    const tmdbIds = new Set<number>();
    for (const r of queue.records) {
      if (r.movie?.tmdbId) tmdbIds.add(r.movie.tmdbId);
    }
    queueCache.set(cacheKey, { tmdbIds, tvdbIds: new Set(), expiresAt: now + QUEUE_STATE_TTL_MS });
    return tmdbIds;
  } catch (err) {
    if (cached) {
      console.warn("[arr] getRadarrQueueSet failed, serving stale queue data:", err instanceof Error ? err.message : err);
      return cached.tmdbIds;
    }
    console.error("[arr] getRadarrQueueSet failed, no cache:", err instanceof Error ? err.message : err);
    return new Set();
  }
}

async function getSonarrQueueSet(cfg: ArrCfg): Promise<Set<number>> {
  const now = Date.now();
  const cacheKey = `sonarr::${cfg.url}`;
  const cached = queueCache.get(cacheKey);
  if (cached && cached.expiresAt > now) return cached.tvdbIds;
  try {
    const queue = await arrFetch<{ records: { series?: { tvdbId: number } }[] }>(
      cfg, "/api/v3/queue?pageSize=200&includeSeries=true"
    );
    const tvdbIds = new Set<number>();
    for (const r of queue.records) {
      if (r.series?.tvdbId) tvdbIds.add(r.series.tvdbId);
    }
    queueCache.set(cacheKey, { tmdbIds: new Set(), tvdbIds, expiresAt: now + QUEUE_STATE_TTL_MS });
    return tvdbIds;
  } catch (err) {
    if (cached) {
      console.warn("[arr] getSonarrQueueSet failed, serving stale queue data:", err instanceof Error ? err.message : err);
      return cached.tvdbIds;
    }
    console.error("[arr] getSonarrQueueSet failed, no cache:", err instanceof Error ? err.message : err);
    return new Set();
  }
}

export async function isMovieDownloadingInRadarr(tmdbId: number): Promise<boolean> {
  const cfg = await getCfg("radarr");
  if (!cfg) return false;
  try {
    const queueSet = await getRadarrQueueSet(cfg);
    return queueSet.has(tmdbId);
  } catch { return false; }
}

export async function countRadarrQueue(): Promise<number | null> {
  try {
    const cfg = await getCfg("radarr");
    if (!cfg) return null;
    const queueSet = await getRadarrQueueSet(cfg);
    return queueSet.size;
  } catch { return null; }
}

export async function isSeriesDownloadingInSonarr(tmdbId: number): Promise<boolean> {
  const cfg = await getCfg("sonarr");
  if (!cfg) return false;
  try {
    const lookup = await arrFetch<{ tvdbId: number }[]>(
      cfg, `/api/v3/series/lookup?term=tmdb:${tmdbId}`
    );
    if (!lookup.length) return false;
    const { tvdbId } = lookup[0];
    const queueSet = await getSonarrQueueSet(cfg);
    return queueSet.has(tvdbId);
  } catch { return false; }
}

export async function countSonarrQueue(): Promise<number | null> {
  try {
    const cfg = await getCfg("sonarr");
    if (!cfg) return null;
    const queueSet = await getSonarrQueueSet(cfg);
    return queueSet.size;
  } catch { return null; }
}

export async function testRadarrConnection(url: string, apiKey: string): Promise<string> {
  const cfg = { url: url.replace(/\/$/, ""), apiKey };
  const status = await arrFetch<{ version: string }>(cfg, "/api/v3/system/status");
  return status.version;
}

export async function getReleasesForSeries(
  tvdbId: number,
  scope: "FULL" | "SEASON" | "EPISODE",
  seasonNumber?: number | null,
  episodeNumber?: number | null,
): Promise<ArrRelease[]> {
  const cfg = await getCfg("sonarr");
  if (!cfg) throw new Error("Sonarr is not configured");

  const library = await arrFetch<{ id: number; tvdbId: number }[]>(cfg, "/api/v3/series");
  const series = library.find((s) => s.tvdbId === tvdbId);
  if (!series) throw new Error("Series not found in Sonarr library");

  let releasePath: string;
  if (scope === "EPISODE" && seasonNumber != null && episodeNumber != null) {
    const episodes = await arrFetch<{ id: number; seasonNumber: number; episodeNumber: number }[]>(
      cfg, `/api/v3/episode?seriesId=${series.id}`
    );
    const ep = episodes.find((e) => e.seasonNumber === seasonNumber && e.episodeNumber === episodeNumber);
    if (!ep) throw new Error(`Episode S${seasonNumber}E${episodeNumber} not found in Sonarr`);
    releasePath = `/api/v3/release?episodeId=${ep.id}`;
  } else if (scope === "SEASON" && seasonNumber != null) {
    releasePath = `/api/v3/release?seriesId=${series.id}&seasonNumber=${seasonNumber}`;
  } else {
    releasePath = `/api/v3/release?seriesId=${series.id}`;
  }

  const [releases, allowedQualityIds] = await Promise.all([
    arrFetch<ArrRelease[]>(cfg, releasePath),
    getAllowedQualityIds(cfg, cfg.qualityProfileId),
  ]);

  return filterAndSortReleases(releases, allowedQualityIds);
}

export async function grabSeriesRelease(
  tvdbId: number,
  guid: string,
  indexerId: number,
  seasonNumber?: number | null,
  episodeNumber?: number | null,
): Promise<void> {
  const cfg = await getCfg("sonarr");
  if (!cfg) throw new Error("Sonarr is not configured");

  const library = await arrFetch<{ id: number; tvdbId: number }[]>(cfg, "/api/v3/series");
  const series = library.find((s) => s.tvdbId === tvdbId);
  if (!series) throw new Error("Series not found in Sonarr library");

  let episodeId: number | undefined;
  if (seasonNumber != null && episodeNumber != null) {
    const episodes = await arrFetch<{ id: number; seasonNumber: number; episodeNumber: number }[]>(
      cfg, `/api/v3/episode?seriesId=${series.id}`
    );
    const ep = episodes.find((e) => e.seasonNumber === seasonNumber && e.episodeNumber === episodeNumber);
    if (ep) episodeId = ep.id;
  }

  await arrFetch<unknown>(cfg, "/api/v3/release", {
    method: "POST",
    body: JSON.stringify({ guid, indexerId, seriesId: series.id, ...(episodeId != null && { episodeId }) }),
  });
}

export async function addSeriesToSonarr(tmdbId: number): Promise<number> {
  const cfg = await getCfg("sonarr");
  if (!cfg) throw new Error("Sonarr is not configured");

  const [results, rootFolders, profiles] = await Promise.all([
    arrFetch<{ title: string; tvdbId: number; year: number; images: object[]; titleSlug: string; seasons: { seasonNumber: number; monitored: boolean }[]; firstAired?: string }[]>(
      cfg, `/api/v3/series/lookup?term=tmdb:${tmdbId}`
    ),
    cfg.rootFolder
      ? Promise.resolve<{ path: string }[]>([])
      : arrFetch<{ path: string }[]>(cfg, "/api/v3/rootfolder"),
    cfg.qualityProfileId
      ? Promise.resolve<{ id: number }[]>([])
      : arrFetch<{ id: number }[]>(cfg, "/api/v3/qualityprofile"),
  ]);

  if (!results.length) throw new Error(`Sonarr: no series found for tmdbId ${tmdbId}`);
  if (!cfg.rootFolder && !rootFolders.length) throw new Error("Sonarr: no root folders configured");
  if (!cfg.qualityProfileId && !profiles.length) throw new Error("Sonarr: no quality profiles configured");

  const series = results[0];
  const seriesReleased = series.firstAired
    ? new Date(series.firstAired) <= new Date()
    : series.year < new Date().getFullYear();

  const rootFolderPath = cfg.rootFolder ?? rootFolders[0].path;
  const qualityProfileId = cfg.qualityProfileId ?? profiles[0].id;

  try {
    await arrFetch<unknown>(cfg, "/api/v3/series", {
      method: "POST",
      body: JSON.stringify({
        ...series,
        seasons: series.seasons.map((s) => ({ ...s, monitored: s.seasonNumber > 0 })),
        rootFolderPath,
        qualityProfileId,
        monitored: true,
        addOptions: { searchForMissingEpisodes: seriesReleased },
      }),
    });
  } catch (err) {
    if (isDuplicate(err)) {
      console.warn("[arr] series already in Sonarr — skipping add, request may need manual review", { tmdbId });
    } else {
      throw err;
    }
  }

  return series.tvdbId;
}

export async function isSeriesInSonarrLibrary(tmdbId: number): Promise<boolean> {
  const cfg = await getCfg("sonarr");
  if (!cfg) return false;
  try {
    const lookup = await arrFetch<{ tvdbId: number }[]>(
      cfg, `/api/v3/series/lookup?term=tmdb:${tmdbId}`
    );
    if (!lookup.length) return false;
    const { tvdbId } = lookup[0];
    const library = await arrFetch<{ tvdbId: number }[]>(cfg, "/api/v3/series");
    return library.some((s) => s.tvdbId === tvdbId);
  } catch { return false; }
}

export async function isSeriesAvailableInSonarr(tmdbId: number): Promise<boolean> {
  const cfg = await getCfg("sonarr");
  if (!cfg) return false;
  try {
    const lookup = await arrFetch<{ tvdbId: number }[]>(
      cfg, `/api/v3/series/lookup?term=tmdb:${tmdbId}`
    );
    if (!lookup.length) return false;
    const { tvdbId } = lookup[0];
    const library = await arrFetch<{ tvdbId: number; statistics: { episodeFileCount: number } }[]>(
      cfg, "/api/v3/series"
    );
    const match = library.find((s) => s.tvdbId === tvdbId);
    return !!match && match.statistics.episodeFileCount > 0;
  } catch { return false; }
}

export async function searchSeriesInSonarr(tvdbId: number): Promise<void> {
  const cfg = await getCfg("sonarr");
  if (!cfg) throw new Error("Sonarr is not configured");
  const library = await arrFetch<{ id: number; tvdbId: number }[]>(cfg, "/api/v3/series");
  const series = library.find((s) => s.tvdbId === tvdbId);
  if (!series) throw new Error("Series not found in Sonarr library");
  await arrFetch<unknown>(cfg, "/api/v3/command", {
    method: "POST",
    body: JSON.stringify({ name: "SeriesSearch", seriesId: series.id }),
  });
}

export async function searchSeasonInSonarr(tvdbId: number, seasonNumber: number): Promise<void> {
  const cfg = await getCfg("sonarr");
  if (!cfg) throw new Error("Sonarr is not configured");
  const library = await arrFetch<{ id: number; tvdbId: number }[]>(cfg, "/api/v3/series");
  const series = library.find((s) => s.tvdbId === tvdbId);
  if (!series) throw new Error("Series not found in Sonarr library");
  await arrFetch<unknown>(cfg, "/api/v3/command", {
    method: "POST",
    body: JSON.stringify({ name: "SeasonSearch", seriesId: series.id, seasonNumber }),
  });
}

export async function searchEpisodeInSonarr(tvdbId: number, seasonNumber: number, episodeNumber: number): Promise<void> {
  const cfg = await getCfg("sonarr");
  if (!cfg) throw new Error("Sonarr is not configured");
  const library = await arrFetch<{ id: number; tvdbId: number }[]>(cfg, "/api/v3/series");
  const series = library.find((s) => s.tvdbId === tvdbId);
  if (!series) throw new Error("Series not found in Sonarr library");
  const episodes = await arrFetch<{ id: number; seasonNumber: number; episodeNumber: number }[]>(
    cfg, `/api/v3/episode?seriesId=${series.id}`
  );
  const episode = episodes.find(
    (e) => e.seasonNumber === seasonNumber && e.episodeNumber === episodeNumber
  );
  if (!episode) throw new Error(`Episode S${seasonNumber}E${episodeNumber} not found in Sonarr`);
  await arrFetch<unknown>(cfg, "/api/v3/command", {
    method: "POST",
    body: JSON.stringify({ name: "EpisodeSearch", episodeIds: [episode.id] }),
  });
}

export async function resolveTvdbIdFromTmdbId(tmdbId: number): Promise<number | null> {
  const cfg = await getCfg("sonarr");
  if (!cfg) return null;
  try {
    const library = await arrFetch<{ tvdbId: number; tmdbId?: number }[]>(cfg, "/api/v3/series");
    const libMatch = library.find((s) => s.tmdbId === tmdbId);
    if (libMatch) return libMatch.tvdbId;
    const results = await arrFetch<{ tvdbId: number }[]>(cfg, `/api/v3/series/lookup?term=tmdb:${tmdbId}`);
    return results[0]?.tvdbId ?? null;
  } catch {
    return null;
  }
}

export async function testSonarrConnection(url: string, apiKey: string): Promise<string> {
  const cfg = { url: url.replace(/\/$/, ""), apiKey };
  const status = await arrFetch<{ version: string }>(cfg, "/api/v3/system/status");
  return status.version;
}
