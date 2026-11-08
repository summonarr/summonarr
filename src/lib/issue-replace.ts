// An issue's "Replace file" — the pure half. Which of a title's files an issue
// is about (its scope), which GRAB produced each of them (so the release can be
// blocklisted), and what to search for once they are deleted. Zero I/O, and its
// one runtime import is arr-history's pure download-id projection, so the issue
// panel imports its types directly; the data half is the route,
// /api/issues/[id]/files, over arr-title-data.ts.
//
// Why the delete at all: while a file is on disk, Radarr/Sonarr only take an
// UPGRADE of it. A corrupt file already at the profile's cutoff is never
// replaced by a search — the issue's Refetch queues one that cannot succeed.
// Deleting the file first turns the search into a search for something missing.
//
// Every value here comes from the instance's own listings (TitleFile,
// ArrHistoryEvent — the explicit projections, never a release's download URL or
// guid). The browser only ever NAMES files those listings hold (guardrail 5e).
//
// Why the re-monitor: with Radarr/Sonarr's "Unmonitor Deleted Movies/Episodes"
// on, a manual delete UNMONITORS what it deleted. A SeasonSearch, the Missing
// plan and the arr's own redownload after a Mark failed all search monitored
// items only — so without it the replacement is searched for by nothing.
import { projectDownloadId, type ArrHistoryEvent } from "./arr-history";
import type { ArrService, TitleEpisode, TitleFile } from "./arr-title";

export interface EpisodeRef { seasonNumber: number; episodeNumber: number }

/** An episode a file holds, with Sonarr's own title for it (null when the episode list didn't name it). */
export interface ReplaceEpisode extends EpisodeRef { title: string | null }

/** What an issue covers, as files: a movie, a whole series, one season, or one episode. */
export type ReplaceScope =
  | { kind: "movie" }
  | { kind: "series" }
  | { kind: "season"; seasonNumber: number }
  | { kind: "episode"; seasonNumber: number; episodeNumber: number };

const isNonNeg = (n: number | null): n is number => typeof n === "number" && Number.isSafeInteger(n) && n >= 0;

/**
 * The issue's scope, or null when a TV scope is missing the numbers it needs —
 * such an issue can't be pinned to any file, so nothing is offered for deletion.
 */
export function replaceScopeOf(issue: {
  mediaType: string;
  scope: string;
  seasonNumber: number | null;
  episodeNumber: number | null;
}): ReplaceScope | null {
  if (issue.mediaType === "MOVIE") return { kind: "movie" };
  if (issue.scope === "FULL") return { kind: "series" };
  if (issue.scope === "SEASON") return isNonNeg(issue.seasonNumber) ? { kind: "season", seasonNumber: issue.seasonNumber } : null;
  if (issue.scope === "EPISODE") {
    return isNonNeg(issue.seasonNumber) && isNonNeg(issue.episodeNumber)
      ? { kind: "episode", seasonNumber: issue.seasonNumber, episodeNumber: issue.episodeNumber }
      : null;
  }
  return null;
}

const sameEpisode = (a: EpisodeRef, b: EpisodeRef) => a.seasonNumber === b.seasonNumber && a.episodeNumber === b.episodeNumber;

/** Whether a file is one the issue is about. A season's file is filed under that season; an episode's holds that S/E. */
export function fileInScope(file: TitleFile, scope: ReplaceScope): boolean {
  switch (scope.kind) {
    case "movie":
    case "series":
      return true;
    case "season":
      return file.seasonNumber !== null
        ? file.seasonNumber === scope.seasonNumber
        : file.episodes.some((e) => e.seasonNumber === scope.seasonNumber);
    case "episode":
      return file.episodes.some((e) => sameEpisode(e, scope));
  }
}

// ── which grab produced a file ───────────────────────────────────────────────

/** The grab that produced a file, from the title's history. */
export interface FileGrab {
  /** The grab record (projected: never the release's download URL or guid). */
  event: ArrHistoryEvent;
  /**
   * A failure was recorded for its download AFTER it — the release is already
   * blocklisted and marking it again is refused, so the file is searched for
   * instead.
   */
  failed: boolean;
}

