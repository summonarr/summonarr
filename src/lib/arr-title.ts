// The admin title manager — the pure half. Projects one Radarr movie or Sonarr
// series (and its episodes, files and pending renames) down to exactly what
// the manager shows, and turns the admin's edit into the body Radarr/Sonarr's
// own editor endpoint takes. Zero I/O; the data half is arr-title-data.ts.
//
// An edit names VALUES the instance already offers — a quality profile id, a
// root folder path, tag ids, season numbers. checkTitleEdit refuses anything
// the instance's own lists don't contain, so nothing the browser invents
// (a root folder path above all: Radarr/Sonarr MOVE the files there) reaches
// the arr. The same rule guardrail 5d applies to Manual Import (guardrail 5e).
import {
  bool,
  bytes,
  bytesOrNull,
  idsOf,
  int,
  isoOrNull,
  languageNamesOf,
  namesOf,
  nonNegInt,
  posInt,
  PROJECTION_SCAN_FACTOR,
  qualityOf,
  text,
  textOrNull,
  type QualityTag,
} from "./arr-parse";
import type { ArrService } from "./arr-instances";
import { comparablePath, isUnderComparable } from "./arr-path";

export type { ArrService };

export const MINIMUM_AVAILABILITIES = ["announced", "inCinemas", "released"] as const;
export type MinimumAvailability = (typeof MINIMUM_AVAILABILITIES)[number];
export const SERIES_TYPES = ["standard", "daily", "anime"] as const;
export type SeriesType = (typeof SERIES_TYPES)[number];
export const MONITOR_NEW_ITEMS = ["all", "none"] as const;
export type MonitorNewItems = (typeof MONITOR_NEW_ITEMS)[number];

export const isOneOf = <T extends string>(list: readonly T[], v: unknown): v is T => typeof v === "string" && (list as readonly string[]).includes(v);

/**
 * A request body's tag ids: deduped, or null when it is not an array of at
 * most `max` positive integers. The edit and the add share it.
 */
export function parseTagIds(v: unknown, max: number): number[] | null {
  if (!Array.isArray(v) || v.length > max) return null;
  const ids: number[] = [];
  for (const t of v) {
    const id = posInt(t);
    if (id === null) return null;
    ids.push(id);
  }
  return [...new Set(ids)];
}

// ── the title ────────────────────────────────────────────────────────────────

export interface TitleSeason {
  seasonNumber: number;
  monitored: boolean;
  /** Sonarr's own "(monitored AND aired) OR has a file" — the episodes that count. */
  episodeCount: number;
  episodeFileCount: number;
  /** Every episode the season has, aired or not. */
  totalEpisodeCount: number;
  sizeOnDisk: number;
  nextAiring: string | null;
  previousAiring: string | null;
}

export interface ArrTitle {
  service: ArrService;
  instance: string;
  /** Radarr movie id / Sonarr series id. */
  arrId: number;
  title: string;
  year: number | null;
  tmdbId: number | null;
  tvdbId: number | null;
  imdbId: string | null;
  /** The arr's own status word: Radarr announced/inCinemas/released/deleted, Sonarr continuing/ended/upcoming/deleted. */
  status: string | null;
  monitored: boolean;
  qualityProfileId: number | null;
  rootFolderPath: string | null;
  path: string | null;
  tags: number[];
  sizeOnDisk: number;
  added: string | null;
  /** Radarr: the movie has a file. Sonarr: at least one episode does. */
  hasFile: boolean;
  // Radarr only (null on a series).
  minimumAvailability: string | null;
  inCinemas: string | null;
  physicalRelease: string | null;
  digitalRelease: string | null;
  isAvailable: boolean | null;
  studio: string | null;
  // Sonarr only (null on a movie).
  seriesType: string | null;
  seasonFolder: boolean | null;
  /** Sonarr v4's "monitor new seasons"; null on v3, which has no such setting. */
  monitorNewItems: string | null;
  network: string | null;
  /** Regular seasons' counts summed (specials excluded, guardrail 14a). */
  episodeCount: number;
  episodeFileCount: number;
  nextAiring: string | null;
  previousAiring: string | null;
  /** Every season Sonarr lists, specials (season 0) included. Empty on a movie. */
  seasons: TitleSeason[];
}

