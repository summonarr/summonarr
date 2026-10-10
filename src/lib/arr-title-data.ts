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
  pickSeriesByTmdbId,
  resolveTmdbToTvdb,
  searchReleasesByArrId,
  type ArrCfg,
  type ArrRelease,
} from "./arr";
import { configuredArrCfg, postArrCommand, type ArrService } from "./arr-admin";
import { projectHistoryRecords, sortHistoryEvents, type ArrHistoryEvent } from "./arr-history";
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

async function readEpisodes(cfg: ArrCfg, seriesId: number, seasonNumber?: number): Promise<TitleEpisode[]> {
  const q = seasonNumber === undefined ? `seriesId=${seriesId}` : `seriesId=${seriesId}&seasonNumber=${seasonNumber}`;
  const episodes = projectEpisodes(await arrFetch<unknown>(cfg, `/api/v3/episode?${q}`));
  // Older Sonarr ignores seasonNumber; filter here so the answer is the season either way.
  return seasonNumber === undefined ? episodes : episodes.filter((e) => e.seasonNumber === seasonNumber);
}

// ── finding and loading ──────────────────────────────────────────────────────

/**
 * The arr's id for a TMDB title on one instance, or null when the instance
 * doesn't have it. Radarr filters its library by tmdbId. Sonarr can only
 * filter by tvdbId: TMDB's own TVDB cross-reference is tried first (cached),
 * then Sonarr's lookup, which marks a series it already has with a positive id.
 */
export async function findTitleId(service: ArrService, instance: string, tmdbId: number): Promise<number | null> {
  const cfg = await configuredArrCfg(service, instance);
  if (service === "radarr") {
    const movies = await arrFetch<unknown>(cfg, `/api/v3/movie?tmdbId=${tmdbId}`);
    const row = Array.isArray(movies) ? (movies as Array<{ id?: unknown; tmdbId?: unknown }>).find((m) => m?.tmdbId === tmdbId) : undefined;
    return typeof row?.id === "number" && row.id > 0 ? row.id : null;
  }
  const tvdbId = await resolveTmdbToTvdb(tmdbId);
  if (tvdbId !== null) {
    const library = await arrFetch<unknown>(cfg, `/api/v3/series?tvdbId=${tvdbId}`);
    const row = Array.isArray(library)
      ? (library as Array<{ id?: unknown; tvdbId?: unknown; tmdbId?: unknown }>).find((s) => s?.tvdbId === tvdbId)
      : undefined;
    // A series that names a DIFFERENT TMDB title is not this one (TMDB's cross-reference is user-edited).
    const agrees = typeof row?.tmdbId !== "number" || row.tmdbId <= 0 || row.tmdbId === tmdbId;
    if (agrees && typeof row?.id === "number" && row.id > 0) return row.id;
  }
  const looked = await arrFetch<unknown>(cfg, `/api/v3/series/lookup?term=tmdb:${tmdbId}`);
  const row = pickSeriesByTmdbId(Array.isArray(looked) ? (looked as Array<{ tmdbId?: number; id?: unknown }>) : [], tmdbId);
  return typeof row?.id === "number" && row.id > 0 ? row.id : null;
}

export interface TitleState {
  title: ArrTitle;
  /** The instance's own choices for the edit form. */
  qualityProfiles: Choice[];
  rootFolders: RootFolderChoice[];
  tags: Choice[];
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

export async function loadTitle(service: ArrService, instance: string, arrId: number): Promise<TitleState> {
  const cfg = await configuredArrCfg(service, instance);
  const [raw, catalog] = await Promise.all([readRaw(cfg, service, arrId), readCatalog(cfg)]);
  const title = projectTitle(service, instance, raw, catalog.rootFolders.map((f) => f.path));
  if (!title) throw new TitleNotFoundError();
  return { title, ...catalog };
}

// ── editing ──────────────────────────────────────────────────────────────────

/**
 * Apply an edit, checked first against the instance's own profiles, root
 * folders, tags and the series' seasons (TitleEditError otherwise — nothing
 * is written). Settings go through the arr's editor endpoint (only the sent
 * fields change); season monitoring is a read-modify-write of the series,
 * re-read after the editor so the two never overwrite each other. Answers the
 * title as the arr now has it.
 */
export async function editTitle(
  service: ArrService,
  instance: string,
  arrId: number,
  edit: TitleEdit,
): Promise<{ title: ArrTitle; fields: string[] }> {
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
    const fresh = await readRaw(cfg, service, arrId);
    await arrFetch<unknown>(cfg, resourcePath(service, arrId), { method: "PUT", body: JSON.stringify(withSeasonMonitoring(fresh, edit.seasons)) });
  }
  const after = projectTitle(service, instance, await readRaw(cfg, service, arrId), roots);
  if (!after) throw new TitleNotFoundError();
  return { title: after, fields };
}