export interface ReplaceableFile extends TitleFile {
  /**
   * The episodes the file holds, each with SONARR'S title for it. The issue's
   * season/episode numbers are the media server's numbering and Sonarr's are
   * TVDB's; on an anime or reordered show they can name different episodes,
   * and the delete is irreversible — the title is how the admin tells.
   */
  episodes: ReplaceEpisode[];
  /** Null when history can't tell which grab produced the file — it is searched for instead of blocklisted. */
  grab: FileGrab | null;
}

// ── the title's history, indexed once ────────────────────────────────────────

/**
 * A history longer than this is not read at all: no file's grab is attributed,
 * so each is searched for, never blocklisted. Far past a real title's (a full
 * Sonarr record is hundreds of bytes to a few KB, so arrFetch's 50 MB cap holds
 * tens of thousands), and it bounds the read whatever the arr sends (guardrail
 * 5i). Reading only the newest records would not be safe: a dropped older
 * import naming the file's own path changes which import the rules pick.
 */
export const MAX_REPLACE_HISTORY = 100_000;

interface UnitHistory {
  /** The unit's newest import (the first seen wins a tie), and its newest per imported path. */
  newestImport: ArrHistoryEvent | null;
  newestImportByPath: Map<string, ArrHistoryEvent>;
  /** The newest rename record's id, per path it names. */
  renamedTo: Map<string, number>;
  /** The newest deletion's id, an upgrade's deletion excepted. */
  lastDeletion: number;
}

/**
 * The title's history as importForFile and grabForImport ask about it, built
 * ONCE per listing: per unit (the movie, or an S/E) and per download. The
 * history is the title's whole, unpaged list, and re-scanning it for every file
 * was O(files × history) on the one event loop — seconds on a long daily show.
 */
export interface ReplaceHistoryIndex {
  /** False when the history is past MAX_REPLACE_HISTORY: nothing is attributed. */
  complete: boolean;
  /** Radarr's one unit: every record. */
  movie: UnitHistory;
  /** Sonarr's units, keyed `season:episode`. */
  episodes: Map<string, UnitHistory>;
  /** Each download's grabs, one per id (the first seen), ascending by id. */
  grabs: Map<string, ArrHistoryEvent[]>;
  /** Each download's newest failure id. */
  lastFailure: Map<string, number>;
}

type HistorySource = readonly ArrHistoryEvent[] | ReplaceHistoryIndex;

const episodeKey = (e: EpisodeRef) => `${e.seasonNumber}:${e.episodeNumber}`;
const emptyUnit = (): UnitHistory => ({ newestImport: null, newestImportByPath: new Map(), renamedTo: new Map(), lastDeletion: -Infinity });

function addToUnit(u: UnitHistory, e: ArrHistoryEvent): void {
  if (e.kind === "imported") {
    if (u.newestImport === null || e.id > u.newestImport.id) u.newestImport = e;
    if (e.importedPath !== null) {
      const prev = u.newestImportByPath.get(e.importedPath);
      if (prev === undefined || e.id > prev.id) u.newestImportByPath.set(e.importedPath, e);
    }
  } else if (e.kind === "renamed") {
    if (e.path !== null && e.id > (u.renamedTo.get(e.path) ?? -Infinity)) u.renamedTo.set(e.path, e.id);
  } else if (e.kind === "deleted") {
    if ((e.reason ?? "").toLowerCase() !== "upgrade" && e.id > u.lastDeletion) u.lastDeletion = e.id;
  }
}

/** One pass over the title's history (none past MAX_REPLACE_HISTORY). */
export function indexReplaceHistory(history: readonly ArrHistoryEvent[]): ReplaceHistoryIndex {
  const index: ReplaceHistoryIndex = {
    complete: history.length <= MAX_REPLACE_HISTORY,
    movie: emptyUnit(),
    episodes: new Map(),
    grabs: new Map(),
    lastFailure: new Map(),
  };
  if (!index.complete) return index;
  const grabsById = new Map<string, Map<number, ArrHistoryEvent>>();
  for (let i = 0; i < history.length; i++) {
    const e = history[i];
    addToUnit(index.movie, e);
    if (e.episode !== null) {
      const key = episodeKey(e.episode);
      let unit = index.episodes.get(key);
      if (unit === undefined) index.episodes.set(key, (unit = emptyUnit()));
      addToUnit(unit, e);
    }
    if (e.downloadId === null) continue;
    if (e.kind === "grabbed") {
      let byId = grabsById.get(e.downloadId);
      if (byId === undefined) grabsById.set(e.downloadId, (byId = new Map()));
      if (!byId.has(e.id)) byId.set(e.id, e);
    } else if (e.kind === "failed" && e.id > (index.lastFailure.get(e.downloadId) ?? -Infinity)) {
      index.lastFailure.set(e.downloadId, e.id);
    }
  }
  for (const [downloadId, byId] of grabsById) index.grabs.set(downloadId, [...byId.values()].sort((a, b) => a.id - b.id));
  return index;
}