type Raw = Record<string, unknown>;
const obj = (v: unknown): Raw | null => (v && typeof v === "object" && !Array.isArray(v) ? (v as Raw) : null);

/**
 * The root folder a path sits under, from the instance's own list — for an arr
 * that omits rootFolderPath. Paths compare as the storage tab's do (arr-path):
 * either separator, a Windows drive case-insensitively. A root of "/" holds
 * every path and so names none of them.
 */
export function rootFolderFor(path: string | null, rootFolders: readonly string[]): string | null {
  if (!path) return null;
  const p = comparablePath(path);
  let best: string | null = null;
  let bestLength = -1;
  for (const root of rootFolders) {
    const prefix = comparablePath(root);
    if (prefix === "" || prefix === "/") continue;
    if (isUnderComparable(p, prefix) && prefix.length > bestLength) {
      best = root;
      bestLength = prefix.length;
    }
  }
  return best;
}

function seasonsOf(v: unknown): TitleSeason[] {
  if (!Array.isArray(v)) return [];
  const out: TitleSeason[] = [];
  for (const s of v) {
    const season = obj(s);
    const n = nonNegInt(season?.seasonNumber);
    if (!season || n === null) continue;
    const st = obj(season.statistics);
    out.push({
      seasonNumber: n,
      monitored: bool(season.monitored),
      episodeCount: nonNegInt(st?.episodeCount) ?? 0,
      episodeFileCount: nonNegInt(st?.episodeFileCount) ?? 0,
      totalEpisodeCount: nonNegInt(st?.totalEpisodeCount) ?? 0,
      sizeOnDisk: bytes(st?.sizeOnDisk),
      nextAiring: isoOrNull(st?.nextAiring),
      previousAiring: isoOrNull(st?.previousAiring),
    });
  }
  return out.sort((a, b) => a.seasonNumber - b.seasonNumber);
}

/**
 * One /api/v3/movie/{id} or /api/v3/series/{id} resource → what the manager
 * shows, or null when it carries no usable id. `rootFolders` fills in the root
 * for an arr version that omits `rootFolderPath`.
 */
export function projectTitle(service: ArrService, instance: string, raw: unknown, rootFolders: readonly string[] = []): ArrTitle | null {
  const r = obj(raw);
  const arrId = posInt(r?.id);
  if (!r || arrId === null) return null;
  const path = textOrNull(r.path, 1_000);
  const stats = obj(r.statistics);
  const seasons = service === "sonarr" ? seasonsOf(r.seasons) : [];
  return {
    service,
    instance,
    arrId,
    title: text(r.title, 300),
    year: posInt(r.year),
    tmdbId: posInt(r.tmdbId),
    tvdbId: service === "sonarr" ? posInt(r.tvdbId) : null,
    imdbId: textOrNull(r.imdbId, 20),
    status: textOrNull(r.status, 40),
    monitored: bool(r.monitored),
    qualityProfileId: posInt(r.qualityProfileId),
    rootFolderPath: textOrNull(r.rootFolderPath, 1_000) ?? rootFolderFor(path, rootFolders),
    path,
    tags: idsOf(r.tags, 200),
    sizeOnDisk: bytes(r.sizeOnDisk ?? stats?.sizeOnDisk),
    added: isoOrNull(r.added),
    ...(service === "radarr" ? movieFields(r) : seriesFields(r, stats, seasons)),
    seasons,
  };
}

type ServiceFields = Omit<ArrTitle,
  "service" | "instance" | "arrId" | "title" | "year" | "tmdbId" | "tvdbId" | "imdbId" | "status" | "monitored"
  | "qualityProfileId" | "rootFolderPath" | "path" | "tags" | "sizeOnDisk" | "added" | "seasons">;

