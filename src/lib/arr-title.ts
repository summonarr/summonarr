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
  namesOf,
  nonNegInt,
  posInt,
  qualityOf,
  text,
  textOrNull,
  type QualityTag,
} from "./arr-parse";
import type { ArrService } from "./arr-instances";

export type { ArrService };

export const MINIMUM_AVAILABILITIES = ["announced", "inCinemas", "released"] as const;
export type MinimumAvailability = (typeof MINIMUM_AVAILABILITIES)[number];
export const SERIES_TYPES = ["standard", "daily", "anime"] as const;
export type SeriesType = (typeof SERIES_TYPES)[number];
export const MONITOR_NEW_ITEMS = ["all", "none"] as const;
export type MonitorNewItems = (typeof MONITOR_NEW_ITEMS)[number];

const isOneOf = <T extends string>(list: readonly T[], v: unknown): v is T => typeof v === "string" && (list as readonly string[]).includes(v);

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

/** The root folder a path sits under, from the instance's own list — for an arr that omits rootFolderPath. */
export function rootFolderFor(path: string | null, rootFolders: readonly string[]): string | null {
  if (!path) return null;
  let best: string | null = null;
  for (const root of rootFolders) {
    const prefix = root.replace(/[\\/]+$/, "");
    if (prefix === "") continue;
    const under = path === prefix || path.startsWith(`${prefix}/`) || path.startsWith(`${prefix}\\`);
    if (under && (best === null || prefix.length > best.replace(/[\\/]+$/, "").length)) best = root;
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
  const regular = seasons.filter((s) => s.seasonNumber > 0);
  const sum = (pick: (s: TitleSeason) => number) => regular.reduce((n, s) => n + pick(s), 0);
  const episodeFileCount = service === "sonarr" ? (regular.length > 0 ? sum((s) => s.episodeFileCount) : nonNegInt(stats?.episodeFileCount) ?? 0) : 0;
  const latest = (pick: (s: TitleSeason) => string | null, cmp: (a: string, b: string) => boolean) => {
    let best: string | null = null;
    for (const s of regular) {
      const v = pick(s);
      if (v && (best === null || cmp(v, best))) best = v;
    }
    return best;
  };
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
    hasFile: service === "radarr" ? bool(r.hasFile) : episodeFileCount > 0,
    minimumAvailability: service === "radarr" ? textOrNull(r.minimumAvailability, 40) : null,
    inCinemas: service === "radarr" ? isoOrNull(r.inCinemas) : null,
    physicalRelease: service === "radarr" ? isoOrNull(r.physicalRelease) : null,
    digitalRelease: service === "radarr" ? isoOrNull(r.digitalRelease) : null,
    isAvailable: service === "radarr" ? (typeof r.isAvailable === "boolean" ? r.isAvailable : null) : null,
    studio: service === "radarr" ? textOrNull(r.studio, 200) : null,
    seriesType: service === "sonarr" ? textOrNull(r.seriesType, 40) : null,
    seasonFolder: service === "sonarr" ? (typeof r.seasonFolder === "boolean" ? r.seasonFolder : null) : null,
    monitorNewItems: service === "sonarr" ? textOrNull(r.monitorNewItems, 40) : null,
    network: service === "sonarr" ? textOrNull(r.network, 200) : null,
    episodeCount: service === "sonarr" ? (regular.length > 0 ? sum((s) => s.episodeCount) : nonNegInt(stats?.episodeCount) ?? 0) : 0,
    episodeFileCount,
    nextAiring: service === "sonarr" ? latest((s) => s.nextAiring, (a, b) => a < b) ?? isoOrNull(r.nextAiring) : null,
    previousAiring: service === "sonarr" ? latest((s) => s.previousAiring, (a, b) => a > b) ?? isoOrNull(r.previousAiring) : null,
    seasons,
  };
}

// ── the instance's choices ───────────────────────────────────────────────────

export interface Choice { id: number; name: string }
export interface RootFolderChoice { path: string; freeSpace: number | null; accessible: boolean }

export function projectChoices(raw: unknown, nameField: "name" | "label" = "name"): Choice[] {
  if (!Array.isArray(raw)) return [];
  const out: Choice[] = [];
  for (const x of raw) {
    const r = obj(x);
    const id = posInt(r?.id);
    const name = textOrNull(r?.[nameField], 200);
    if (id !== null && name !== null && !out.some((c) => c.id === id)) out.push({ id, name });
  }
  return out;
}

export function projectRootFolderChoices(raw: unknown): RootFolderChoice[] {
  if (!Array.isArray(raw)) return [];
  const out: RootFolderChoice[] = [];
  for (const x of raw) {
    const r = obj(x);
    const path = textOrNull(r?.path, 1_000);
    if (!r || path === null || out.some((f) => f.path === path)) continue;
    out.push({ path, freeSpace: bytesOrNull(r.freeSpace), accessible: r.accessible !== false });
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
    if (!Array.isArray(body.tags) || body.tags.length > MAX_TAGS || !body.tags.every((t) => posInt(t) !== null)) return null;
    edit.tags = [...new Set(body.tags as number[])];
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
    if (!Array.isArray(body.seasons) || body.seasons.length === 0 || body.seasons.length > MAX_SEASONS) return null;
    const seen = new Set<number>();
    const seasons: SeasonMonitoring[] = [];
    for (const s of body.seasons) {
      const r = obj(s);
      const n = nonNegInt(r?.seasonNumber);
      if (!r || n === null || typeof r.monitored !== "boolean" || seen.has(n)) return null;
      seen.add(n);
      seasons.push({ seasonNumber: n, monitored: r.monitored });
    }
    edit.seasons = seasons;
  }
  return edit;
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
  const moving = edit.rootFolderPath !== undefined && edit.rootFolderPath !== current.rootFolderPath;
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
      languages: namesOf(f.languages),
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
  for (const x of raw) {
    const r = obj(x);
    const fileId = posInt(service === "radarr" ? r?.movieFileId : r?.episodeFileId);
    if (!r || fileId === null || out.some((p) => p.fileId === fileId)) continue;
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