const indexOf = (h: HistorySource): ReplaceHistoryIndex => (isHistoryIndex(h) ? h : indexReplaceHistory(h));
function isHistoryIndex(h: HistorySource): h is ReplaceHistoryIndex {
  return !Array.isArray(h);
}

/**
 * Whether an import's absolute path ends with the file's path relative to its
 * title folder, on a separator boundary (`/old/Show/Season 01/S01E01.mkv` vs
 * `Season 01/S01E01.mkv`) — the same file in a folder that has moved since.
 */
function sameRelativeFile(importedPath: string, relativePath: string): boolean {
  const rel = relativePath.replace(/\\/g, "/").replace(/^\/+/, "");
  if (rel === "") return false;
  return importedPath.replace(/\\/g, "/").endsWith(`/${rel}`);
}

/**
 * The import that put this file on disk, or null when history can't tell.
 *
 * Per unit the file holds — the movie, or each S/E of an episode file (Sonarr
 * records every event per EPISODE) — the newest import of that unit is the one
 * whose file is there now: every import replaces the unit's file. An import
 * naming the file's own path narrows it further, and is REQUIRED when a movie
 * has more than one file (otherwise which import made which file is a guess).
 * A deletion of the unit's file after that import — other than the upgrade
 * deletion that makes room for an import — means the file on disk came from
 * somewhere else (a rescan, a manual copy), so its grab is unknown. So does an
 * import that names a DIFFERENT file than the file's with no rename record of
 * the unit after it naming the file: a manual import of a file already in the
 * title's folder writes no history, and the newest import on record is then
 * the PREVIOUS download — marking it would blocklist a release the file never
 * came from (searched for, never guessed). A different FOLDER alone is not a
 * different file: the arrs record no history when a title's folder moves, so
 * an import whose path ends with the file's relative path still stands. An
 * import with no path on record still stands for the unit. Every unit of a
 * multi-episode file must point at the same download.
 *
 * `history` is the title's list, or its index (replaceableFiles builds it once
 * for every file).
 */
export function importForFile(
  service: ArrService,
  file: TitleFile,
  titleFiles: readonly TitleFile[],
  history: HistorySource,
): ArrHistoryEvent | null {
  const index = indexOf(history);
  if (!index.complete) return null;
  // A unit with no record at all has no import: the file's grab is unknown.
  const units: Array<UnitHistory | undefined> = service === "radarr" ? [index.movie] : file.episodes.map((e) => index.episodes.get(episodeKey(e)));
  if (units.length === 0) return null;
  const ambiguousMovie = service === "radarr" && titleFiles.length > 1;
  const found: ArrHistoryEvent[] = [];
  for (const unit of units) {
    const imported = unit === undefined ? null : importForUnit(unit, file, ambiguousMovie);
    if (imported === null) return null;
    found.push(imported);
  }
  const downloads = new Set(found.map((e) => e.downloadId));
  if (downloads.size !== 1 || found[0].downloadId === null) return null;
  return found.reduce((a, b) => (b.id > a.id ? b : a));
}

/** The import that put `file` on disk for ONE unit it holds (importForFile's rules), or null. */
function importForUnit(unit: UnitHistory, file: TitleFile, ambiguousMovie: boolean): ArrHistoryEvent | null {
  const byPath = file.path !== null ? (unit.newestImportByPath.get(file.path) ?? null) : null;
  if (ambiguousMovie && byPath === null) return null;
  const newest = byPath ?? unit.newestImport;
  if (newest === null) return null;
  if (byPath === null && newest.importedPath !== null && file.path !== null && newest.importedPath !== file.path
    && !folderMovedOrRenamed(unit, { path: file.path, relativePath: file.relativePath }, { id: newest.id, importedPath: newest.importedPath })) return null;
  // Replaced since: a deletion after the import, other than an upgrade's.
  if (unit.lastDeletion > newest.id) return null;
  return newest;
}

