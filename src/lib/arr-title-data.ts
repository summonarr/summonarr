// The admin title manager — the data half. Everything an admin would open a
// movie or series in Radarr/Sonarr for: its settings (monitored, profile,
// root folder, tags, availability / series type, season and episode
// monitoring), its files (delete, rename), its history (mark a grab failed),
// and searching it (automatic, or interactive with a release picked by hand).
//
// Every call is a live read or write on one CONFIGURED instance through
// arrFetch (guardrail 5, guardrail 32), addressed by the arr's own id. Every
// id the browser sends — a file, an episode, a history record, a season, a
// profile, a root folder, a tag — is checked against what the instance itself
// reports for THIS title before anything is written, so a stale page or a
// crafted request can only ever act on the title it names (guardrail 5e). Nothing is cached
// and nothing in Summonarr is written except the audit rows the routes add.
import {
  ArrResponseError,
  arrFetch,
  arrFetchNoContent,
  postReleaseGrab,
  resolveTmdbToTvdb,
  searchReleasesByArrId,
  type ArrCfg,
  type ArrFetchOptions,
  type ArrRelease,
  type GrabProgress,
} from "./arr";
import { commandIdsOf, configuredArrCfg, postArrCommand, type ArrService } from "./arr-admin";
import { NothingMissingError } from "./arr-missing-data";
import { processSingleton } from "./process-singleton";
import { failsIdlessGrab, projectHistoryRecords, sortHistoryEvents, type ArrHistoryEvent } from "./arr-history";
import {
  checkTitleEdit,
  editedFields,
  editorBody,
  projectChoices,
  projectEpisodes,
  projectFiles,
  projectRenames,
  projectRootFolderChoices,
  projectTitle,
  withSeasonMonitoring,
  type ArrTitle,
  type Choice,
  type RenamePreview,
  type RootFolderChoice,
  type TitleEdit,
  type TitleEpisode,
  type TitleFile,
} from "./arr-title";

/** The title is not on that instance (removed there, or never added). */
export class TitleNotFoundError extends Error {}
/** An id the browser sent is not one of this title's (a file, episode, history record, season). */
export class NotOnTitleError extends Error {
  readonly what: "file" | "episode" | "history" | "season";
  constructor(what: "file" | "episode" | "history" | "season") {
    super(`${what} is not on this title`);
    this.what = what;
  }
}
/** A history record that is not a grab can't be marked failed. */
export class NotAGrabError extends Error {}
/** The download that grab belongs to is already marked failed (a season pack's other episodes, a second click). */
export class AlreadyFailedError extends Error {}
/**
 * Another mark of that download holds the claim — in flight, or its outcome
 * unknown for a little longer (MARK_UNKNOWN_HOLD_MS). An AlreadyFailedError,
 * so every caller still sends nothing.
 */
export class MarkInProgressError extends AlreadyFailedError {}

const resourcePath = (service: ArrService, arrId: number) => `/api/v3/${service === "radarr" ? "movie" : "series"}/${arrId}`;

async function readRaw(cfg: ArrCfg, service: ArrService, arrId: number): Promise<Record<string, unknown>> {
  try {
    const raw = await arrFetch<unknown>(cfg, resourcePath(service, arrId));
    if (!raw || typeof raw !== "object" || Array.isArray(raw) || (raw as { id?: unknown }).id !== arrId) throw new TitleNotFoundError();
    return raw as Record<string, unknown>;
  } catch (err) {
    if (err instanceof ArrResponseError && err.status === 404) throw new TitleNotFoundError();
    throw err;
  }
}

// A row Radarr/Sonarr returned for "this title" that names ANOTHER title is
// dropped: the browser can only ever act on what the instance reports for the
// title it names (guardrail 5e), even if an arr version ignored the query's
// filter. A row without the field is kept — older builds don't always send it.
const ownRow = (service: ArrService, arrId: number) => (x: unknown): boolean => {
  const id = (x as Record<string, unknown> | null)?.[service === "radarr" ? "movieId" : "seriesId"];
  return typeof id !== "number" || id === arrId;
};
const ownRows = (service: ArrService, arrId: number, raw: unknown): unknown[] => (Array.isArray(raw) ? raw.filter(ownRow(service, arrId)) : []);

async function readEpisodes(cfg: ArrCfg, seriesId: number, seasonNumber?: number): Promise<TitleEpisode[]> {
  const q = seasonNumber === undefined ? `seriesId=${seriesId}` : `seriesId=${seriesId}&seasonNumber=${seasonNumber}`;
  // Another series' episode never stands in for one of this series' — the
  // per-id check compares seriesId, and so does every reader of this list.
  const episodes = projectEpisodes(ownRows("sonarr", seriesId, await arrFetch<unknown>(cfg, `/api/v3/episode?${q}`)));
  // Defensive: keep only the season asked for even if an arr ignored the filter.
  return seasonNumber === undefined ? episodes : episodes.filter((e) => e.seasonNumber === seasonNumber);
}

