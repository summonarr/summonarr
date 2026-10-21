// Library match check — the pure rules (no I/O; library-match-data.ts reads the
// servers and stores the report).
//
// Why it exists:
// - The library sync keeps ONE row per TMDB id per server (@@id([tmdbId,
//   mediaType, serverInstance])). A copy matched to a title the server already
//   holds folds into that title's row (guardrails 37/37c): "Ghost in the Shell
//   (2017)" matched to the 1995 film leaves no row of its own, the 2017 film
//   reads as not on the server, and the Plex-vs-Jellyfin bad-match report —
//   which compares the stored rows only — can never see it.
// - An item with no TMDB id is dropped by the sync altogether.
// - Radarr and Sonarr know which title each folder is. That is the referee:
//   every item a media server lists, every copy and every unmatched one, is
//   judged against what Radarr/Sonarr say its folder holds.
//
// The rules lean towards silence. A flag is offered a fix, so a wrong flag
// costs a rematch of a correct item:
// - "wrongMatch" only when the item shares NO id (TMDB, IMDb or TVDB) with the
//   folder's Radarr/Sonarr title. One shared id is agreement — two TMDB entries
//   for one film (Plex's conflated guids) are not this check's business.
// - "yearMismatch" only where no Radarr/Sonarr manages the folder, only from a
//   "Name (YYYY)" folder, and only beyond TWO years either way: a festival
//   premiere and the wide release routinely sit two years apart, and on a real
//   9,134-movie library a one-year tolerance flagged 11 such films beside ~30
//   genuine wrong matches. It has no suggestion, so it is never offered a fix.
// - An item in a folder where ANOTHER item already agrees with Radarr/Sonarr
//   is almost always an extra or a second part ("Repulsion (1965)/A British
//   Horror Film.mkv") — flagged `sibling`, never offered a fix: matching it to
//   the folder's title would make a bogus second copy.
// - Two Radarr/Sonarr entries for one folder name that share no id (two
//   instances that disagree) leave that folder unjudged.

export type MatchServer = "plex" | "jellyfin";
export type MatchMediaType = "MOVIE" | "TV";
export type MatchArrService = "radarr" | "sonarr";

/** One item as a media server lists it — every copy, matched or not. */
export interface ServerMatchEntry {
  server: MatchServer;
  serverInstance: string;
  mediaType: MatchMediaType;
  /** Plex ratingKey / Jellyfin item id. */
  itemKey: string;
  /** The title and year of whatever the server matched it to. */
  title: string | null;
  year: number | null;
  /** A file (a movie) or a folder (a Jellyfin series, a Plex show's Location). */
  path: string | null;
  /** Every TMDB id the server gives it (a conflated Plex item carries several). */
  tmdbIds: number[];
  imdbId: string | null;
  tvdbId: number | null;
  /** Placed by the sync without a TMDB id: a Plex legacy-agent imdb/tvdb guid, resolved through TMDB /find. */
  legacyPlaced?: boolean;
}

/** One Radarr movie / Sonarr series and the folder it lives in. */
export interface ArrMatchEntry {
  service: MatchArrService;
  instance: string;
  mediaType: MatchMediaType;
  tmdbId: number | null;
  imdbId: string | null;
  tvdbId: number | null;
  title: string | null;
  year: number | null;
  /** The path Radarr/Sonarr store for it; only its last segment is compared. */
  path: string;
}

export type MatchFlagKind = "wrongMatch" | "noTmdbId" | "yearMismatch";

export interface MatchFlagArr {
  service: MatchArrService;
  instance: string;
  tmdbId: number | null;
  tvdbId: number | null;
  title: string | null;
  year: number | null;
}

export interface MatchFlag {
  kind: MatchFlagKind;
  server: MatchServer;
  serverInstance: string;
  mediaType: MatchMediaType;
  itemKey: string;
  title: string | null;
  year: number | null;
  /** The folder the item was judged by (display only). */
  folder: string | null;
  /** The item's own file name, when its path is a file (display only — a loose file's folder is the library root). */
  file: string | null;
  /** The item's full path — the fix's confirmation search needs it. ADMIN-only data. */
  path: string | null;
  /** The first TMDB id the server gives it, null when it has none. */
  serverTmdbId: number | null;
  /** What Radarr/Sonarr say the folder is; null when none manages it. */
  arr: MatchFlagArr | null;
  /** Another item in the same folder already agrees with Radarr/Sonarr: an extra or a second part. */
  sibling: boolean;
}