/** An import naming another path still stands for the file when its folder moved or a later rename names it. */
function folderMovedOrRenamed(
  unit: UnitHistory,
  file: { path: string; relativePath: string },
  imported: { id: number; importedPath: string },
): boolean {
  // The same file whose title folder moved since (a series/movie path change, or the title
  // manager's root-folder move): the arrs record no history for a move, so the import still
  // names the old folder — but the same relative path inside it.
  if (sameRelativeFile(imported.importedPath, file.relativePath)) return true;
  // The rename's `path` is the file's relative path (an older arr sends the full one).
  return Math.max(unit.renamedTo.get(file.relativePath) ?? -Infinity, unit.renamedTo.get(file.path) ?? -Infinity) > imported.id;
}

/**
 * The grab behind an import: the newest grab of the same download recorded
 * before it. Sonarr writes a Grabbed record per EPISODE of a pack — any one of
 * them names the whole download, so the newest stands for all. A torrent's
 * downloadId is its info hash, so a release grabbed again after a failure
 * shares the old grab's id: only grabs BEFORE the import count, and only a
 * failure AFTER the grab means it is already failed.
 */
export function grabForImport(imported: ArrHistoryEvent, history: HistorySource): FileGrab | null {
  const downloadId = imported.downloadId;
  if (downloadId === null) return null;
  const index = indexOf(history);
  if (!index.complete) return null;
  const grabs = index.grabs.get(downloadId);
  if (grabs === undefined) return null;
  // The last grab below the import's id: a binary search of the ascending list.
  let lo = 0;
  let hi = grabs.length;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if (grabs[mid].id < imported.id) lo = mid + 1;
    else hi = mid;
  }
  if (lo === 0) return null;
  const grab = grabs[lo - 1];
  return { event: grab, failed: (index.lastFailure.get(downloadId) ?? -Infinity) > grab.id };
}

/**
 * The title's files the issue is about, each with the grab that produced it
 * where history can tell, and its episodes named by Sonarr's own episode list
 * (`episodeList`, the series' episodes as read with the files).
 */
export function replaceableFiles(
  service: ArrService,
  scope: ReplaceScope,
  titleFiles: readonly TitleFile[],
  history: readonly ArrHistoryEvent[],
  episodeList: readonly Pick<TitleEpisode, "seasonNumber" | "episodeNumber" | "title">[] = [],
): ReplaceableFile[] {
  // History and episode list each read once, then looked up per file (guardrail 5i).
  const index = indexReplaceHistory(history);
  // The first listed entry for an S/E names it, as a search of the list would.
  const titles = new Map<string, string>();
  for (const x of episodeList) {
    const key = episodeKey(x);
    if (!titles.has(key)) titles.set(key, x.title);
  }
  const titleOf = (e: EpisodeRef): string | null => {
    const title = titles.get(episodeKey(e));
    return title !== undefined && title.trim() !== "" ? title : null;
  };
  return titleFiles
    .filter((f) => fileInScope(f, scope))
    .map((f) => {
      const imported = importForFile(service, f, titleFiles, index);
      return {
        ...f,
        episodes: f.episodes.map((e) => ({ seasonNumber: e.seasonNumber, episodeNumber: e.episodeNumber, title: titleOf(e) })),
        grab: imported ? grabForImport(imported, index) : null,
      };
    });
}

// ── re-monitoring what the delete unmonitored ────────────────────────────────

/** A movie's, or an episode's, monitored flag as the arr reported it. */
export interface MonitorState { id: number; monitored: boolean }

/**
 * The ids the delete UNMONITORED: monitored before it, unmonitored after.
 * Exactly those are set back — an episode the admin had unmonitored stays
 * unmonitored, and an id the re-read didn't return is left alone.
 */
export function unmonitoredByDelete(before: readonly MonitorState[], after: readonly MonitorState[]): number[] {
  const now = new Map(after.map((s) => [s.id, s.monitored]));
  const seen = new Set<number>();
  const out: number[] = [];
  for (const s of before) {
    if (s.monitored && now.get(s.id) === false && !seen.has(s.id)) {
      seen.add(s.id);
      out.push(s.id);
    }
  }
  return out;
}

