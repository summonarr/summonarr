import { prisma } from "@/lib/prisma";
import { TTL, getCache, setCache } from "@/lib/tmdb-cache";

// Bad-match computation for native admin clients.
//
// MIRROR: src/app/(app)/admin/library/page.tsx computes this inline (alongside
// the full library diff + stats, which this omits). Keep the path-stripping,
// conflict-detection, and ARR-verdict logic here in sync with that page. The web
// page is the richer surface; this is the headless subset the iOS client needs.

const LIBRARY_ITEM_CAP = 25_000;

export interface BadMatchSide {
  tmdbId: number;
  mediaType: "MOVIE" | "TV";
  title: string | null;
  posterPath: string | null;
  releaseYear: string | null;
}

export interface BadMatchItem {
  relativePath: string;
  plex: BadMatchSide;
  plexRatingKey: string | null;
  jellyfin: BadMatchSide;
  jellyfinItemId: string | null;
  arrTmdbId: number | null;
  arrVerdict: "plex" | "jellyfin" | null;
}

// Longest shared directory prefix across a set of file paths — the inferred
// mount point that stripMountPoint peels off so paths compare across servers.
function commonPathPrefix(paths: (string | null)[]): string {
  const valid = paths.filter((p): p is string => p !== null && p.length > 0);
  if (valid.length === 0) return "";
  const segmented = valid.map((p) => p.replace(/\\/g, "/").split("/").filter(Boolean));
  const first = segmented[0];
  let commonLen = first.length - 1;
  for (const segs of segmented.slice(1)) {
    let i = 0;
    while (i < commonLen && i < segs.length - 1 && first[i] === segs[i]) i++;
    commonLen = i;
    if (commonLen === 0) return "";
  }
  if (commonLen === 0) return "";
  const sep = valid[0].startsWith("/") ? "/" : "";
  return sep + first.slice(0, commonLen).join("/") + "/";
}

function stripMountPoint(filePath: string | null, mountPoint: string): string | null {
  if (!filePath) return null;
  const normalised = filePath.replace(/\\/g, "/");
  if (mountPoint && normalised.startsWith(mountPoint)) return normalised.slice(mountPoint.length);
  return normalised;
}

function normaliseRelPath(rel: string, stripPrefix: string): string {
  if (!stripPrefix) return rel;
  const p = stripPrefix.endsWith("/") ? stripPrefix : stripPrefix + "/";
  return rel.startsWith(p) ? rel.slice(p.length) : rel;
}

function folderOf(filePath: string): string {
  return filePath.replace(/\\/g, "/").replace(/\/[^/]+$/, "");
}

function toMatchKey(rel: string, mediaType: "MOVIE" | "TV"): string {
  if (mediaType === "TV") return rel.split("/")[0];
  return rel;
}

async function buildArrPathMap(mediaType: "MOVIE" | "TV"): Promise<Map<string, number>> {
  // `:name` suffix — this map keys by folder BASENAME, while the web library
  // page (admin/library/page.tsx) caches a FULL-normalized-path map under
  // `arr:<service>:paths`. Sharing that key let whichever surface ran first
  // poison the other for the whole TTL.ARR_PATHS window (basename lookups
  // against full-path keys — or vice versa — all miss, so every arrVerdict
  // silently reads null). Keep the two keys distinct.
  const cacheKey = `arr:${mediaType === "MOVIE" ? "radarr" : "sonarr"}:paths:name`;
  const cached = await getCache<[string, number][]>(cacheKey);
  if (cached) return new Map(cached);

  const map = new Map<string, number>();
  try {
    const [urlRow, keyRow] = await Promise.all([
      prisma.setting.findUnique({ where: { key: mediaType === "MOVIE" ? "radarrUrl" : "sonarrUrl" } }),
      prisma.setting.findUnique({ where: { key: mediaType === "MOVIE" ? "radarrApiKey" : "sonarrApiKey" } }),
    ]);
    if (!urlRow?.value || !keyRow?.value) return map;

    const { arrFetch } = await import("@/lib/arr");
    const endpoint = mediaType === "MOVIE" ? "movie" : "series";
    const cfg = { url: urlRow.value.replace(/\/$/, ""), apiKey: keyRow.value };
    type ArrItem = { tmdbId?: number; path?: string };
    // arrFetch (not a bare safeFetchAdminConfigured): it carries the 50 MB body
    // cap. The default 10 MB silently truncated large libraries (guardrail 5 /
    // commit c7902db), leaving every arrVerdict past the cut null with no log.
    // arrFetch throws ArrResponseError on non-2xx, handled by the catch below.
    const items = await arrFetch<ArrItem[]>(cfg, `/api/v3/${endpoint}`);
    for (const item of items) {
      if (!item.tmdbId || !item.path) continue;
      // Key by the folder BASENAME, not the absolute path — Plex and Radarr/Sonarr
      // usually have different bind-mount roots (/plexmedia vs /data), so absolute
      // paths never match. Basenames ("Movie (2020)") line up across mounts.
      const folderName = item.path.replace(/\\/g, "/").replace(/\/$/, "").split("/").pop();
      if (folderName) map.set(folderName, item.tmdbId);
    }
    await setCache(cacheKey, [...map.entries()], TTL.ARR_PATHS);
  } catch (err) {
    // Don't swallow silently — a missing arr map makes every bad-match verdict
    // null, which previously looked like "no problems found".
    console.warn("[bad-matches] ARR path map fetch failed:", err instanceof Error ? err.message : err);
  }
  return map;
}