const boolOrNull = (v: unknown): boolean | null => (typeof v === "boolean" ? v : null);

// A movie's own fields; the series-only ones are null (and the counts 0).
function movieFields(r: Raw): ServiceFields {
  return {
    hasFile: bool(r.hasFile),
    minimumAvailability: textOrNull(r.minimumAvailability, 40),
    inCinemas: isoOrNull(r.inCinemas),
    physicalRelease: isoOrNull(r.physicalRelease),
    digitalRelease: isoOrNull(r.digitalRelease),
    isAvailable: boolOrNull(r.isAvailable),
    studio: textOrNull(r.studio, 200),
    seriesType: null,
    seasonFolder: null,
    monitorNewItems: null,
    network: null,
    episodeCount: 0,
    episodeFileCount: 0,
    nextAiring: null,
    previousAiring: null,
  };
}

// The earliest (or latest) of the regular seasons' dates, by ISO string order.
function seasonDate(regular: readonly TitleSeason[], pick: (s: TitleSeason) => string | null, wins: (a: string, b: string) => boolean): string | null {
  let best: string | null = null;
  for (const s of regular) {
    const v = pick(s);
    if (v && (best === null || wins(v, best))) best = v;
  }
  return best;
}

// A series' own fields; the movie-only ones are null. The counts are the
// regular seasons' (specials excluded, 14a), else the series statistics.
function seriesFields(r: Raw, stats: Raw | null, seasons: readonly TitleSeason[]): ServiceFields {
  const regular = seasons.filter((s) => s.seasonNumber > 0);
  const sum = (pick: (s: TitleSeason) => number) => regular.reduce((n, s) => n + pick(s), 0);
  // "Has a file" is ANY episode file, specials included: only the counts are
  // regular-season (14a), and availability reads sonarrSeriesCompletion, not this.
  const anyEpisodeFile = seasons.length > 0 ? seasons.some((s) => s.episodeFileCount > 0) : (nonNegInt(stats?.episodeFileCount) ?? 0) > 0;
  return {
    hasFile: anyEpisodeFile,
    minimumAvailability: null,
    inCinemas: null,
    physicalRelease: null,
    digitalRelease: null,
    isAvailable: null,
    studio: null,
    seriesType: textOrNull(r.seriesType, 40),
    seasonFolder: boolOrNull(r.seasonFolder),
    monitorNewItems: textOrNull(r.monitorNewItems, 40),
    network: textOrNull(r.network, 200),
    episodeCount: regular.length > 0 ? sum((s) => s.episodeCount) : nonNegInt(stats?.episodeCount) ?? 0,
    episodeFileCount: regular.length > 0 ? sum((s) => s.episodeFileCount) : nonNegInt(stats?.episodeFileCount) ?? 0,
    nextAiring: seasonDate(regular, (s) => s.nextAiring, (a, b) => a < b) ?? isoOrNull(r.nextAiring),
    previousAiring: seasonDate(regular, (s) => s.previousAiring, (a, b) => a > b) ?? isoOrNull(r.previousAiring),
  };
}

// ── the instance's choices ───────────────────────────────────────────────────

export interface Choice { id: number; name: string }
export interface RootFolderChoice { path: string; freeSpace: number | null; accessible: boolean }

// The catalog lists come from the arr, capped by arrFetch only by size (50 MB),
// and are projected synchronously on every title-manager read and edit (and its
// background snapshot refresh). So each dedupes through a Set, keeps at most its
// cap — far past any real instance's profiles, tags and root folders — and reads
// at most PROJECTION_SCAN_FACTOR times that, so junk or duplicates are bounded too.
export const MAX_CHOICES = 2_000;
export const MAX_ROOT_FOLDER_CHOICES = 500;
// arr-parse's, shared with every other arr projection (5i).
export { PROJECTION_SCAN_FACTOR };