/** One season's episodes (Sonarr). */
export async function loadSeasonEpisodes(instance: string, seriesId: number, seasonNumber: number): Promise<TitleEpisode[]> {
  const cfg = await configuredArrCfg("sonarr", instance);
  await readRaw(cfg, "sonarr", seriesId);
  return readEpisodes(cfg, seriesId, seasonNumber);
}

/** Monitor or unmonitor episodes of one series. Every id must be one of its episodes. */
export async function setEpisodesMonitored(instance: string, seriesId: number, episodeIds: readonly number[], monitored: boolean): Promise<number> {
  const cfg = await configuredArrCfg("sonarr", instance);
  const own = new Set((await readEpisodes(cfg, seriesId)).map((e) => e.id));
  if (episodeIds.some((id) => !own.has(id))) throw new NotOnTitleError("episode");
  await arrFetch<unknown>(cfg, "/api/v3/episode/monitor", { method: "PUT", body: JSON.stringify({ episodeIds: [...episodeIds], monitored }) });
  return episodeIds.length;
}

// ── files ────────────────────────────────────────────────────────────────────

async function readFiles(cfg: ArrCfg, service: ArrService, arrId: number): Promise<TitleFile[]> {
  if (service === "radarr") return projectFiles("radarr", await arrFetch<unknown>(cfg, `/api/v3/moviefile?movieId=${arrId}`));
  const [files, episodes] = await Promise.all([
    arrFetch<unknown>(cfg, `/api/v3/episodefile?seriesId=${arrId}`),
    readEpisodes(cfg, arrId),
  ]);
  return projectFiles("sonarr", files, episodes);
}

export async function loadTitleFiles(service: ArrService, instance: string, arrId: number): Promise<TitleFile[]> {
  const cfg = await configuredArrCfg(service, instance);
  await readRaw(cfg, service, arrId);
  return readFiles(cfg, service, arrId);
}

/**
 * Delete files of one title from disk, through the arr (which records the
 * deletion in its history and, if the title is monitored, will look for it
 * again). Every id must be one of the title's files as the arr lists them now.
 */
export async function deleteTitleFiles(service: ArrService, instance: string, arrId: number, fileIds: readonly number[]): Promise<number> {
  const cfg = await configuredArrCfg(service, instance);
  const own = new Set((await readFiles(cfg, service, arrId)).map((f) => f.id));
  if (fileIds.length === 0 || fileIds.some((id) => !own.has(id))) throw new NotOnTitleError("file");
  if (service === "sonarr") {
    await arrFetchNoContent(cfg, "/api/v3/episodefile/bulk", { method: "DELETE", body: JSON.stringify({ episodeFileIds: [...fileIds] }) });
  } else {
    // A movie has a file or two; one DELETE each works on every Radarr version.
    for (const id of fileIds) await arrFetchNoContent(cfg, `/api/v3/moviefile/${id}`, { method: "DELETE" });
  }
  return fileIds.length;
}

// ── renames ──────────────────────────────────────────────────────────────────

const renamePath = (service: ArrService, arrId: number) => `/api/v3/rename?${service === "radarr" ? "movieId" : "seriesId"}=${arrId}`;

export async function loadRenamePreview(service: ArrService, instance: string, arrId: number): Promise<RenamePreview[]> {
  const cfg = await configuredArrCfg(service, instance);
  await readRaw(cfg, service, arrId);
  return projectRenames(service, await arrFetch<unknown>(cfg, renamePath(service, arrId)));
}

/**
 * Rename files to the arr's naming scheme (its RenameFiles command). Only files
 * the arr's preview, re-read now, still says would change are renamed.
 */
export async function renameTitleFiles(service: ArrService, instance: string, arrId: number, fileIds: readonly number[]): Promise<number> {
  const cfg = await configuredArrCfg(service, instance);
  const pending = new Set(projectRenames(service, await arrFetch<unknown>(cfg, renamePath(service, arrId))).map((r) => r.fileId));
  const files = fileIds.filter((id) => pending.has(id));
  if (files.length === 0 || files.length !== fileIds.length) throw new NotOnTitleError("file");
  await postArrCommand(cfg, service === "radarr"
    ? { name: "RenameFiles", movieId: arrId, files }
    : { name: "RenameFiles", seriesId: arrId, files });
  return files.length;
}

// ── history ──────────────────────────────────────────────────────────────────

async function readTitleHistory(cfg: ArrCfg, service: ArrService, instance: string, arrId: number): Promise<ArrHistoryEvent[]> {
  const path = service === "radarr"
    ? `/api/v3/history/movie?movieId=${arrId}`
    : `/api/v3/history/series?seriesId=${arrId}&includeEpisode=true`;
  return sortHistoryEvents(projectHistoryRecords(service, instance, await arrFetch<unknown>(cfg, path)));
}

