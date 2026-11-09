import nodePath from "node:path";
import { getCache, tmdbDetailsKey } from "./tmdb-cache";
import { processSingleton } from "./process-singleton";
import { PLEX_CLIENT_ID } from "./plex-http";
import { PLEX_PRODUCT } from "./plex-client-headers";

// Helpers the fix-match routes share (the POST, candidates, file-info): one
// definition of how a library path is compared with a Radarr/Sonarr folder, how
// a cached TMDB title is read, and the Plex admin headers.

/**
 * A library or arr path made comparable: Windows separators folded,
 * posix-normalised, then the trailing separator dropped. Normalising FIRST
 * matters: normalize collapses a run of separators but keeps a trailing one, so
 * stripping before it left "/movies//" as "/movies/", which never matched.
 * A blank (or degenerate) path is "" — never ".", which `posix.normalize("")`
 * returns and which is truthy, so a presence check on it passed for a row with
 * no path at all. The root alone ("/") is degenerate too.
 */
export function normaliseLibraryPath(raw: string | null | undefined): string {
  if (typeof raw !== "string" || !raw.trim()) return "";
  const n = nodePath.posix.normalize(raw.replace(/\\/g, "/"));
  // A scan, never a /\/+$/ regex (guardrail 5i: it backtracks over a run).
  let end = n.length;
  while (end > 0 && n.charCodeAt(end - 1) === 47 /* "/" */) end--;
  const trimmed = n.slice(0, end);
  return trimmed === "." ? "" : trimmed;
}

/**
 * Whether the library path (already normalised) is the arr folder itself or sits
 * under it — which covers a movie file, an episode file and a series folder
 * alike. A missing path on either side is never "within".
 */
export function pathWithin(arrPathRaw: string | null | undefined, libraryPath: string): boolean {
  const arrPath = normaliseLibraryPath(arrPathRaw);
  return !!arrPath && !!libraryPath && (arrPath === libraryPath || libraryPath.startsWith(arrPath + "/"));
}

/**
 * The row the requested server holds with a path, else any server's with a
 * path — the display hint for the OTHER side of a bad match, which can sit on a
 * different instance than the one the fix targets.
 */
export function rowWithPathFor<T extends { serverInstance: string; filePath: string | null }>(
  rows: readonly T[],
  serverInstance: string,
): T | null {
  return rows.find((r) => r.serverInstance === serverInstance && r.filePath)
    ?? rows.find((r) => r.filePath)
    ?? null;
}

export function tmdbDetailsCacheKey(mediaType: "MOVIE" | "TV", tmdbId: number): string {
  return tmdbDetailsKey(mediaType, tmdbId);
}

/** The cached TMDB title for an id — an expired row is a miss (getCache). */
export async function cachedTmdbTitle(mediaType: "MOVIE" | "TV", tmdbId: number): Promise<string | null> {
  const p = await getCache<{ title?: unknown; name?: unknown }>(tmdbDetailsCacheKey(mediaType, tmdbId));
  const title = p?.title ?? p?.name;
  return typeof title === "string" ? title : null;
}

/** Headers for an admin-token call to a configured Plex server. */
export function plexAdminHeaders(token: string): Record<string, string> {
  return {
    Accept: "application/json",
    "X-Plex-Token": token,
    "X-Plex-Client-Identifier": PLEX_CLIENT_ID,
    "X-Plex-Product": PLEX_PRODUCT,
    "User-Agent": "Summonarr/1.0 (Node.js)",
  };
}

// One whole Radarr/Sonarr list per instance, kept for a minute and shared by
// concurrent callers. Sonarr cannot filter its series list by TMDB id, and the
// file-info fallback has no id to filter by, so each open of a picker used to
// download the whole table (up to the 50 MB arr cap); a bulk run of fixes now
// reads it once. Display-only (a hint for the dialog): the POST never reads it.
// A failed load is dropped at once, so the next caller retries.
const ARR_LIST_TTL_MS = 60_000;
type ArrListEntry = { at: number; rows: Promise<unknown> };
const arrLists = processSingleton("fix-match:arr-lists", () => new Map<string, ArrListEntry>());

export function cachedArrList(
  service: "radarr" | "sonarr",
  instance: string,
  load: () => Promise<unknown>,
  now: number = Date.now(),
): Promise<unknown> {
  const key = `${service}:${instance}`;
  const hit = arrLists.get(key);
  if (hit && now - hit.at < ARR_LIST_TTL_MS) return hit.rows;
  const entry: ArrListEntry = { at: now, rows: Promise.resolve().then(load) };
  arrLists.set(key, entry);
  entry.rows.catch(() => {
    if (arrLists.get(key) === entry) arrLists.delete(key);
  });
  return entry.rows;
}

/** Test seam: the list cache is process state. */
export function _clearArrListCacheForTests(): void {
  arrLists.clear();
}

/** The one TMDB host fix-match reads (details and external ids). */
export const TMDB_HOSTS = ["api.themoviedb.org"];

/** The `Guid[].id` strings of a Plex metadata item or search result. */
export function plexGuidIds(item: unknown): string[] {
  if (typeof item !== "object" || item === null || Array.isArray(item)) return [];
  const guids = (item as { Guid?: unknown }).Guid;
  if (!Array.isArray(guids)) return [];
  const ids: string[] = [];
  for (const g of guids) {
    if (typeof g === "object" && g !== null && !Array.isArray(g) && typeof (g as { id?: unknown }).id === "string") {
      ids.push((g as { id: string }).id);
    }
  }
  return ids;
}

// The parameter sets of Plex's /library/metadata/<key>/matches searches. The
// candidate picker and the remap run the same five searches, so a changed
// agent or parameter is changed once, here.
const PLEX_MATCH_BASE = { manual: "1", includeGuids: "1" } as const;

export const plexImdbGuidSearch = (imdbId: string): Record<string, string> =>
  ({ ...PLEX_MATCH_BASE, guid: `imdb://${imdbId}` });
export const plexImdbAgentSearch = (imdbId: string): Record<string, string> =>
  ({ ...PLEX_MATCH_BASE, q: imdbId, agent: "com.plexapp.agents.imdb", language: "en" });
export const plexTmdbAgentSearch = (tmdbId: number): Record<string, string> =>
  ({ ...PLEX_MATCH_BASE, q: String(tmdbId), agent: "com.plexapp.agents.themoviedb", language: "en" });
export function plexTitleYearSearch(title: string, year: string): Record<string, string> {
  const params: Record<string, string> = { ...PLEX_MATCH_BASE };
  if (title) params.title = title;
  if (year) params.year = year;
  return params;
}