// Up to this many ids are checked one GET /api/v3/episode/{id} each; more read
// the series' whole episode list once. A long anime or daily show has
// thousands of episodes, and a single monitor switch or Search used to pull all
// of them.
const FEW_EPISODES = 10;

/**
 * The series' own episodes for `ids`, read fresh from Sonarr (guardrail 5e) —
 * NotOnTitleError when any id is not one of them.
 */
async function episodesOfSeries(cfg: ArrCfg, seriesId: number, ids: readonly number[]): Promise<Map<number, TitleEpisode>> {
  if (ids.length === 0) throw new NotOnTitleError("episode");
  if (ids.length <= FEW_EPISODES) {
    const out = new Map<number, TitleEpisode>();
    for (const id of ids) {
      let raw: unknown;
      try {
        raw = await arrFetch<unknown>(cfg, `/api/v3/episode/${id}`);
      } catch (err) {
        if (err instanceof ArrResponseError && err.status === 404) throw new NotOnTitleError("episode");
        throw err;
      }
      const [ep] = projectEpisodes([raw]);
      if (!ep || ep.id !== id || (raw as { seriesId?: unknown }).seriesId !== seriesId) throw new NotOnTitleError("episode");
      out.set(id, ep);
    }
    return out;
  }
  const all = new Map((await readEpisodes(cfg, seriesId)).map((e) => [e.id, e]));
  if (ids.some((id) => !all.has(id))) throw new NotOnTitleError("episode");
  return all;
}

// ── finding and loading ──────────────────────────────────────────────────────

/**
 * The arr's id for a TMDB title on one instance, or null when the instance
 * doesn't have it. Radarr filters its library by tmdbId. Sonarr can only
 * filter by tvdbId: TMDB's own TVDB cross-reference is tried first (cached),
 * then Sonarr's lookup, which marks a series it already has with a positive id
 * — trusted only on a row whose tmdbId is this one, never an untagged lone row
 * (this resolves the target of deletes and edits).
 */
export async function findTitleId(service: ArrService, instance: string, tmdbId: number): Promise<number | null> {
  return (await findTitle(service, instance, tmdbId))?.arrId ?? null;
}

/**
 * findTitleId, plus the library resource when the read that found it returned
 * one whole (Radarr's tmdbId filter, Sonarr's tvdbId filter) — loadTitle then
 * doesn't fetch the same resource again. A lookup row is not a library
 * resource and is never reused.
 */
export async function findTitle(
  service: ArrService,
  instance: string,
  tmdbId: number,
  // A caller that reports a failed read itself (quietErrors) or answers on a
  // click inside a proxy's patience (timeoutMs, signal) — the Why? status.
  opts: Pick<ArrFetchOptions, "quietErrors" | "timeoutMs" | "signal"> = {},
): Promise<{ arrId: number; raw: Record<string, unknown> | null } | null> {
  const cfg = await configuredArrCfg(service, instance);
  if (service === "radarr") {
    const movies = await arrFetch<unknown>(cfg, `/api/v3/movie?tmdbId=${tmdbId}`, opts);
    const row = Array.isArray(movies) ? (movies as Array<{ id?: unknown; tmdbId?: unknown }>).find((m) => m?.tmdbId === tmdbId) : undefined;
    return typeof row?.id === "number" && row.id > 0 ? { arrId: row.id, raw: row as Record<string, unknown> } : null;
  }
  const tvdbId = await resolveTmdbToTvdb(tmdbId);
  if (tvdbId !== null) {
    const library = await arrFetch<unknown>(cfg, `/api/v3/series?tvdbId=${tvdbId}`, opts);
    const row = Array.isArray(library)
      ? (library as Array<{ id?: unknown; tvdbId?: unknown; tmdbId?: unknown }>).find((s) => s?.tvdbId === tvdbId)
      : undefined;
    // A series that names a DIFFERENT TMDB title is not this one (TMDB's cross-reference is user-edited).
    const agrees = typeof row?.tmdbId !== "number" || row.tmdbId <= 0 || row.tmdbId === tmdbId;
    if (agrees && typeof row?.id === "number" && row.id > 0) return { arrId: row.id, raw: row as Record<string, unknown> };
  }
  // Only a lookup row that NAMES this tmdbId — never pickSeriesByTmdbId's
  // trusted lone row. This picks the target of deletes and edits (Replace
  // file, the title manager, add/remove), and a degraded `tmdb:` search can
  // answer one row for another show this library holds (`term=tmdb:84503` →
  // the series with tvdbId 84503). Sonarr v3's rows never carry a tmdbId, so
  // on v3 a series is found only through TMDB's TVDB cross-reference above.
  const looked = await arrFetch<unknown>(cfg, `/api/v3/series/lookup?term=tmdb:${tmdbId}`, opts);
  const row = Array.isArray(looked) ? (looked as Array<{ tmdbId?: unknown; id?: unknown } | null>).find((r) => r?.tmdbId === tmdbId) : undefined;
  return typeof row?.id === "number" && row.id > 0 ? { arrId: row.id, raw: null } : null;
}