/**
 * Sonarr's episodes for S/E pairs, from the series' episode list (each pair
 * at most once; a pair the list doesn't hold is skipped).
 */
export function episodesFor<T extends EpisodeRef>(refs: readonly EpisodeRef[], list: readonly T[]): T[] {
  // Indexed once (the first entry per S/E, as a scan would find it), never
  // searched per ref (guardrail 5i: Sonarr's list is uncapped).
  const byKey = new Map<string, T>();
  for (const e of list) {
    const key = episodeKey(e);
    if (!byKey.has(key)) byKey.set(key, e);
  }
  const seen = new Set<string>();
  const out: T[] = [];
  for (const r of refs) {
    const key = episodeKey(r);
    const hit = byKey.get(key);
    if (hit && !seen.has(key)) {
      seen.add(key);
      out.push(hit);
    }
  }
  return out;
}

/**
 * The files the admin chose, from the in-scope list read NOW — or null when the
 * list is empty or any id is not one of them (a file outside the issue's scope,
 * another title's, or one that is gone since the page loaded). Nothing is
 * deleted on null.
 */
export function chooseFiles(inScope: readonly ReplaceableFile[], fileIds: readonly number[]): ReplaceableFile[] | null {
  if (fileIds.length === 0) return null;
  const byId = new Map(inScope.map((f) => [f.id, f]));
  const out: ReplaceableFile[] = [];
  for (const id of new Set(fileIds)) {
    const f = byId.get(id);
    if (!f) return null;
    out.push(f);
  }
  return out;
}

// ── what happens after the delete ────────────────────────────────────────────

export const REPLACE_FOLLOW_UPS = ["markFailed", "search"] as const;
export type ReplaceFollowUp = (typeof REPLACE_FOLLOW_UPS)[number];

export function parseReplaceFollowUp(v: unknown): ReplaceFollowUp | null {
  return typeof v === "string" && (REPLACE_FOLLOW_UPS as readonly string[]).includes(v) ? (v as ReplaceFollowUp) : null;
}

/** One Mark failed: a download, and the deleted files it produced. */
export interface ReplaceMark {
  grab: ArrHistoryEvent;
  fileIds: number[];
}

/**
 * The marks for the deleted files whose grab is known and not already failed —
 * ONE per download. Marking any grab of a download fails the whole download,
 * so a second mark of a season pack (every episode file shares it) would
 * blocklist and search again: the per-episode trap guardrail 5c names.
 */
export function planMarks(files: readonly ReplaceableFile[]): ReplaceMark[] {
  const byDownload = new Map<string, ReplaceMark>();
  for (const f of files) {
    if (!f.grab || f.grab.failed) continue;
    const key = f.grab.event.downloadId ?? `#${f.grab.event.id}`;
    const mark = byDownload.get(key);
    if (!mark) byDownload.set(key, { grab: f.grab.event, fileIds: [f.id] });
    else {
      mark.fileIds.push(f.id);
      if (f.grab.event.id > mark.grab.id) mark.grab = f.grab.event;
    }
  }
  return [...byDownload.values()];
}

/** The search the replacement needs, after the delete. */
export type ReplaceSearch =
  | { kind: "movie" }
  | { kind: "season"; seasonNumber: number }
  | { kind: "episodes"; episodes: EpisodeRef[] }
  /** A series: a SeasonSearch per season in `seasons`, and one EpisodeSearch for `episodes` (either may be empty, never both). */
  | { kind: "plan"; seasons: number[]; episodes: EpisodeRef[] }
  /** A series whose deleted files named no episodes: the Missing page's own plan, re-judged live. */
  | { kind: "missing" };

/** The distinct episodes a set of files held, in S/E order. */
export function episodesOf(files: readonly TitleFile[]): EpisodeRef[] {
  const seen = new Set<string>();
  const out: EpisodeRef[] = [];
  for (const f of files) {
    for (const e of f.episodes) {
      const key = episodeKey(e);
      if (seen.has(key)) continue;
      seen.add(key);
      out.push({ seasonNumber: e.seasonNumber, episodeNumber: e.episodeNumber });
    }
  }
  return out.sort((a, b) => a.seasonNumber - b.seasonNumber || a.episodeNumber - b.episodeNumber);
}