export function projectChoices(raw: unknown, nameField: "name" | "label" = "name"): Choice[] {
  if (!Array.isArray(raw)) return [];
  const out: Choice[] = [];
  const seen = new Set<number>();
  for (const x of raw.slice(0, MAX_CHOICES * PROJECTION_SCAN_FACTOR)) {
    const r = obj(x);
    const id = posInt(r?.id);
    const name = textOrNull(r?.[nameField], 200);
    if (id === null || name === null || seen.has(id)) continue;
    seen.add(id);
    out.push({ id, name });
    if (out.length >= MAX_CHOICES) break;
  }
  return out;
}

export function projectRootFolderChoices(raw: unknown): RootFolderChoice[] {
  if (!Array.isArray(raw)) return [];
  const out: RootFolderChoice[] = [];
  const seen = new Set<string>();
  for (const x of raw.slice(0, MAX_ROOT_FOLDER_CHOICES * PROJECTION_SCAN_FACTOR)) {
    const r = obj(x);
    const path = textOrNull(r?.path, 1_000);
    if (!r || path === null || seen.has(path)) continue;
    seen.add(path);
    out.push({ path, freeSpace: bytesOrNull(r.freeSpace), accessible: r.accessible !== false });
    if (out.length >= MAX_ROOT_FOLDER_CHOICES) break;
  }
  return out;
}

// ── the edit ─────────────────────────────────────────────────────────────────

export interface SeasonMonitoring { seasonNumber: number; monitored: boolean }

export interface TitleEdit {
  monitored?: boolean;
  qualityProfileId?: number;
  /** One of the instance's root folders. Radarr/Sonarr re-home the title there. */
  rootFolderPath?: string;
  /** With a new root folder: move the files too (else only the path changes). */
  moveFiles?: boolean;
  /** Replaces the title's tags. */
  tags?: number[];
  // Radarr only.
  minimumAvailability?: MinimumAvailability;
  // Sonarr only.
  seriesType?: SeriesType;
  seasonFolder?: boolean;
  monitorNewItems?: MonitorNewItems;
  seasons?: SeasonMonitoring[];
}

const MAX_TAGS = 100;
const MAX_SEASONS = 1_000;

/**
 * The edit a request body asks for, or null when anything in it is malformed —
 * a wrong type, a value outside the arr's own vocabulary, or a field the other
 * service has. Fields left out are left alone.
 */
export function parseTitleEdit(service: ArrService, body: Record<string, unknown>): TitleEdit | null {
  const edit: TitleEdit = {};
  const has = (k: string) => body[k] !== undefined;
  if (has("monitored")) {
    if (typeof body.monitored !== "boolean") return null;
    edit.monitored = body.monitored;
  }
  if (has("qualityProfileId")) {
    const id = posInt(body.qualityProfileId);
    if (id === null) return null;
    edit.qualityProfileId = id;
  }
  if (has("rootFolderPath")) {
    if (typeof body.rootFolderPath !== "string" || body.rootFolderPath.trim() === "" || body.rootFolderPath.length > 1_000) return null;
    edit.rootFolderPath = body.rootFolderPath;
  }
  if (has("moveFiles")) {
    if (typeof body.moveFiles !== "boolean") return null;
    edit.moveFiles = body.moveFiles;
  }
  if (has("tags")) {
    const tags = parseTagIds(body.tags, MAX_TAGS);
    if (tags === null) return null;
    edit.tags = tags;
  }
  const radarrOnly = ["minimumAvailability"];
  const sonarrOnly = ["seriesType", "seasonFolder", "monitorNewItems", "seasons"];
  if ((service === "radarr" ? sonarrOnly : radarrOnly).some(has)) return null;
  if (has("minimumAvailability")) {
    if (!isOneOf(MINIMUM_AVAILABILITIES, body.minimumAvailability)) return null;
    edit.minimumAvailability = body.minimumAvailability;
  }
  if (has("seriesType")) {
    if (!isOneOf(SERIES_TYPES, body.seriesType)) return null;
    edit.seriesType = body.seriesType;
  }
  if (has("seasonFolder")) {
    if (typeof body.seasonFolder !== "boolean") return null;
    edit.seasonFolder = body.seasonFolder;
  }
  if (has("monitorNewItems")) {
    if (!isOneOf(MONITOR_NEW_ITEMS, body.monitorNewItems)) return null;
    edit.monitorNewItems = body.monitorNewItems;
  }
  if (has("seasons")) {
    const seasons = parseSeasonMonitoring(body.seasons);
    if (seasons === null) return null;
    edit.seasons = seasons;
    // Season monitoring is its own write (a read-modify-write of the series)
    // after the editor's; combined, a failure between the two would leave an
    // edit half applied and unaudited. The manager never sends them together,
    // and editTitle relies on it (a season edit never has an editor body).
    if ((Object.keys(edit) as Array<keyof TitleEdit>).some((k) => k !== "seasons")) return null;
  }
  return edit;
}