/**
 * Poster paths keyed by `${tmdbId}:${mediaType}`. TmdbMediaCore first — plain
 * `posterPath` column, no `:details` blob transfer/parse. Core rows expire and
 * get purged, so pairs missing from core fall back to the TMDB details cache.
 */
async function posterPathMap(
  items: { tmdbId: number; mediaType: "MOVIE" | "TV" }[],
): Promise<Map<string, string | null>> {
  const out = new Map<string, string | null>();
  if (items.length === 0) return out;

  const pairs = [...new Map(items.map((i) => [`${i.tmdbId}:${i.mediaType}`, i])).values()];
  const coreRows = await prisma.tmdbMediaCore.findMany({
    where: { OR: pairs.map((p) => ({ tmdbId: p.tmdbId, mediaType: p.mediaType })) },
    select: { tmdbId: true, mediaType: true, posterPath: true },
  });
  // Skip null-poster core rows so they fall through to the blob fallback below
  // (consistent with poster-cache.ts — the blob may still carry a poster).
  for (const r of coreRows) {
    if (r.posterPath != null) out.set(`${r.tmdbId}:${r.mediaType}`, r.posterPath);
  }

  const misses = pairs.filter((p) => !out.has(`${p.tmdbId}:${p.mediaType}`));
  if (misses.length === 0) return out;

  const cacheKeys = misses.map((i) => `${i.mediaType === "MOVIE" ? "movie" : "tv"}:${i.tmdbId}:details`);
  const rows = await prisma.tmdbCache.findMany({
    where: { key: { in: cacheKeys } },
    select: { key: true, data: true },
  });
  for (const row of rows) {
    try {
      const parsed = JSON.parse(row.data) as { posterPath?: string | null };
      const parts = row.key.split(":");
      const mediaType = parts[0] === "movie" ? "MOVIE" : "TV";
      const tmdbId = parseInt(parts[1], 10);
      if (!isNaN(tmdbId)) out.set(`${tmdbId}:${mediaType}`, parsed.posterPath ?? null);
    } catch {}
  }
  return out;
}

type PathEntry = {
  tmdbId: number;
  mediaType: "MOVIE" | "TV";
  filePath: string;
  key: string | null; // ratingKey (plex) or itemId (jellyfin)
  title: string | null;
  year: string | null;
};