export interface TitleState {
  title: ArrTitle;
  /**
   * The instance's own choices for the edit form; null when that list could
   * not be read — the form disables the field rather than refusing to open
   * (the edit re-reads and checks every list it needs anyway).
   */
  qualityProfiles: Choice[] | null;
  rootFolders: RootFolderChoice[] | null;
  tags: Choice[] | null;
}

/**
 * The three lists, each on its own: /api/v3/rootfolder computes free space and
 * scans every root's directory, so a dead mount makes it slow or failing — and
 * one 5xx must not lock the admin out of the Seasons, Files and History tabs,
 * which need none of them.
 */
async function readCatalogTolerant(cfg: ArrCfg): Promise<Omit<TitleState, "title">> {
  const [profiles, folders, tags] = await Promise.allSettled([
    arrFetch<unknown>(cfg, "/api/v3/qualityprofile"),
    arrFetch<unknown>(cfg, "/api/v3/rootfolder"),
    arrFetch<unknown>(cfg, "/api/v3/tag"),
  ]);
  return {
    qualityProfiles: profiles.status === "fulfilled" ? projectChoices(profiles.value) : null,
    rootFolders: folders.status === "fulfilled" ? projectRootFolderChoices(folders.value) : null,
    tags: tags.status === "fulfilled" ? projectChoices(tags.value, "label") : null,
  };
}

async function readCatalog(cfg: ArrCfg) {
  const [profiles, folders, tags] = await Promise.all([
    arrFetch<unknown>(cfg, "/api/v3/qualityprofile"),
    arrFetch<unknown>(cfg, "/api/v3/rootfolder"),
    arrFetch<unknown>(cfg, "/api/v3/tag"),
  ]);
  return {
    qualityProfiles: projectChoices(profiles),
    rootFolders: projectRootFolderChoices(folders),
    tags: projectChoices(tags, "label"),
  };
}

export async function loadTitle(service: ArrService, instance: string, arrId: number, known: Record<string, unknown> | null = null): Promise<TitleState> {
  const cfg = await configuredArrCfg(service, instance);
  const [raw, catalog] = await Promise.all([
    known && known.id === arrId ? Promise.resolve(known) : readRaw(cfg, service, arrId),
    readCatalogTolerant(cfg),
  ]);
  const title = projectTitle(service, instance, raw, (catalog.rootFolders ?? []).map((f) => f.path));
  if (!title) throw new TitleNotFoundError();
  return { title, ...catalog };
}

// ── editing ──────────────────────────────────────────────────────────────────

// One title's edits run one at a time in this process. Season monitoring PUTs
// the WHOLE series back, and Sonarr's PUT /series/{id} applies every field it
// carries — so a season flip that read the series before a Settings save's
// editor PUT landed, and wrote after it, silently reverted the profile and
// tags that save had just applied (and audited). Writes made outside
// Summonarr between the read and the PUT are still overwritten (accepted: a
// resource PUT has no compare-and-swap). processSingleton: route chunks share it.
const titleEdits = processSingleton("arr-title-data:titleEdits", () => new Map<string, Promise<void>>());

async function oneEditAtATime<T>(key: string, run: () => Promise<T>): Promise<T> {
  // A failed edit must not poison the chain: the next one waits for it to
  // SETTLE, never for it to succeed.
  const result = (titleEdits.get(key) ?? Promise.resolve()).then(run);
  const settled = result.then(() => undefined, () => undefined);
  titleEdits.set(key, settled);
  try {
    return await result;
  } finally {
    if (titleEdits.get(key) === settled) titleEdits.delete(key);
  }
}

/**
 * Apply an edit, checked first against the instance's own profiles, root
 * folders, tags and the series' seasons (TitleEditError otherwise — nothing
 * is written). Settings go through the arr's editor endpoint (only the sent
 * fields change); season monitoring is a read-modify-write of the series,
 * re-read after the editor so the two never overwrite each other — and edits
 * of one title are serialized (oneEditAtATime), so another edit's editor PUT
 * can't land between this one's read and its PUT. Answers the title as the
 * arr now has it.
 */