/**
 * The search to queue after the delete, or null when none is needed.
 *
 * `uncovered` are the deleted files no Mark failed will search for (the
 * arr's Redownload Failed searches a marked grab's own episodes), and
 * `anyCovered` says whether some deleted file IS covered. `remaining` are the
 * title's files left on disk.
 *
 * - A movie: MoviesSearch — unless a mark already searches it.
 * - An episode: one EpisodeSearch for the episodes the deleted files held.
 * - Part of the deletion covered by marks: EpisodeSearch for exactly the rest.
 *   A season or series search would hit every indexer again for the episodes
 *   the arr is already searching.
 * - A season: a SeasonSearch (a season pack can come back) only when no file
 *   of the season is left and 2+ episodes went; otherwise EpisodeSearch — a
 *   SeasonSearch beside files still on disk hunts upgrades for every one of
 *   them. The Missing page's plan, the same rule (planSeriesSearch).
 * - A series: that season-pack rule applied to the DELETED episodes only — a
 *   SeasonSearch per regular season emptied with 2+ of them gone, one
 *   EpisodeSearch for the rest. Never SeriesSearch, and never the series'
 *   whole missing backlog: the Missing page's plan (aired regular-season
 *   episodes only) would also search gaps nobody deleted, and could not reach
 *   a deleted special or an undated episode at all. Specials are never a
 *   season pack (the Missing plan's rule; they are named instead). Only a
 *   deletion whose files named no episodes falls back to the Missing plan.
 * - `unmonitored` (an uncovered episode is still unmonitored once the delete's
 *   unmonitoring was undone — the admin had unmonitored it, or the re-monitor
 *   failed): an EpisodeSearch naming them. A SeasonSearch and the Missing plan
 *   take monitored episodes only, so either would search for nothing; an
 *   EpisodeSearch the admin queues searches what it names. (Radarr's manual
 *   MoviesSearch searches an unmonitored movie too.)
 */
export function followUpSearch(
  scope: ReplaceScope,
  uncovered: readonly TitleFile[],
  remaining: readonly TitleFile[],
  opts: { anyCovered: boolean; unmonitored?: boolean },
): ReplaceSearch | null {
  if (uncovered.length === 0) return null;
  if (scope.kind === "movie") return opts.anyCovered ? null : { kind: "movie" };
  const episodes = episodesOf(uncovered);
  if (scope.kind === "episode") {
    return { kind: "episodes", episodes: episodes.length > 0 ? episodes : [{ seasonNumber: scope.seasonNumber, episodeNumber: scope.episodeNumber }] };
  }
  if ((opts.anyCovered || opts.unmonitored === true) && episodes.length > 0) return { kind: "episodes", episodes };
  if (scope.kind === "season") {
    const seasonLeft = remaining.some((f) => fileInScope(f, scope));
    return episodes.length === 0 || seasonPackFits(episodes.length, seasonLeft)
      ? { kind: "season", seasonNumber: scope.seasonNumber }
      : { kind: "episodes", episodes };
  }
  if (episodes.length === 0) return { kind: "missing" };
  const seasons: number[] = [];
  const rest: EpisodeRef[] = [];
  for (const seasonNumber of [...new Set(episodes.map((e) => e.seasonNumber))]) {
    const inSeason = episodes.filter((e) => e.seasonNumber === seasonNumber);
    const seasonLeft = remaining.some((f) => fileInScope(f, { kind: "season", seasonNumber }));
    // Specials are never a season pack.
    if (seasonNumber > 0 && seasonPackFits(inSeason.length, seasonLeft)) seasons.push(seasonNumber);
    // One by one, never a spread push (guardrail 5i).
    else for (const e of inSeason) rest.push(e);
  }
  return { kind: "plan", seasons, episodes: rest };
}

/**
 * The season-pack rule: a SeasonSearch only when no file of the season is left
 * on disk and two or more of its episodes went — beside files still there, a
 * SeasonSearch hunts upgrades for every one of them.
 */
function seasonPackFits(episodesGone: number, seasonFilesLeft: boolean): boolean {
  return !seasonFilesLeft && episodesGone >= 2;
}

/**
 * Radarr/Sonarr's "Redownload Failed" switch, from GET /api/v3/config/downloadclient:
 * true/false as the arr reports it, null when the answer doesn't say.
 */