// The seasons to (un)monitor: a non-empty list of distinct season numbers.
function parseSeasonMonitoring(v: unknown): SeasonMonitoring[] | null {
  if (!Array.isArray(v) || v.length === 0 || v.length > MAX_SEASONS) return null;
  const seen = new Set<number>();
  const seasons: SeasonMonitoring[] = [];
  for (const s of v) {
    const r = obj(s);
    const n = nonNegInt(r?.seasonNumber);
    if (!r || n === null || typeof r.monitored !== "boolean" || seen.has(n)) return null;
    seen.add(n);
    seasons.push({ seasonNumber: n, monitored: r.monitored });
  }
  return seasons;
}

/** The fields an edit sets, for the audit row and "nothing to change". */
export function editedFields(edit: TitleEdit): string[] {
  return (Object.keys(edit) as Array<keyof TitleEdit>).filter((k) => k !== "moveFiles" && edit[k] !== undefined);
}

export interface TitleEditCatalog {
  profileIds: ReadonlySet<number>;
  rootFolders: ReadonlySet<string>;
  tagIds: ReadonlySet<number>;
  seasonNumbers: ReadonlySet<number>;
}

export type TitleEditField = "qualityProfile" | "rootFolder" | "tags" | "season";

/** The edit named something the instance does not have. */
export class TitleEditError extends Error {
  readonly field: TitleEditField;
  constructor(field: TitleEditField) {
    super(`unknown ${field}`);
    this.field = field;
  }
}

/** Throws TitleEditError for a profile, root folder, tag or season the instance's own lists don't hold. */
export function checkTitleEdit(edit: TitleEdit, catalog: TitleEditCatalog): void {
  if (edit.qualityProfileId !== undefined && !catalog.profileIds.has(edit.qualityProfileId)) throw new TitleEditError("qualityProfile");
  if (edit.rootFolderPath !== undefined && !catalog.rootFolders.has(edit.rootFolderPath)) throw new TitleEditError("rootFolder");
  if (edit.tags?.some((t) => !catalog.tagIds.has(t))) throw new TitleEditError("tags");
  if (edit.seasons?.some((s) => !catalog.seasonNumbers.has(s.seasonNumber))) throw new TitleEditError("season");
}

/**
 * Whether an edit moves the title to another root folder. "/tv" and "/tv/"
 * name one folder, as do a Windows "C:\TV" and "c:/tv" (arr-path): a trailing
 * separator must not queue a pointless move — nor be audited as one.
 * editorBody and the edit's audited fields both ask this.
 */
export function rootFolderMoving(edit: Pick<TitleEdit, "rootFolderPath">, current: Pick<ArrTitle, "rootFolderPath">): boolean {
  return edit.rootFolderPath !== undefined && comparablePath(edit.rootFolderPath) !== comparablePath(current.rootFolderPath ?? "");
}