export async function loadTitleHistory(service: ArrService, instance: string, arrId: number): Promise<ArrHistoryEvent[]> {
  const cfg = await configuredArrCfg(service, instance);
  await readRaw(cfg, service, arrId);
  return readTitleHistory(cfg, service, instance, arrId);
}

/**
 * Mark a grab failed — the arr's own "Mark as failed": the release is
 * blocklisted, the download handled as failed, and (if the arr's Redownload
 * Failed setting is on) a new search started. The record must be a GRAB of
 * this title, as the arr's history reads now, whose download is not already
 * failed: Sonarr writes one Grabbed record PER EPISODE of a pack, and marking
 * any one fails the whole download — a second one would blocklist and search
 * again (the per-episode trap guardrail 5c handles for the queue).
 */
export async function markHistoryFailed(service: ArrService, instance: string, arrId: number, historyId: number): Promise<ArrHistoryEvent> {
  const cfg = await configuredArrCfg(service, instance);
  const history = await readTitleHistory(cfg, service, instance, arrId);
  const event = history.find((e) => e.id === historyId);
  if (!event) throw new NotOnTitleError("history");
  if (event.kind !== "grabbed") throw new NotAGrabError();
  if (event.downloadId !== null && history.some((e) => e.kind === "failed" && e.downloadId === event.downloadId)) throw new AlreadyFailedError();
  try {
    await arrFetchNoContent(cfg, `/api/v3/history/failed/${historyId}`, { method: "POST" });
    return event;
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
  return event;
}

// ── searching ────────────────────────────────────────────────────────────────

export interface TitleCommandResult { commands: number }

export async function refreshTitle(service: ArrService, instance: string, arrId: number): Promise<TitleCommandResult> {
  const cfg = await configuredArrCfg(service, instance);
  await readRaw(cfg, service, arrId);
  await postArrCommand(cfg, service === "radarr" ? { name: "RefreshMovie", movieIds: [arrId] } : { name: "RefreshSeries", seriesId: arrId });
  return { commands: 1 };
}

/** Radarr's own movie Search (MoviesSearch — an upgrade search when it has a file). */
export async function searchMovie(instance: string, movieId: number): Promise<TitleCommandResult> {
  const cfg = await configuredArrCfg("radarr", instance);
  await readRaw(cfg, "radarr", movieId);
  await postArrCommand(cfg, { name: "MoviesSearch", movieIds: [movieId] });
  return { commands: 1 };
}

/** Search one season of a series (SeasonSearch). The season must be the series'. */
export async function searchSeason(instance: string, seriesId: number, seasonNumber: number): Promise<TitleCommandResult> {
  const cfg = await configuredArrCfg("sonarr", instance);
  const title = projectTitle("sonarr", instance, await readRaw(cfg, "sonarr", seriesId));
  if (!title?.seasons.some((s) => s.seasonNumber === seasonNumber)) throw new NotOnTitleError("season");
  await postArrCommand(cfg, { name: "SeasonSearch", seriesId, seasonNumber });
  return { commands: 1 };
}

/** Search chosen episodes of a series (one EpisodeSearch). Every id must be one of its episodes. */
export async function searchEpisodes(instance: string, seriesId: number, episodeIds: readonly number[]): Promise<TitleCommandResult> {
  const cfg = await configuredArrCfg("sonarr", instance);
  const own = new Set((await readEpisodes(cfg, seriesId)).map((e) => e.id));
  if (episodeIds.length === 0 || episodeIds.some((id) => !own.has(id))) throw new NotOnTitleError("episode");
  await postArrCommand(cfg, { name: "EpisodeSearch", episodeIds: [...episodeIds] });
  return { commands: 1 };
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
    if (!(await readEpisodes(cfg, arrId)).some((e) => e.id === scope.episodeId)) throw new NotOnTitleError("episode");
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
 */
export async function grabTitleRelease(
  service: ArrService,
  instance: string,
  arrId: number,
  release: { guid: string; indexerId: number },
  scope: ReleaseScope,
): Promise<void> {
  const cfg = await configuredArrCfg(service, instance);
  await readRaw(cfg, service, arrId);
  const body: Record<string, unknown> = { guid: release.guid, indexerId: release.indexerId };
  if (service === "radarr") body.movieId = arrId;
  else {
    body.seriesId = arrId;
    if (scope && "episodeId" in scope) body.episodeId = scope.episodeId;
  }
  await arrFetch<unknown>(cfg, "/api/v3/release", { method: "POST", body: JSON.stringify(body) });
}