export interface MatchCounts {
  /** Items judged (every listed item). */
  checked: number;
  /** Items Radarr/Sonarr agree with. */
  agreed: number;
  /** Items in a folder no Radarr/Sonarr manages (judged by the folder year alone). */
  notManaged: number;
  flagged: number;
}

/** Folder names compare case- and normalisation-insensitively (NFD names from macOS shares). */
export function folderKey(name: string): string {
  return name.normalize("NFC").trim().toLowerCase();
}

function segments(path: string): string[] {
  return path.replace(/\\/g, "/").split("/").filter(Boolean);
}

const FILE_RE = /\.[A-Za-z0-9]{1,5}$/;

/** The item's own folder: a file's parent, or the path itself when it is a folder. */
export function ownFolder(path: string | null): string | null {
  if (!path) return null;
  const segs = segments(path);
  const last = segs[segs.length - 1];
  if (last === undefined) return null;
  if (FILE_RE.test(last)) return segs.length >= 2 ? segs[segs.length - 2] : null;
  return last;
}

/** The file name when the path is a file, else null. */
export function fileName(path: string | null): string | null {
  const last = path ? segments(path).pop() : undefined;
  return last !== undefined && FILE_RE.test(last) ? last : null;
}

/** The year a "Name (YYYY)" folder states, else null. */
export function folderYear(folder: string | null): number | null {
  if (!folder) return null;
  const m = /\((\d{4})\)\s*$/.exec(folder);
  return m ? Number(m[1]) : null;
}

function sameTitle(a: Pick<ArrMatchEntry, "tmdbId" | "imdbId" | "tvdbId">, b: Pick<ArrMatchEntry, "tmdbId" | "imdbId" | "tvdbId">): boolean {
  return (a.tmdbId !== null && a.tmdbId === b.tmdbId)
    || (a.imdbId !== null && a.imdbId === b.imdbId)
    || (a.tvdbId !== null && a.tvdbId === b.tvdbId);
}

/** Does the item share any id with the Radarr/Sonarr title? */
export function agreesWithArr(item: ServerMatchEntry, arr: ArrMatchEntry): boolean {
  return (arr.tmdbId !== null && item.tmdbIds.includes(arr.tmdbId))
    || (arr.imdbId !== null && item.imdbId === arr.imdbId)
    || (arr.tvdbId !== null && item.tvdbId === arr.tvdbId);
}

/**
 * Folder name → the Radarr/Sonarr title, per media type. A name two entries
 * claim for DIFFERENT titles is dropped: neither can referee it.
 */
export function indexArrFolders(arr: ArrMatchEntry[]): Map<MatchMediaType, Map<string, ArrMatchEntry>> {
  const out = new Map<MatchMediaType, Map<string, ArrMatchEntry>>([["MOVIE", new Map()], ["TV", new Map()]]);
  const ambiguous = new Set<string>();
  for (const entry of arr) {
    const name = segments(entry.path).pop();
    if (!name) continue;
    const key = folderKey(name);
    const index = out.get(entry.mediaType)!;
    const amb = `${entry.mediaType}\u0000${key}`;
    if (ambiguous.has(amb)) continue;
    const seen = index.get(key);
    if (!seen) index.set(key, entry);
    else if (!sameTitle(seen, entry)) {
      index.delete(key);
      ambiguous.add(amb);
    }
  }
  return out;
}

/** The deepest segment of the item's path that names a Radarr/Sonarr folder. */
function arrFolderOf(path: string | null, index: Map<string, ArrMatchEntry>): { folder: string; arr: ArrMatchEntry } | null {
  if (!path) return null;
  const segs = segments(path);
  for (let i = segs.length - 1; i >= 0; i--) {
    const arr = index.get(folderKey(segs[i]));
    if (arr) return { folder: segs[i], arr };
  }
  return null;
}

/** Years a folder may differ from its match before the year flag speaks. */
export const YEAR_TOLERANCE = 2;