/**
 * The body for Radarr's PUT /api/v3/movie/editor or Sonarr's PUT
 * /api/v3/series/editor for one title, or null when the edit changes nothing
 * the editor handles (season monitoring is a separate write). The editor sets
 * only the fields it is sent, so the rest of the title — and anything changed
 * in the arr meanwhile — is left alone. A root folder equal to the current one
 * is not sent (it would queue a pointless move), and tags always REPLACE.
 */
export function editorBody(service: ArrService, arrId: number, edit: TitleEdit, current: Pick<ArrTitle, "rootFolderPath">): Record<string, unknown> | null {
  const body: Record<string, unknown> = service === "radarr" ? { movieIds: [arrId] } : { seriesIds: [arrId] };
  let changes = 0;
  const set = (k: string, v: unknown) => {
    if (v === undefined) return;
    body[k] = v;
    changes++;
  };
  set("monitored", edit.monitored);
  set("qualityProfileId", edit.qualityProfileId);
  if (service === "radarr") {
    set("minimumAvailability", edit.minimumAvailability);
  } else {
    set("seriesType", edit.seriesType);
    set("seasonFolder", edit.seasonFolder);
    set("monitorNewItems", edit.monitorNewItems);
  }
  const moving = rootFolderMoving(edit, current);
  if (moving) set("rootFolderPath", edit.rootFolderPath);
  body.moveFiles = moving && edit.moveFiles === true;
  if (edit.tags !== undefined) {
    set("tags", edit.tags);
    body.applyTags = "replace";
  }
  return changes > 0 ? body : null;
}

/**
 * The series resource Sonarr sent, with only the named seasons' `monitored`
 * changed — PUT back to /api/v3/series/{id}, which is how Sonarr's own UI
 * flips a season (Sonarr then sets that season's episodes to match).
 */
export function withSeasonMonitoring(rawSeries: unknown, seasons: readonly SeasonMonitoring[]): Raw {
  const r = obj(rawSeries);
  if (!r || !Array.isArray(r.seasons)) throw new TitleEditError("season");
  const wanted = new Map(seasons.map((s) => [s.seasonNumber, s.monitored]));
  const found = new Set<number>();
  const next = (r.seasons as unknown[]).map((s) => {
    const season = obj(s);
    const n = nonNegInt(season?.seasonNumber);
    if (!season || n === null || !wanted.has(n)) return s;
    found.add(n);
    return { ...season, monitored: wanted.get(n) };
  });
  if (found.size !== wanted.size) throw new TitleEditError("season");
  return { ...r, seasons: next };
}

// ── episodes ─────────────────────────────────────────────────────────────────

export interface TitleEpisode {
  id: number;
  seasonNumber: number;
  episodeNumber: number;
  absoluteEpisodeNumber: number | null;
  title: string;
  airDateUtc: string | null;
  monitored: boolean;
  hasFile: boolean;
  episodeFileId: number | null;
  /** "series"/"season"/"midseason" when Sonarr knows this episode ends one. */
  finaleType: string | null;
}

export function projectEpisodes(raw: unknown): TitleEpisode[] {
  if (!Array.isArray(raw)) return [];
  const out: TitleEpisode[] = [];
  for (const x of raw) {
    const e = obj(x);
    const id = posInt(e?.id);
    const season = nonNegInt(e?.seasonNumber);
    const number = nonNegInt(e?.episodeNumber);
    if (!e || id === null || season === null || number === null) continue;
    out.push({
      id,
      seasonNumber: season,
      episodeNumber: number,
      absoluteEpisodeNumber: posInt(e.absoluteEpisodeNumber),
      title: text(e.title, 300),
      airDateUtc: isoOrNull(e.airDateUtc),
      monitored: bool(e.monitored),
      hasFile: bool(e.hasFile),
      episodeFileId: posInt(e.episodeFileId),
      finaleType: textOrNull(e.finaleType, 20),
    });
  }
  return out.sort((a, b) => a.seasonNumber - b.seasonNumber || a.episodeNumber - b.episodeNumber);
}

