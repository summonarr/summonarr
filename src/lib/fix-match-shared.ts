import nodePath from "node:path";
import { getCache, tmdbDetailsKey } from "./tmdb-cache";
import { processSingleton } from "./process-singleton";

// Helpers the fix-match routes share (the POST, candidates, file-info): one
// definition of how a library path is compared with a Radarr/Sonarr folder, how
// a cached TMDB title is read, and the Plex admin headers.

/**
 * A library or arr path made comparable: Windows separators folded, one
 * trailing separator dropped, posix-normalised. A blank (or degenerate) path is
 * "" — never ".", which `posix.normalize("")` returns and which is truthy, so a
 * presence check on it passed for a row with no path at all.
 */
export function normaliseLibraryPath(raw: string | null | undefined): string {
  if (typeof raw !== "string" || !raw.trim()) return "";
  const folded = raw.replace(/\\/g, "/").replace(/\/$/, "");
  if (!folded) return "";
  const n = nodePath.posix.normalize(folded);
  return n === "." ? "" : n;
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
    "X-Plex-Client-Identifier": "summonarr-server",
    "X-Plex-Product": "Summonarr",
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