export async function editTitle(
  service: ArrService,
  instance: string,
  arrId: number,
  edit: TitleEdit,
): Promise<{ title: ArrTitle | null; fields: string[] }> {
  return oneEditAtATime(`${service}:${instance}:${arrId}`, () => editTitleNow(service, instance, arrId, edit));
}

async function editTitleNow(
  service: ArrService,
  instance: string,
  arrId: number,
  edit: TitleEdit,
): Promise<{ title: ArrTitle | null; fields: string[] }> {
  const cfg = await configuredArrCfg(service, instance);
  // The catalog is only needed to check a profile, root folder or tags — and
  // /api/v3/rootfolder scans every root's directory listing, so a season or
  // monitored flip doesn't pay for it.
  const needsCatalog = edit.qualityProfileId !== undefined || edit.rootFolderPath !== undefined || edit.tags !== undefined;
  const [raw, catalog] = await Promise.all([readRaw(cfg, service, arrId), needsCatalog ? readCatalog(cfg) : Promise.resolve(null)]);
  const roots = catalog ? catalog.rootFolders.map((f) => f.path) : [];
  const current = projectTitle(service, instance, raw, roots);
  if (!current) throw new TitleNotFoundError();
  checkTitleEdit(edit, {
    profileIds: new Set(catalog?.qualityProfiles.map((p) => p.id) ?? []),
    rootFolders: new Set(roots),
    tagIds: new Set(catalog?.tags.map((t) => t.id) ?? []),
    seasonNumbers: new Set(current.seasons.map((s) => s.seasonNumber)),
  });
  // What actually changes: a root folder equal to the current one is not sent.
  const fields = editedFields(edit).filter((f) => f !== "rootFolderPath" || edit.rootFolderPath !== current.rootFolderPath);
  const body = editorBody(service, arrId, edit, current);
  if (body) {
    await arrFetch<unknown>(cfg, `/api/v3/${service === "radarr" ? "movie" : "series"}/editor`, { method: "PUT", body: JSON.stringify(body) });
  }
  if (service === "sonarr" && edit.seasons && edit.seasons.length > 0) {
    // After an editor write the series is re-read so the PUT carries its new
    // values; with none, the resource just read is still current.
    const fresh = body ? await readRaw(cfg, service, arrId) : raw;
    await arrFetch<unknown>(cfg, resourcePath(service, arrId), { method: "PUT", body: JSON.stringify(withSeasonMonitoring(fresh, edit.seasons)) });
  }
  // The write landed: a failed re-read must not turn it into an error (the
  // route would skip the audit and the admin retry an applied edit). The title
  // is then null and the page reads it again.
  const after = await readRaw(cfg, service, arrId).then((raw) => projectTitle(service, instance, raw, roots)).catch(() => null);
  return { title: after, fields };
}

/** One season's episodes (Sonarr). */
export async function loadSeasonEpisodes(instance: string, seriesId: number, seasonNumber: number): Promise<TitleEpisode[]> {
  const cfg = await configuredArrCfg("sonarr", instance);
  await readRaw(cfg, "sonarr", seriesId);
  return readEpisodes(cfg, seriesId, seasonNumber);
}

/**
 * Monitor or unmonitor episodes of one series. Every id must be one of its
 * episodes. Answers the series as Sonarr now has it: its counts follow
 * monitoring (Sonarr's "(monitored AND aired) OR has a file"), so unmonitoring
 * the one missing episode — guardrail 14a's escape hatch — is visible at once.
 */
export async function setEpisodesMonitored(
  instance: string,
  seriesId: number,
  episodeIds: readonly number[],
  monitored: boolean,
): Promise<{ updated: number; title: ArrTitle | null }> {
  const cfg = await configuredArrCfg("sonarr", instance);
  await episodesOfSeries(cfg, seriesId, episodeIds);
  await arrFetch<unknown>(cfg, "/api/v3/episode/monitor", { method: "PUT", body: JSON.stringify({ episodeIds: [...episodeIds], monitored }) });
  // The write landed: a failed re-read answers title null, never an error (26).
  const title = await readRaw(cfg, "sonarr", seriesId).then((raw) => projectTitle("sonarr", instance, raw)).catch(() => null);
  return { updated: episodeIds.length, title };
}

// ── files ────────────────────────────────────────────────────────────────────

async function readFiles(cfg: ArrCfg, service: ArrService, arrId: number, withEpisodes = true): Promise<TitleFile[]> {
  if (service === "radarr") return projectFiles("radarr", ownRows("radarr", arrId, await arrFetch<unknown>(cfg, `/api/v3/moviefile?movieId=${arrId}`)));
  // The episode list only says which episodes each file holds — a delete's
  // check needs the file ids alone.
  const [files, episodes] = await Promise.all([
    arrFetch<unknown>(cfg, `/api/v3/episodefile?seriesId=${arrId}`),
    withEpisodes ? readEpisodes(cfg, arrId) : Promise.resolve([]),
  ]);
  return projectFiles("sonarr", ownRows("sonarr", arrId, files), episodes);
}