const KIND_ORDER: Record<MatchFlagKind, number> = { wrongMatch: 0, noTmdbId: 1, yearMismatch: 2 };

/** Judge every listed item against Radarr/Sonarr's folders. */
export function judgeLibraryMatches(
  entries: ServerMatchEntry[],
  arr: ArrMatchEntry[],
): { flags: MatchFlag[]; counts: MatchCounts } {
  const index = indexArrFolders(arr);
  const counts: MatchCounts = { checked: 0, agreed: 0, notManaged: 0, flagged: 0 };
  type Judged = { entry: ServerMatchEntry; folder: string | null; arr: ArrMatchEntry | null; kind: MatchFlagKind | null };
  const judged: Judged[] = [];
  // Folders where at least one item agrees with Radarr/Sonarr, per server.
  const agreeingFolders = new Set<string>();
  const groupOf = (e: ServerMatchEntry, folder: string) => `${e.server}\u0000${e.serverInstance}\u0000${e.mediaType}\u0000${folderKey(folder)}`;

  for (const entry of entries) {
    counts.checked++;
    const placed = entry.tmdbIds.length > 0 || entry.legacyPlaced === true;
    const hit = arrFolderOf(entry.path, index.get(entry.mediaType)!);
    if (hit) {
      if (agreesWithArr(entry, hit.arr)) {
        if (placed) {
          counts.agreed++;
          agreeingFolders.add(groupOf(entry, hit.folder));
          judged.push({ entry, folder: hit.folder, arr: hit.arr, kind: null });
        } else {
          // The server knows it (by IMDb/TVDB) but the sync can't place it without a TMDB id.
          judged.push({ entry, folder: hit.folder, arr: hit.arr, kind: "noTmdbId" });
        }
      } else {
        const hasIds = entry.tmdbIds.length > 0 || entry.imdbId !== null || entry.tvdbId !== null;
        judged.push({ entry, folder: hit.folder, arr: hit.arr, kind: hasIds ? "wrongMatch" : "noTmdbId" });
      }
      continue;
    }
    counts.notManaged++;
    const folder = ownFolder(entry.path);
    if (!placed) {
      judged.push({ entry, folder, arr: null, kind: "noTmdbId" });
      continue;
    }
    const stated = folderYear(folder);
    const off = stated !== null && entry.year !== null && Math.abs(stated - entry.year) > YEAR_TOLERANCE;
    judged.push({ entry, folder, arr: null, kind: off ? "yearMismatch" : null });
  }

  const flags: MatchFlag[] = [];
  for (const { entry, folder, arr: a, kind } of judged) {
    if (kind === null) continue;
    flags.push({
      kind,
      server: entry.server,
      serverInstance: entry.serverInstance,
      mediaType: entry.mediaType,
      itemKey: entry.itemKey,
      title: entry.title,
      year: entry.year,
      folder,
      file: fileName(entry.path),
      path: entry.path,
      serverTmdbId: entry.tmdbIds[0] ?? null,
      arr: a ? { service: a.service, instance: a.instance, tmdbId: a.tmdbId, tvdbId: a.tvdbId, title: a.title, year: a.year } : null,
      sibling: a !== null && folder !== null && agreeingFolders.has(groupOf(entry, folder)),
    });
  }
  counts.flagged = flags.length;
  // Within a kind: the ones a fix is offered for, then the ones with no
  // suggestion, then the extras.
  const rank = (f: MatchFlag) => (f.sibling ? 2 : f.arr?.tmdbId != null ? 0 : 1);
  flags.sort((x, y) =>
    KIND_ORDER[x.kind] - KIND_ORDER[y.kind]
    || rank(x) - rank(y)
    || (x.title ?? x.folder ?? "").localeCompare(y.title ?? y.folder ?? ""));
  return { flags, counts };
}

/** A flag the UI may offer to fix: Radarr/Sonarr name a TMDB id, and it is not an extra in a matched folder. */
export function fixableFlag(flag: MatchFlag): flag is MatchFlag & { arr: MatchFlagArr & { tmdbId: number } } {
  return flag.arr !== null && flag.arr.tmdbId !== null && !flag.sibling && flag.kind !== "yearMismatch"
    && flag.arr.tmdbId !== flag.serverTmdbId;
}