// ── files ────────────────────────────────────────────────────────────────────

export interface TitleFileMedia {
  videoCodec: string | null;
  videoDynamicRange: string | null;
  videoBitDepth: number | null;
  videoBitrate: number | null;
  videoFps: number | null;
  resolution: string | null;
  scanType: string | null;
  audioCodec: string | null;
  audioChannels: number | null;
  audioBitrate: number | null;
  audioLanguages: string | null;
  audioStreamCount: number | null;
  subtitles: string | null;
  runTime: string | null;
}

export interface TitleFile {
  id: number;
  /** Relative to the title's folder. */
  relativePath: string;
  /** Where the file is, as the arr sees it — ADMIN-only, like the queue's output path. */
  path: string | null;
  size: number;
  dateAdded: string | null;
  quality: string | null;
  qualityTags: QualityTag[];
  languages: string[];
  customFormats: string[];
  customFormatScore: number | null;
  qualityCutoffNotMet: boolean;
  releaseGroup: string | null;
  sceneName: string | null;
  /** Radarr only. */
  edition: string | null;
  /** Sonarr only: the season the file belongs to, and the episodes it holds (filled from the episode list). */
  seasonNumber: number | null;
  episodes: Array<{ seasonNumber: number; episodeNumber: number }>;
  media: TitleFileMedia | null;
}

const num = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) && v >= 0 ? v : null);

function mediaOf(v: unknown): TitleFileMedia | null {
  const m = obj(v);
  if (!m) return null;
  return {
    videoCodec: textOrNull(m.videoCodec, 40),
    videoDynamicRange: textOrNull(m.videoDynamicRangeType, 40) ?? textOrNull(m.videoDynamicRange, 40),
    videoBitDepth: posInt(m.videoBitDepth),
    videoBitrate: num(m.videoBitrate),
    videoFps: num(m.videoFps),
    resolution: textOrNull(m.resolution, 20),
    scanType: textOrNull(m.scanType, 20),
    audioCodec: textOrNull(m.audioCodec, 40),
    audioChannels: num(m.audioChannels),
    audioBitrate: num(m.audioBitrate),
    audioLanguages: textOrNull(m.audioLanguages, 200),
    audioStreamCount: posInt(m.audioStreamCount),
    subtitles: textOrNull(m.subtitles, 300),
    runTime: textOrNull(m.runTime, 20),
  };
}

/**
 * /api/v3/moviefile?movieId= or /api/v3/episodefile?seriesId= rows → the
 * files tab. For a series, `episodes` (the series' episode list) says which
 * episodes each file holds; files are ordered by season then first episode.
 */
export function projectFiles(service: ArrService, raw: unknown, episodes: readonly TitleEpisode[] = []): TitleFile[] {
  if (!Array.isArray(raw)) return [];
  const byFile = new Map<number, Array<{ seasonNumber: number; episodeNumber: number }>>();
  for (const e of episodes) {
    if (e.episodeFileId === null) continue;
    const list = byFile.get(e.episodeFileId) ?? [];
    list.push({ seasonNumber: e.seasonNumber, episodeNumber: e.episodeNumber });
    byFile.set(e.episodeFileId, list);
  }
  const out: TitleFile[] = [];
  for (const x of raw) {
    const f = obj(x);
    const id = posInt(f?.id);
    if (!f || id === null) continue;
    const { quality, qualityTags } = qualityOf(f.quality);
    out.push({
      id,
      relativePath: text(f.relativePath, 1_000),
      path: textOrNull(f.path, 1_000),
      size: bytes(f.size),
      dateAdded: isoOrNull(f.dateAdded),
      quality,
      qualityTags,
      // Sonarr v3's EpisodeFileResource carries ONE `language`, no list.
      languages: languageNamesOf(f),
      customFormats: namesOf(f.customFormats),
      customFormatScore: int(f.customFormatScore),
      qualityCutoffNotMet: bool(f.qualityCutoffNotMet),
      releaseGroup: textOrNull(f.releaseGroup, 100),
      sceneName: textOrNull(f.sceneName, 500),
      edition: service === "radarr" ? textOrNull(f.edition, 100) : null,
      seasonNumber: service === "sonarr" ? nonNegInt(f.seasonNumber) : null,
      episodes: service === "sonarr" ? (byFile.get(id) ?? []).sort((a, b) => a.seasonNumber - b.seasonNumber || a.episodeNumber - b.episodeNumber) : [],
      media: mediaOf(f.mediaInfo),
    });
  }
  const firstEp = (f: TitleFile) => f.episodes[0]?.episodeNumber ?? 0;
  return out.sort((a, b) => (a.seasonNumber ?? 0) - (b.seasonNumber ?? 0) || firstEp(a) - firstEp(b) || a.relativePath.localeCompare(b.relativePath));
}