export async function loadTitleFiles(service: ArrService, instance: string, arrId: number): Promise<TitleFile[]> {
  const cfg = await configuredArrCfg(service, instance);
  await readRaw(cfg, service, arrId);
  return readFiles(cfg, service, arrId);
}

// A delete moves each file to the recycle bin when one is set — a COPY when the
// bin is on another filesystem — so it is slow by nature (arrFetch's timeoutMs).
const FILE_DELETE_TIMEOUT_MS = 120_000;

/**
 * A delete that THREW may still have deleted files: Sonarr's bulk delete
 * removes them one at a time and stops at the first it can't (the earlier ones
 * stay gone), and any delete can outlast the timeout while the arr finishes it.
 * So the title's files are re-read, and every chosen id that is `confirmed` or
 * no longer listed counts as deleted — the caller audits it (guardrail 26),
 * re-monitors and follows it up like any other (guardrail 5f). Only a throw
 * with nothing gone, as far as the re-read can tell, is the arr's failure.
 *
 * Narrowed, not closed: a file the arr removes AFTER this re-read (a timed-out
 * delete still copying into the bin) is not counted, and a file that vanished
 * for another reason in the same moment is counted as this delete's.
 */
async function deletedAfterFailure(
  cfg: ArrCfg,
  service: ArrService,
  arrId: number,
  fileIds: readonly number[],
  confirmed: readonly number[],
  err: unknown,
): Promise<{ deleted: number[]; error: unknown }> {
  const listed = await readFiles(cfg, service, arrId, false).then((files) => new Set(files.map((f) => f.id))).catch(() => null);
  const done = new Set(confirmed);
  const deleted = fileIds.filter((id) => done.has(id) || (listed !== null && !listed.has(id)));
  if (deleted.length === 0) throw err;
  // Every chosen file is gone (a timeout the arr finished): what was asked happened.
  return { deleted, error: deleted.length === fileIds.length ? null : err };
}

/**
 * Delete files of one title from disk, through the arr (which records the
 * deletion in its history and, if the title is monitored, will look for it
 * again). Every id must be one of the title's files as the arr lists them now.
 * A delete that fails part-way answers what WAS deleted with the error
 * (deletedAfterFailure) — no error once every chosen file is gone — and throws
 * only when nothing was.
 */
export async function deleteTitleFiles(
  service: ArrService,
  instance: string,
  arrId: number,
  fileIds: readonly number[],
): Promise<{ deleted: number[]; error: unknown }> {
  const cfg = await configuredArrCfg(service, instance);
  const own = new Set((await readFiles(cfg, service, arrId, false)).map((f) => f.id));
  if (fileIds.length === 0 || fileIds.some((id) => !own.has(id))) throw new NotOnTitleError("file");
  if (service === "sonarr") {
    try {
      await arrFetchNoContent(cfg, "/api/v3/episodefile/bulk", {
        method: "DELETE",
        body: JSON.stringify({ episodeFileIds: [...fileIds] }),
        timeoutMs: FILE_DELETE_TIMEOUT_MS,
      });
    } catch (err) {
      return deletedAfterFailure(cfg, service, arrId, fileIds, [], err);
    }
    return { deleted: [...fileIds], error: null };
  }
  // A movie has a file or two: one DELETE each, on every Radarr version.
  // Radarr's bulk delete is NOT a shortcut — it applies the first file's movie
  // to every file. A failure part-way returns what was already deleted, so the
  // caller audits exactly that (guardrail 26) instead of nothing.
  const deleted: number[] = [];
  for (const id of fileIds) {
    try {
      await arrFetchNoContent(cfg, `/api/v3/moviefile/${id}`, { method: "DELETE", timeoutMs: FILE_DELETE_TIMEOUT_MS });
    } catch (err) {
      return deletedAfterFailure(cfg, service, arrId, fileIds, deleted, err);
    }
    deleted.push(id);
  }
  return { deleted, error: null };
}

// ── renames ──────────────────────────────────────────────────────────────────

const renamePath = (service: ArrService, arrId: number) => `/api/v3/rename?${service === "radarr" ? "movieId" : "seriesId"}=${arrId}`;

export async function loadRenamePreview(service: ArrService, instance: string, arrId: number): Promise<RenamePreview[]> {
  const cfg = await configuredArrCfg(service, instance);
  await readRaw(cfg, service, arrId);
  return projectRenames(service, ownRows(service, arrId, await arrFetch<unknown>(cfg, renamePath(service, arrId))));
}

