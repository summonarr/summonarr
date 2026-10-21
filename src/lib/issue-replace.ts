// An issue's "Replace file" — the pure half. Which of a title's files an issue
// is about (its scope), which GRAB produced each of them (so the release can be
// blocklisted), and what to search for once they are deleted. Zero I/O and no
// runtime imports, so the issue panel imports its types directly; the data
// half is the route, /api/issues/[id]/files, over arr-title-data.ts.
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
import type { ArrHistoryEvent } from "./arr-history";
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
 */
export function importForFile(
  service: ArrService,
  file: TitleFile,
  titleFiles: readonly TitleFile[],
  history: readonly ArrHistoryEvent[],
): ArrHistoryEvent | null {
  const units: Array<EpisodeRef | null> = service === "radarr" ? [null] : file.episodes;
  if (units.length === 0) return null;
  const ambiguousMovie = service === "radarr" && titleFiles.length > 1;
  const onUnit = (e: ArrHistoryEvent, unit: EpisodeRef | null) =>
    unit === null || (e.episode !== null && sameEpisode(e.episode, unit));
  const found: ArrHistoryEvent[] = [];
  for (const unit of units) {
    const imports = history.filter((e) => e.kind === "imported" && onUnit(e, unit));
    const byPath = file.path !== null ? imports.filter((e) => e.importedPath === file.path) : [];
    if (ambiguousMovie && byPath.length === 0) return null;
    const pool = byPath.length > 0 ? byPath : imports;
    if (pool.length === 0) return null;
    const newest = pool.reduce((a, b) => (b.id > a.id ? b : a));
    if (byPath.length === 0 && newest.importedPath !== null && file.path !== null && newest.importedPath !== file.path) {
      // The same file whose title folder moved since (a series/movie path change, or the title
      // manager's root-folder move): the arrs record no history for a move, so the import still
      // names the old folder — but the same relative path inside it.
      const folderMoved = sameRelativeFile(newest.importedPath, file.relativePath);
      // The rename's `path` is the file's relative path (an older arr sends the full one).
      const renamedTo = history.some(
        (e) => e.kind === "renamed" && onUnit(e, unit) && e.id > newest.id && e.path !== null && (e.path === file.relativePath || e.path === file.path),
      );
      if (!folderMoved && !renamedTo) return null;
    }
    const replacedSince = history.some(
      (e) => e.kind === "deleted" && onUnit(e, unit) && e.id > newest.id && (e.reason ?? "").toLowerCase() !== "upgrade",
    );
    if (replacedSince) return null;
    found.push(newest);
  }
  const downloads = new Set(found.map((e) => e.downloadId));
  if (downloads.size !== 1 || found[0].downloadId === null) return null;
  return found.reduce((a, b) => (b.id > a.id ? b : a));
}

/**
 * The grab behind an import: the newest grab of the same download recorded
 * before it. Sonarr writes a Grabbed record per EPISODE of a pack — any one of
 * them names the whole download, so the newest stands for all. A torrent's
 * downloadId is its info hash, so a release grabbed again after a failure
 * shares the old grab's id: only grabs BEFORE the import count, and only a
 * failure AFTER the grab means it is already failed.
 */
export function grabForImport(imported: ArrHistoryEvent, history: readonly ArrHistoryEvent[]): FileGrab | null {
  const downloadId = imported.downloadId;
  if (downloadId === null) return null;
  let grab: ArrHistoryEvent | null = null;
  for (const e of history) {
    if (e.kind === "grabbed" && e.downloadId === downloadId && e.id < imported.id && (grab === null || e.id > grab.id)) grab = e;
  }
  if (grab === null) return null;
  const grabId = grab.id;
  return { event: grab, failed: history.some((e) => e.kind === "failed" && e.downloadId === downloadId && e.id > grabId) };
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
  const titleOf = (e: EpisodeRef): string | null => {
    const hit = episodeList.find((x) => sameEpisode(x, e));
    return hit && hit.title.trim() !== "" ? hit.title : null;
  };
  return titleFiles
    .filter((f) => fileInScope(f, scope))
    .map((f) => {
      const imported = importForFile(service, f, titleFiles, history);
      return {
        ...f,
        episodes: f.episodes.map((e) => ({ seasonNumber: e.seasonNumber, episodeNumber: e.episodeNumber, title: titleOf(e) })),
        grab: imported ? grabForImport(imported, history) : null,
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
  const out: number[] = [];
  for (const s of before) {
    if (s.monitored && now.get(s.id) === false && !out.includes(s.id)) out.push(s.id);
  }
  return out;
}

/**
 * Sonarr's episodes for S/E pairs, from the series' episode list (each pair
 * at most once; a pair the list doesn't hold is skipped).
 */
export function episodesFor<T extends EpisodeRef>(refs: readonly EpisodeRef[], list: readonly T[]): T[] {
  const out: T[] = [];
  for (const r of refs) {
    const hit = list.find((e) => sameEpisode(e, r));
    if (hit && !out.includes(hit)) out.push(hit);
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
  const out: EpisodeRef[] = [];
  for (const f of files) {
    for (const e of f.episodes) if (!out.some((x) => sameEpisode(x, e))) out.push({ seasonNumber: e.seasonNumber, episodeNumber: e.episodeNumber });
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
  anyCovered: boolean,
  remaining: readonly TitleFile[],
  unmonitored = false,
): ReplaceSearch | null {
  if (uncovered.length === 0) return null;
  if (scope.kind === "movie") return anyCovered ? null : { kind: "movie" };
  const episodes = episodesOf(uncovered);
  if (scope.kind === "episode") {
    return { kind: "episodes", episodes: episodes.length > 0 ? episodes : [{ seasonNumber: scope.seasonNumber, episodeNumber: scope.episodeNumber }] };
  }
  if ((anyCovered || unmonitored) && episodes.length > 0) return { kind: "episodes", episodes };
  if (scope.kind === "season") {
    const seasonLeft = remaining.some((f) => fileInScope(f, scope));
    return episodes.length === 0 || (!seasonLeft && episodes.length >= 2)
      ? { kind: "season", seasonNumber: scope.seasonNumber }
      : { kind: "episodes", episodes };
  }
  if (episodes.length === 0) return { kind: "missing" };
  const seasons: number[] = [];
  const rest: EpisodeRef[] = [];
  for (const seasonNumber of [...new Set(episodes.map((e) => e.seasonNumber))]) {
    const inSeason = episodes.filter((e) => e.seasonNumber === seasonNumber);
    const seasonLeft = remaining.some((f) => fileInScope(f, { kind: "season", seasonNumber }));
    if (seasonNumber > 0 && inSeason.length >= 2 && !seasonLeft) seasons.push(seasonNumber);
    else rest.push(...inSeason);
  }
  return { kind: "plan", seasons, episodes: rest };
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
    // The projection keeps a download id's first 200 characters (arr-history.ts).
    const same = grab.downloadId !== null
      ? typeof r.downloadId === "string" && r.downloadId.slice(0, 200) === grab.downloadId
      : r.id === grab.id;
    return same && (releaseSourceOf(r) ?? "").toLowerCase() === "interactivesearch";
  });
}