// ── file ids from the browser ────────────────────────────────────────────────

/**
 * The most file ids one delete or one rename takes — the Files tab's "select
 * all" on a long daily show or anime. Delete and rename share it: RenameFiles
 * takes the whole list in one command body, and a preview the page pre-ticks
 * must never be refused for its length alone.
 */
export const MAX_TITLE_FILE_IDS = 10_000;
/** Their JSON body cap (guardrail 30): 10k ids of up to 7 digits is ~80 KB. */
export const TITLE_FILE_IDS_BODY_BYTES = 256 * 1024;

// ── renames ──────────────────────────────────────────────────────────────────

export interface RenamePreview {
  fileId: number;
  existingPath: string;
  newPath: string;
  /** Sonarr only. */
  seasonNumber: number | null;
  episodeNumbers: number[];
}

/** /api/v3/rename → the files whose name the arr's naming scheme would change, and to what. */
export function projectRenames(service: ArrService, raw: unknown): RenamePreview[] {
  if (!Array.isArray(raw)) return [];
  const out: RenamePreview[] = [];
  const seen = new Set<number>();
  for (const x of raw) {
    const r = obj(x);
    const fileId = posInt(service === "radarr" ? r?.movieFileId : r?.episodeFileId);
    if (!r || fileId === null || seen.has(fileId)) continue;
    seen.add(fileId);
    out.push({
      fileId,
      existingPath: text(r.existingPath, 1_000),
      newPath: text(r.newPath, 1_000),
      seasonNumber: service === "sonarr" ? nonNegInt(r.seasonNumber) : null,
      episodeNumbers: service === "sonarr" && Array.isArray(r.episodeNumbers)
        ? (r.episodeNumbers as unknown[]).map(nonNegInt).filter((n): n is number => n !== null).slice(0, 200)
        : [],
    });
  }
  return out;
}

// ── the title's commands ─────────────────────────────────────────────────────

/**
 * What the manager's buttons can ask for. Radarr: `search` (the arr's own
 * MoviesSearch — upgrades included, it is the movie's Search button) and
 * `refresh`. Sonarr: `refresh`, `searchMissing` (exactly what is missing —
 * the Missing page's plan, never SeriesSearch), `searchSeason` and
 * `searchEpisodes`.
 */
export type TitleCommand = "search" | "refresh" | "searchMissing" | "searchSeason" | "searchEpisodes";
const COMMANDS: Record<ArrService, readonly TitleCommand[]> = {
  radarr: ["search", "refresh"],
  sonarr: ["refresh", "searchMissing", "searchSeason", "searchEpisodes"],
};

export function parseTitleCommand(service: ArrService, v: unknown): TitleCommand | null {
  return typeof v === "string" && (COMMANDS[service] as readonly string[]).includes(v) ? (v as TitleCommand) : null;
}