/**
 * Rename files to the arr's naming scheme (its RenameFiles command). Only files
 * the arr's preview, re-read now, still says would change are renamed. Answers
 * how many, and the arr's id for the command (the page follows it, then
 * re-reads the files).
 */
export async function renameTitleFiles(
  service: ArrService,
  instance: string,
  arrId: number,
  fileIds: readonly number[],
): Promise<{ files: number; commandIds: number[] }> {
  const cfg = await configuredArrCfg(service, instance);
  // RenameFiles names files by id only and renames them with THIS title's
  // metadata, so a file the preview lists for another title would be renamed
  // and moved into this one's folder — rows that name another title are dropped.
  const pending = new Set(projectRenames(service, ownRows(service, arrId, await arrFetch<unknown>(cfg, renamePath(service, arrId)))).map((r) => r.fileId));
  const files = fileIds.filter((id) => pending.has(id));
  if (files.length === 0 || files.length !== fileIds.length) throw new NotOnTitleError("file");
  const queued = await postArrCommand(cfg, service === "radarr"
    ? { name: "RenameFiles", movieId: arrId, files }
    : { name: "RenameFiles", seriesId: arrId, files });
  return { files: files.length, commandIds: commandIdsOf([queued]) };
}

// ── history ──────────────────────────────────────────────────────────────────

/**
 * The title's whole history. `episodes: false` skips the S/E — no embedded
 * episode on Sonarr v3 (a long daily show's history is then a fraction of the
 * size) and no episode-list join on v4 — for a caller that needs only ids,
 * kinds and download ids: Mark failed, whose write must not fail on a read
 * that is only for display.
 */
async function readTitleHistory(
  cfg: ArrCfg,
  service: ArrService,
  instance: string,
  arrId: number,
  { episodes: withEpisodes = true }: { episodes?: boolean } = {},
): Promise<ArrHistoryEvent[]> {
  const path = service === "radarr"
    ? `/api/v3/history/movie?movieId=${arrId}`
    : `/api/v3/history/series?seriesId=${arrId}&includeEpisode=${withEpisodes}`;
  const events = projectHistoryRecords(service, instance, await arrFetch<unknown>(cfg, path))
    .filter((e) => e.arrMediaId === null || e.arrMediaId === arrId);
  // Sonarr v4's per-series history embeds no `episode` (only v3 does); the S/E
  // comes from the series' own episode list, by the record's episodeId.
  if (withEpisodes && service === "sonarr" && events.some((e) => e.episode === null && e.episodeId !== null)) {
    const episodes = new Map((await readEpisodes(cfg, arrId)).map((e) => [e.id, e]));
    for (const e of events) {
      const ep = e.episode === null && e.episodeId !== null ? episodes.get(e.episodeId) : undefined;
      if (ep) e.episode = { seasonNumber: ep.seasonNumber, episodeNumber: ep.episodeNumber, title: ep.title };
    }
  }
  return sortHistoryEvents(events);
}

export async function loadTitleHistory(service: ArrService, instance: string, arrId: number): Promise<ArrHistoryEvent[]> {
  const cfg = await configuredArrCfg(service, instance);
  await readRaw(cfg, service, arrId);
  return readTitleHistory(cfg, service, instance, arrId);
}

// A mark in flight, per download, in this process (guardrail 17's one
// server). The history check reads the arr's records, but two marks of one
// download — two tabs, two admins, the History page beside an issue's Replace
// file, two episode rows of one pack — can each read a history with no failure
// in it yet. The first to pass the check CLAIMS the download, synchronously,
// before its POST; the other is MarkInProgressError (409) with nothing sent. A
// definite refusal (a 4xx other than 408 — release-grab.ts's rule) hands the
// claim back; an accepted mark keeps it for MARK_CLAIM_TTL_MS. Any other
// failure (a timeout, a refused connection, a 5xx — the arr may have taken
// it) keeps it only MARK_UNKNOWN_HOLD_MS past the failure: after that, the
// next mark's fresh history read decides. The arr writes its DownloadFailed
// record inside the POST, so a mark that landed is refused there as already
// failed, and one that never reached the arr is sent — 10 minutes of "already
// failed" for a download nobody marked kept an issue's Replace file from
// blocklisting the bad release (guardrail 5f). A claim
// covers only the grabs the history held when it was taken (`upTo`): a torrent
// grabbed again after the failure keeps its info hash, and marking THAT grab
// is a new mark. processSingleton: route chunks share it.
const MARK_CLAIM_TTL_MS = 10 * 60_000;
const MARK_UNKNOWN_HOLD_MS = 90_000;
const markClaims = processSingleton("arr-title-data:markClaims", () => new Map<string, { expiresAt: number; upTo: number }>());