export async function getBadMatches(activeType?: "MOVIE" | "TV"): Promise<BadMatchItem[]> {
  const [plexItems, jellyfinItems, prefixRows] = await Promise.all([
    prisma.plexLibraryItem.findMany({
      select: { tmdbId: true, mediaType: true, filePath: true, plexRatingKey: true, title: true, year: true },
      take: LIBRARY_ITEM_CAP,
    }),
    prisma.jellyfinLibraryItem.findMany({
      select: { tmdbId: true, mediaType: true, filePath: true, jellyfinItemId: true, title: true, year: true },
      take: LIBRARY_ITEM_CAP,
    }),
    prisma.setting.findMany({
      where: { key: { in: ["plexMoviePathStripPrefix", "plexTvPathStripPrefix", "jellyfinMoviePathStripPrefix", "jellyfinTvPathStripPrefix"] } },
    }),
  ]);

  const prefixCfg = Object.fromEntries(prefixRows.map((r) => [r.key, r.value]));
  const plexMovieStrip = prefixCfg.plexMoviePathStripPrefix ?? "";
  const plexTvStrip = prefixCfg.plexTvPathStripPrefix ?? "";
  const jfMovieStrip = prefixCfg.jellyfinMoviePathStripPrefix ?? "";
  const jfTvStrip = prefixCfg.jellyfinTvPathStripPrefix ?? "";

  const plexMount = commonPathPrefix(plexItems.map((i) => i.filePath));
  const jfMount = commonPathPrefix(jellyfinItems.map((i) => i.filePath));

  const plexPathMap = new Map<string, PathEntry>();
  for (const item of plexItems) {
    if (!item.filePath) continue;
    const rel = stripMountPoint(item.filePath, plexMount);
    if (!rel) continue;
    const strip = item.mediaType === "MOVIE" ? plexMovieStrip : plexTvStrip;
    plexPathMap.set(toMatchKey(normaliseRelPath(rel, strip), item.mediaType), {
      tmdbId: item.tmdbId, mediaType: item.mediaType, filePath: item.filePath,
      key: item.plexRatingKey, title: item.title, year: item.year,
    });
  }

  const jfPathMap = new Map<string, PathEntry>();
  for (const item of jellyfinItems) {
    if (!item.filePath) continue;
    const rel = stripMountPoint(item.filePath, jfMount);
    if (!rel) continue;
    const strip = item.mediaType === "MOVIE" ? jfMovieStrip : jfTvStrip;
    jfPathMap.set(toMatchKey(normaliseRelPath(rel, strip), item.mediaType), {
      tmdbId: item.tmdbId, mediaType: item.mediaType, filePath: item.filePath,
      key: item.jellyfinItemId, title: item.title, year: item.year,
    });
  }

  const raw: { relativePath: string; plex: PathEntry; jellyfin: PathEntry }[] = [];
  for (const [relPath, plexItem] of plexPathMap) {
    const jellyfinItem = jfPathMap.get(relPath);
    if (!jellyfinItem) continue;
    if (plexItem.tmdbId !== jellyfinItem.tmdbId || plexItem.mediaType !== jellyfinItem.mediaType) {
      raw.push({ relativePath: relPath, plex: plexItem, jellyfin: jellyfinItem });
    }
  }

  const filtered = activeType
    ? raw.filter((m) => m.plex.mediaType === activeType || m.jellyfin.mediaType === activeType)
    : raw;

  const [posters, movieArr, tvArr] = await Promise.all([
    posterPathMap(filtered.flatMap((m) => [m.plex, m.jellyfin])),
    buildArrPathMap("MOVIE"),
    buildArrPathMap("TV"),
  ]);

  const side = (e: PathEntry): BadMatchSide => ({
    tmdbId: e.tmdbId,
    mediaType: e.mediaType,
    title: e.title,
    posterPath: posters.get(`${e.tmdbId}:${e.mediaType}`) ?? null,
    releaseYear: e.year,
  });

  return filtered.map((m) => {
    const arrMap = m.plex.mediaType === "MOVIE" ? movieArr : tvArr;
    // Match the arr map key (buildArrPathMap keys by the arr path basename): for
    // TV that's the SERIES folder — m.relativePath is already reduced to it by
    // toMatchKey — while for movies it's the movie's own folder (the file's
    // parent). Using folderOf for TV yields the SEASON folder and never matches
    // Sonarr, so split by mediaType (same selector as movieArr/tvArr above).
    const folder = m.plex.mediaType === "TV"
      ? m.relativePath
      : (folderOf(m.plex.filePath) || folderOf(m.jellyfin.filePath)).split("/").pop() ?? "";
    const arrTmdbId = arrMap.get(folder) ?? null;

    let arrVerdict: "plex" | "jellyfin" | null = null;
    if (arrTmdbId !== null) {
      const plexCorrect = m.plex.tmdbId === arrTmdbId;
      const jellyfinCorrect = m.jellyfin.tmdbId === arrTmdbId;
      if (plexCorrect && !jellyfinCorrect) arrVerdict = "jellyfin";
      if (!plexCorrect && jellyfinCorrect) arrVerdict = "plex";
    }

    return {
      relativePath: m.relativePath,
      plex: side(m.plex),
      plexRatingKey: m.plex.key,
      jellyfin: side(m.jellyfin),
      jellyfinItemId: m.jellyfin.key,
      arrTmdbId,
      arrVerdict,
    };
  });
}