export function redownloadSetting(raw: unknown): boolean | null {
  const v = raw && typeof raw === "object" && !Array.isArray(raw) ? (raw as { autoRedownloadFailed?: unknown }).autoRedownloadFailed : undefined;
  return typeof v === "boolean" ? v : null;
}

/**
 * Both redownload switches from /api/v3/config/downloadclient. Radarr v5+ and
 * Sonarr v4 also have "Redownload Failed from Interactive Search": a failed
 * download whose grab was picked by hand (every Pick release / Replace release
 * grab) is redownloaded only when it is on as well. `interactive` is null when
 * the arr doesn't send it — an older arr, which has no such switch and
 * redownloads those like any other.
 */
export interface RedownloadSettings { failed: boolean | null; interactive: boolean | null }

export function redownloadSettings(raw: unknown): RedownloadSettings {
  const v = raw && typeof raw === "object" && !Array.isArray(raw)
    ? (raw as { autoRedownloadFailedFromInteractiveSearch?: unknown }).autoRedownloadFailedFromInteractiveSearch
    : undefined;
  return { failed: redownloadSetting(raw), interactive: typeof v === "boolean" ? v : null };
}

/**
 * Whether the arr's own redownload after a Mark failed searches for the
 * download — the arr's RedownloadFailedDownloadService rule: Redownload Failed
 * on, and for an interactive grab the interactive switch on too (absent ⇒ the
 * main switch decides, as it does on an arr without one). Off or unreadable ⇒
 * we search ourselves.
 *
 * `available` is Radarr's movie `isAvailable` (true for Sonarr, and when the
 * movie doesn't say). Radarr's redownload is an AUTOMATIC MoviesSearch, and an
 * automatic search applies Minimum Availability: for a movie not yet
 * "available" (an early release picked by hand) it rejects every release, so
 * it covers nothing — our manual MoviesSearch, which ignores availability, runs.
 */
export function redownloadCovers(settings: RedownloadSettings, interactiveGrab: boolean, available = true): boolean {
  if (settings.failed !== true || !available) return false;
  return !interactiveGrab || (settings.interactive ?? settings.failed) === true;
}

/** A raw history record's `data.releaseSource` (the arrs have sent the key in both cases), or null. */
export function releaseSourceOf(raw: unknown): string | null {
  const data = raw && typeof raw === "object" && !Array.isArray(raw) ? (raw as { data?: unknown }).data : undefined;
  if (!data || typeof data !== "object" || Array.isArray(data)) return null;
  for (const [k, v] of Object.entries(data)) {
    if (k.toLowerCase() === "releasesource" && typeof v === "string") return v;
  }
  return null;
}

const isGrabRecord = (eventType: unknown) =>
  eventType === 1 || (typeof eventType === "string" && eventType.toLowerCase() === "grabbed");

/**
 * Whether the arr will treat a Mark failed of `grab` as an INTERACTIVE grab,
 * from the title's raw history (`/history/movie` or `/history/series`, which
 * carry `data.releaseSource`). The arr reads the source off a grab record of
 * the same download, and which one is not pinned down — a torrent re-grabbed
 * after a failure shares its info hash — so ANY grab of the download marked
 * "InteractiveSearch" counts: the cost of being wrong that way is one extra
 * search, the other way nothing searches at all. Records naming another title
 * are ignored (guardrail 5e).
 */
export function isInteractiveGrab(service: ArrService, arrId: number, rawHistory: unknown, grab: ArrHistoryEvent): boolean {
  if (!Array.isArray(rawHistory)) return false;
  const mediaKey = service === "radarr" ? "movieId" : "seriesId";
  return rawHistory.some((x) => {
    const r = x && typeof x === "object" && !Array.isArray(x) ? (x as Record<string, unknown>) : null;
    if (!r || !isGrabRecord(r.eventType)) return false;
    if (typeof r[mediaKey] === "number" && r[mediaKey] !== arrId) return false;
    // Compared as the projection stored it (truncated — arr-history.ts).
    const same = grab.downloadId !== null
      ? projectDownloadId(r.downloadId) === grab.downloadId
      : r.id === grab.id;
    return same && (releaseSourceOf(r) ?? "").toLowerCase() === "interactivesearch";
  });
}