/** Test seam: forget every mark claim. */
export function _resetMarkClaimsForTests(): void {
  markClaims.clear();
}

const definitelyRefused = (err: unknown): boolean =>
  err instanceof ArrResponseError && err.status >= 400 && err.status < 500 && err.status !== 408;

/**
 * Mark a grab failed — the arr's own "Mark as failed": the release is
 * blocklisted, the download handled as failed, and (if the arr's Redownload
 * Failed setting is on) a new search started. The record must be a GRAB of
 * this title, as the arr's history reads now, whose download is not already
 * failed: Sonarr writes one Grabbed record PER EPISODE of a pack, and marking
 * any one fails the whole download — a second one would blocklist and search
 * again (the per-episode trap guardrail 5c handles for the queue). A grab with
 * no downloadId (a Blackhole client reports none) is its own download: it is
 * already failed by a newer failure naming the same release (and, on Sonarr,
 * the same episode) — the record the arr's manual mark writes for it.
 */
export async function markHistoryFailed(service: ArrService, instance: string, arrId: number, historyId: number): Promise<ArrHistoryEvent> {
  const cfg = await configuredArrCfg(service, instance);
  // Ids, kinds and download ids are all the checks read — the S/E is display only.
  const history = await readTitleHistory(cfg, service, instance, arrId, { episodes: false });
  const event = history.find((e) => e.id === historyId);
  if (!event) throw new NotOnTitleError("history");
  if (event.kind !== "grabbed") throw new NotAGrabError();
  // Only a failure recorded AFTER this grab (history ids only grow) means its
  // download already failed: a torrent's downloadId is its info hash, so a
  // release grabbed again after an earlier failure shares the old record's id.
  const failedSince = (e: ArrHistoryEvent) => (event.downloadId !== null
    ? e.kind === "failed" && e.id > event.id && e.downloadId === event.downloadId
    : failsIdlessGrab(event, e));
  if (history.some(failedSince)) throw new AlreadyFailedError();
  // No await between this check and the claim below.
  const now = Date.now();
  for (const [k, c] of markClaims) if (c.expiresAt <= now) markClaims.delete(k);
  const key = [service, instance, cfg.url, event.downloadId !== null ? `d:${event.downloadId}` : `h:${event.id}`].join("\u0000");
  const held = markClaims.get(key);
  if (held && event.id <= held.upTo) throw new MarkInProgressError();
  const claim = { expiresAt: now + MARK_CLAIM_TTL_MS, upTo: history.reduce((m, e) => Math.max(m, e.id), event.id) };
  markClaims.set(key, claim);
  try {
    await sendMarkFailed(cfg, historyId);
  } catch (err) {
    if (markClaims.get(key) === claim) {
      if (definitelyRefused(err)) markClaims.delete(key);
      else claim.expiresAt = Math.min(claim.expiresAt, Date.now() + MARK_UNKNOWN_HOLD_MS);
    }
    throw err;
  }
  return event;
}

async function sendMarkFailed(cfg: ArrCfg, historyId: number): Promise<void> {
  try {
    await arrFetchNoContent(cfg, `/api/v3/history/failed/${historyId}`, { method: "POST" });
    return;
  } catch (err) {
    if (!(err instanceof ArrResponseError) || (err.status !== 404 && err.status !== 405)) throw err;
  }
  // Older v3 builds: POST /history/failed with the id in the body — a form
  // field on the Nancy-era API, a JSON number on the first ASP.NET builds.
  try {
    await arrFetchNoContent(cfg, "/api/v3/history/failed", {
      method: "POST",
      body: new URLSearchParams({ id: String(historyId) }).toString(),
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
    });
  } catch (err) {
    if (!(err instanceof ArrResponseError) || (err.status !== 400 && err.status !== 415)) throw err;
    await arrFetchNoContent(cfg, "/api/v3/history/failed", { method: "POST", body: JSON.stringify(historyId) });
  }
}

// ── searching ────────────────────────────────────────────────────────────────

export interface TitleCommandResult {
  commands: number;
  /** The arr's ids for the queued commands — the page follows them (GET /api/admin/arr/commands). */
  commandIds: number[];
}

const queuedOne = (queued: { id: number | null }): TitleCommandResult => ({ commands: 1, commandIds: commandIdsOf([queued]) });

export async function refreshTitle(service: ArrService, instance: string, arrId: number): Promise<TitleCommandResult> {
  const cfg = await configuredArrCfg(service, instance);
  await readRaw(cfg, service, arrId);
  return queuedOne(await postArrCommand(cfg, service === "radarr" ? { name: "RefreshMovie", movieIds: [arrId] } : { name: "RefreshSeries", seriesId: arrId }));
}

/** Radarr's own movie Search (MoviesSearch — an upgrade search when it has a file). */
export async function searchMovie(instance: string, movieId: number): Promise<TitleCommandResult> {
  const cfg = await configuredArrCfg("radarr", instance);
  await readRaw(cfg, "radarr", movieId);
  return queuedOne(await postArrCommand(cfg, { name: "MoviesSearch", movieIds: [movieId] }));
}

/** Search one season of a series (SeasonSearch). The season must be the series'. */
export async function searchSeason(instance: string, seriesId: number, seasonNumber: number): Promise<TitleCommandResult> {
  const cfg = await configuredArrCfg("sonarr", instance);
  const title = projectTitle("sonarr", instance, await readRaw(cfg, "sonarr", seriesId));
  if (!title?.seasons.some((s) => s.seasonNumber === seasonNumber)) throw new NotOnTitleError("season");
  return queuedOne(await postArrCommand(cfg, { name: "SeasonSearch", seriesId, seasonNumber }));
}

/**
 * Search chosen episodes of a series (one EpisodeSearch). Every id must be one
 * of its episodes. `missingOnly` (the calendar's Search on a missing entry)
 * re-judges each id live and searches only the ones still without a file that
 * have aired — an EpisodeSearch on an episode WITH a file is an upgrade search,
 * which nobody asked for — and is NothingMissingError (409) when none is left.
 */
export async function searchEpisodes(
  instance: string,
  seriesId: number,
  episodeIds: readonly number[],
  opts: { missingOnly?: boolean; now?: Date } = {},
): Promise<TitleCommandResult> {
  const cfg = await configuredArrCfg("sonarr", instance);
  const episodes = await episodesOfSeries(cfg, seriesId, episodeIds);
  let ids = [...episodeIds];
  if (opts.missingOnly) {
    const now = (opts.now ?? new Date()).getTime();
    ids = ids.filter((id) => {
      const e = episodes.get(id);
      const aired = e?.airDateUtc ? Date.parse(e.airDateUtc) : NaN;
      return e !== undefined && !e.hasFile && Number.isFinite(aired) && aired <= now;
    });
    if (ids.length === 0) throw new NothingMissingError();
  }
  return queuedOne(await postArrCommand(cfg, { name: "EpisodeSearch", episodeIds: ids }));
}

/**
 * What an interactive search is for: the movie, one season of a series, or
 * one episode. Sonarr has no whole-series release search — a series-only
 * query answers with the indexers' RSS feed — so a series needs one of the two.
 */
export type ReleaseScope = { seasonNumber: number } | { episodeId: number } | null;

async function releaseQuery(cfg: ArrCfg, service: ArrService, arrId: number, scope: ReleaseScope) {
  const raw = await readRaw(cfg, service, arrId);
  const profile = typeof raw.qualityProfileId === "number" ? raw.qualityProfileId : null;
  if (service === "radarr") return { query: `movieId=${arrId}`, profile };
  if (scope && "seasonNumber" in scope) {
    const title = projectTitle("sonarr", "", raw);
    if (!title?.seasons.some((s) => s.seasonNumber === scope.seasonNumber)) throw new NotOnTitleError("season");
    return { query: `seriesId=${arrId}&seasonNumber=${scope.seasonNumber}`, profile };
  }
  if (scope && "episodeId" in scope) {
    await episodesOfSeries(cfg, arrId, [scope.episodeId]);
    return { query: `episodeId=${scope.episodeId}`, profile };
  }
  throw new NotOnTitleError("season");
}

/** Interactive search for the title (indexers are hit live). */
export async function searchTitleReleases(service: ArrService, instance: string, arrId: number, scope: ReleaseScope): Promise<ArrRelease[]> {
  const cfg = await configuredArrCfg(service, instance);
  const { query, profile } = await releaseQuery(cfg, service, arrId, scope);
  return searchReleasesByArrId(cfg, query, profile);
}

/**
 * Grab a release an interactive search for this title returned (the arr keeps
 * its search results for 30 minutes and grabs from that cache by guid).
 * `progress.sent` turns true only once the grab itself is about to be sent —
 * a failure before it (the config, the title read) sent nothing.
 */
export async function grabTitleRelease(
  service: ArrService,
  instance: string,
  arrId: number,
  release: { guid: string; indexerId: number },
  scope: ReleaseScope,
  progress?: GrabProgress,
): Promise<void> {
  const cfg = await configuredArrCfg(service, instance);
  await readRaw(cfg, service, arrId);
  const body: Record<string, unknown> = { guid: release.guid, indexerId: release.indexerId };
  if (service === "radarr") body.movieId = arrId;
  else {
    body.seriesId = arrId;
    if (scope && "episodeId" in scope) body.episodeId = scope.episodeId;
  }
  if (progress) progress.sent = true;
  await postReleaseGrab(cfg, body);
}
