// Admin → Download Queue, importing a blocked download: the pure rules.
// What /api/v3/manualimport reports for a download, the admin's per-file
// corrections checked against the instance's own catalogs, and the
// ManualImport command / reprocess payloads built from the arr's own rows
// (guardrail 5d). No I/O; the data half is arr-queue-data.ts. Re-exported by
// arr-queue.ts. Its only runtime imports are the zero-import arr-parse
// readers and arr-queue-types.
import { QUEUE_IMPORT_MAX_FILES } from "./api-body-limits";
import { bytes, nonNegInt, posInt, PROJECTION_SCAN_FACTOR, safeMessage, text, textOrNull } from "./arr-parse";
import { MAX_MESSAGE_LEN, MAX_MESSAGES, type QueueEpisode, type QueueService } from "./arr-queue-types";

// ── importing a blocked download ("Manual Import") ─────────────────────────
//
// A download Radarr/Sonarr refused to import on their own (import blocked:
// sample, not an upgrade, unexpected episode, …) can be imported anyway — the
// arr UI's Manual Import. /api/v3/manualimport?downloadId= lists the files the
// arr found in that download with what it matched each to and why it refused;
// the ManualImport command imports the chosen ones regardless of those
// rejections (that is the point: the admin is overriding them).
//
// SECURITY: the command's file list is built ONLY from the arr's own
// manualimport response, re-read when the admin confirms — a path coming from
// the browser just SELECTS among those files and is never sent upstream itself
// (guardrail 5d).

export type ImportMode = "auto" | "move" | "copy";

export function isImportMode(v: unknown): v is ImportMode {
  return v === "auto" || v === "move" || v === "copy";
}

export interface ImportCandidate {
  /** The file's path as Radarr/Sonarr reported it — the key the browser selects by. */
  path: string;
  /** What to show: the path relative to the download folder, else the file name. */
  name: string;
  size: number;
  quality: string | null;
  languages: string[];
  releaseGroup: string | null;
  /** The movie/series the arr matched the file to; null = not matched (match it in the dialog first). */
  target: string | null;
  episodes: QueueEpisode[];
  /** Why the arr would not import it on its own. */
  rejections: string[];
  importable: boolean;
  /** The current values, for the dialog's per-file editor to start from. */
  movieId: number | null;
  seriesId: number | null;
  episodeIds: number[];
  qualityId: number | null;
  languageIds: number[];
  releaseType: string | null;
}

export type ManualImportRow = {
  path?: unknown;
  relativePath?: unknown;
  name?: unknown;
  folderName?: unknown;
  size?: unknown;
  quality?: unknown;
  languages?: unknown;
  /** Sonarr v3's shape: ONE language object, no `languages` array. */
  language?: unknown;
  releaseGroup?: unknown;
  indexerFlags?: unknown;
  releaseType?: unknown;
  downloadId?: unknown;
  movie?: { id?: unknown; title?: unknown; year?: unknown } | null;
  series?: { id?: unknown; title?: unknown } | null;
  episodes?: unknown;
  rejections?: unknown;
};

const MAX_PATH = 4_096;

function rowEpisodes(row: ManualImportRow): Array<QueueEpisode & { id: number | null }> {
  if (!Array.isArray(row.episodes)) return [];
  const out: Array<QueueEpisode & { id: number | null }> = [];
  for (const e of row.episodes as Array<{ id?: unknown; seasonNumber?: unknown; episodeNumber?: unknown } | null>) {
    const s = nonNegInt(e?.seasonNumber);
    const n = nonNegInt(e?.episodeNumber);
    if (s !== null && n !== null) out.push({ seasonNumber: s, episodeNumber: n, id: posInt(e?.id) });
  }
  return out.sort((a, b) => a.seasonNumber - b.seasonNumber || a.episodeNumber - b.episodeNumber);
}

/**
 * Whether the arr matched the file far enough for the ManualImport command to
 * accept it. `eps` is the row's rowEpisodes when the caller already parsed
 * them (Sonarr), so a row's episode list is parsed and sorted once.
 */
function isMapped(service: QueueService, row: ManualImportRow, eps: ReadonlyArray<{ id: number | null }> = service === "sonarr" ? rowEpisodes(row) : []): boolean {
  if (service === "radarr") return posInt(row.movie?.id) !== null;
  return posInt(row.series?.id) !== null && eps.length > 0 && eps.every((e) => e.id !== null);
}

// Sonarr v3's manualimport rows carry ONE `language` object and no
// `languages` array (v4 and Radarr carry the array). v3's ManualImportFile
// reads only `language`, and a command without it stores the file as
// Language Unknown, so the singular object is carried back as the arr gave it.
function singleLanguage(row: ManualImportRow): Record<string, unknown> | null {
  if (Array.isArray(row.languages)) return null;
  const l = row.language;
  return l && typeof l === "object" && !Array.isArray(l) ? (l as Record<string, unknown>) : null;
}

/** The language field(s) a command/reprocess item carries back: the arr's own, in its own shape. */
function languageFields(row: ManualImportRow): { languages: unknown[] } | { language: Record<string, unknown> } {
  if (Array.isArray(row.languages)) return { languages: row.languages };
  const single = singleLanguage(row);
  return single ? { language: single } : { languages: [] };
}

function validPath(v: unknown): string | null {
  return typeof v === "string" && v.length > 0 && v.length <= MAX_PATH ? v : null;
}

// What the arr matched the file to, as the dialog names it; null = not matched.
function importTargetLabel(service: QueueService, r: ManualImportRow): string | null {
  if (service === "radarr" && r.movie && typeof r.movie.title === "string" && r.movie.title) {
    const year = posInt(r.movie.year);
    return year ? `${r.movie.title} (${year})` : r.movie.title;
  }
  if (service === "sonarr" && r.series && typeof r.series.title === "string" && r.series.title) return r.series.title;
  return null;
}

// The row's language names to show, and the ids the editor may correct. A v3
// row's one language is shown; its id is not offered for correction (v3 has no
// /api/v3/language catalog to correct it against).
function importLanguages(r: ManualImportRow): { languages: string[]; languageIds: number[] } {
  const single = singleLanguage(r);
  const languageList = Array.isArray(r.languages) ? r.languages : single ? [single] : [];
  const languages = (languageList as Array<{ name?: unknown } | null>)
    .map((l) => (typeof l?.name === "string" ? l.name : ""))
    .filter(Boolean)
    .slice(0, 10);
  const languageIds = Array.isArray(r.languages)
    ? (r.languages as Array<{ id?: unknown } | null>)
        .map((l) => (typeof l?.id === "number" && Number.isSafeInteger(l.id) ? l.id : null))
        .filter((id): id is number => id !== null)
    : [];
  return { languages, languageIds };
}

// Why the arr would not import it on its own: masked (guardrail 5e), bounded.
function importRejections(r: ManualImportRow): string[] {
  if (!Array.isArray(r.rejections)) return [];
  return (r.rejections as Array<{ reason?: unknown } | null>)
    .map((x) => safeMessage(x?.reason, MAX_MESSAGE_LEN) ?? "")
    .filter(Boolean)
    .slice(0, MAX_MESSAGES);
}

function importQuality(r: ManualImportRow): { quality: string | null; qualityId: number | null } {
  const q = r.quality && typeof r.quality === "object" ? (r.quality as { quality?: { name?: unknown; id?: unknown } }).quality : undefined;
  return {
    quality: typeof q?.name === "string" && q.name ? q.name.slice(0, 100) : null,
    qualityId: typeof q?.id === "number" && Number.isSafeInteger(q.id) ? q.id : null,
  };
}

/**
 * /api/v3/manualimport → what the import dialog shows. Rows without a path are
 * dropped; at most the files one import may name are kept, from a bounded scan.
 */
export function importCandidates(service: QueueService, raw: unknown): ImportCandidate[] {
  if (!Array.isArray(raw)) return [];
  const out: ImportCandidate[] = [];
  const scanned = Math.min(raw.length, QUEUE_IMPORT_MAX_FILES * PROJECTION_SCAN_FACTOR);
  for (let i = 0; i < scanned && out.length < QUEUE_IMPORT_MAX_FILES; i++) {
    const r = raw[i] as ManualImportRow;
    if (!r || typeof r !== "object") continue;
    const path = validPath(r.path);
    if (path === null) continue;
    const eps = service === "sonarr" ? rowEpisodes(r) : [];
    out.push({
      path,
      name: text(r.relativePath) || text(r.name) || path.slice(-200),
      size: bytes(r.size),
      ...importQuality(r),
      ...importLanguages(r),
      releaseGroup: textOrNull(r.releaseGroup, 100),
      target: importTargetLabel(service, r),
      episodes: eps.map(({ seasonNumber, episodeNumber }) => ({ seasonNumber, episodeNumber })),
      rejections: importRejections(r),
      importable: isMapped(service, r, eps),
      movieId: service === "radarr" ? posInt(r.movie?.id) : null,
      seriesId: service === "sonarr" ? posInt(r.series?.id) : null,
      episodeIds: eps.map((e) => e.id).filter((id): id is number => id !== null),
      releaseType: service === "sonarr" && typeof r.releaseType === "string" ? r.releaseType : null,
    });
  }
  return out.sort((a, b) => a.name.localeCompare(b.name));
}

// ── per-file corrections ─────────────────────────────────────────────────────
//
// What the arr UI's Manual Import lets an admin change on a file before
// importing it: the movie (Radarr) or the series and episodes (Sonarr), the
// quality, the languages, the release group and (Sonarr) the release type.
// Every value is validated against the instance's OWN catalogs (its quality
// definitions, its languages, the movie/series/episodes it has) before it is
// written into the command — the browser names ids, the server supplies the
// objects (guardrail 5d).

export const SONARR_RELEASE_TYPES = ["unknown", "singleEpisode", "multiEpisode", "seasonPack"] as const;
export type SonarrReleaseType = (typeof SONARR_RELEASE_TYPES)[number];

export interface ImportOverride {
  movieId?: number;
  seriesId?: number;
  episodeIds?: number[];
  qualityId?: number;
  languageIds?: number[];
  releaseGroup?: string;
  releaseType?: SonarrReleaseType;
}

export interface ImportCatalog {
  /** Quality id → the quality object from the instance's quality definitions. */
  qualities: ReadonlyMap<number, unknown>;
  languages: ReadonlyMap<number, { id: number; name: string }>;
  movies: ReadonlyMap<number, { id: number; title: string; year: number | null }>;
  series: ReadonlyMap<number, { id: number; title: string; episodes: ReadonlyMap<number, QueueEpisode> }>;
}

export const EMPTY_IMPORT_CATALOG: ImportCatalog = { qualities: new Map(), languages: new Map(), movies: new Map(), series: new Map() };

export const MAX_OVERRIDE_EPISODES = 500;
const MAX_RELEASE_GROUP = 100;

/**
 * A correction the arr's own catalogs don't back (unknown movie, episode of
 * another series, …), or — `tooManyTitles` — more titles re-matched than the
 * catalog read takes (MAX_CATALOG_TITLES, arr-queue-data.ts).
 */
export class ImportOverrideError extends Error {
  readonly field: "movie" | "series" | "episodes" | "quality" | "languages" | "tooManyTitles";
  constructor(field: ImportOverrideError["field"]) {
    super(`invalid ${field}`);
    this.field = field;
  }
}

/** The arr row's quality revision, in its full shape; a row with none is a first release (v1). */
function revisionOf(quality: unknown): { version: number; real: number; isRepack: boolean } {
  const q = quality && typeof quality === "object" ? (quality as { revision?: unknown }).revision : null;
  const r = q && typeof q === "object" ? (q as { version?: unknown; real?: unknown; isRepack?: unknown }) : null;
  return { version: posInt(r?.version) ?? 1, real: nonNegInt(r?.real) ?? 0, isRepack: r?.isRepack === true };
}

const intList = (v: unknown, max: number, min: number): number[] | null =>
  Array.isArray(v) && v.length <= max && v.every((x) => typeof x === "number" && Number.isSafeInteger(x) && x >= min)
    ? [...new Set(v as number[])]
    : null;

/**
 * One selected file from a request body: `{ path, …corrections }`. Shape only
 * — whether the ids exist is the catalog's job. null when malformed.
 */
export function parseImportSelection(service: QueueService, raw: unknown): { path: string; override: ImportOverride } | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const r = raw as Record<string, unknown>;
  const path = validPath(r.path);
  if (path === null) return null;
  const override: ImportOverride = {};
  if (r.movieId !== undefined) {
    if (service !== "radarr" || posInt(r.movieId) === null) return null;
    override.movieId = r.movieId as number;
  }
  if (r.seriesId !== undefined) {
    if (service !== "sonarr" || posInt(r.seriesId) === null) return null;
    override.seriesId = r.seriesId as number;
  }
  if (r.episodeIds !== undefined) {
    const ids = intList(r.episodeIds, MAX_OVERRIDE_EPISODES, 1);
    if (service !== "sonarr" || !ids || ids.length === 0) return null;
    override.episodeIds = ids;
  }
  // A new series without its episodes would import against the old ones.
  if (override.seriesId !== undefined && override.episodeIds === undefined) return null;
  if (r.qualityId !== undefined) {
    if (typeof r.qualityId !== "number" || !Number.isSafeInteger(r.qualityId) || r.qualityId < 0) return null;
    override.qualityId = r.qualityId;
  }
  if (r.languageIds !== undefined) {
    // Radarr's "Original" language is -2; anything the catalog lacks is refused there.
    const ids = intList(r.languageIds, 50, -2);
    if (!ids) return null;
    override.languageIds = ids;
  }
  if (r.releaseGroup !== undefined) {
    if (typeof r.releaseGroup !== "string" || r.releaseGroup.length > MAX_RELEASE_GROUP) return null;
    override.releaseGroup = r.releaseGroup.replace(/[\u0000-\u001f\u007f]+/g, "").trim();
  }
  if (r.releaseType !== undefined) {
    if (service !== "sonarr" || !(SONARR_RELEASE_TYPES as readonly unknown[]).includes(r.releaseType)) return null;
    override.releaseType = r.releaseType as SonarrReleaseType;
  }
  return { path, override };
}

/** The ids a set of corrections needs looked up, so the data layer can load exactly that catalog. */
export function overrideNeeds(rows: ReadonlyArray<{ row: unknown; override: ImportOverride }>): {
  movieIds: number[];
  seriesIds: number[];
  qualities: boolean;
  languages: boolean;
} {
  const movieIds = new Set<number>();
  const seriesIds = new Set<number>();
  let qualities = false;
  let languages = false;
  for (const { row, override } of rows) {
    if (override.movieId !== undefined) movieIds.add(override.movieId);
    if (override.episodeIds !== undefined) {
      const sid = override.seriesId ?? posInt((row as ManualImportRow | null)?.series?.id);
      if (sid !== null && sid !== undefined) seriesIds.add(sid);
    }
    if (override.qualityId !== undefined) qualities = true;
    if (override.languageIds !== undefined) languages = true;
  }
  return { movieIds: [...movieIds], seriesIds: [...seriesIds], qualities, languages };
}

/**
 * The arr's row with the admin's corrections written in — every object taken
 * from the catalog, never from the request. Throws ImportOverrideError for an
 * id the instance doesn't have.
 */
export function applyImportOverride(service: QueueService, row: ManualImportRow, override: ImportOverride, catalog: ImportCatalog): ManualImportRow {
  const out: ManualImportRow = { ...row };
  if (service === "radarr" && override.movieId !== undefined) out.movie = catalogMovie(catalog, override.movieId);
  if (service === "sonarr" && override.episodeIds !== undefined) {
    const { series, episodes } = catalogEpisodes(catalog, override.seriesId ?? posInt(row.series?.id), override.episodeIds);
    out.series = series;
    out.episodes = episodes;
  }
  if (override.qualityId !== undefined) {
    const quality = catalog.qualities.get(override.qualityId);
    if (quality === undefined) throw new ImportOverrideError("quality");
    // The file's own revision stays, as in the arr's quality picker: a PROPER
    // or REPACK relabelled as a plain v1 would have the arr grab the same
    // release again as an "upgrade". Rebuilt from the arr row's numbers.
    out.quality = { quality, revision: revisionOf(row.quality) };
  }
  if (override.languageIds !== undefined) out.languages = catalogLanguages(catalog, row, override.languageIds);
  if (override.releaseGroup !== undefined) out.releaseGroup = override.releaseGroup;
  if (service === "sonarr" && override.releaseType !== undefined) out.releaseType = override.releaseType;
  return out;
}

function catalogMovie(catalog: ImportCatalog, movieId: number): NonNullable<ManualImportRow["movie"]> {
  const movie = catalog.movies.get(movieId);
  if (!movie) throw new ImportOverrideError("movie");
  return { id: movie.id, title: movie.title, year: movie.year };
}

// The series the episodes belong to (the corrected one, else the arr's), and
// each episode as the instance itself numbers it.
function catalogEpisodes(
  catalog: ImportCatalog,
  seriesId: number | null,
  episodeIds: readonly number[],
): { series: { id: number; title: string }; episodes: Array<QueueEpisode & { id: number }> } {
  const series = seriesId !== null ? catalog.series.get(seriesId) : undefined;
  if (!series) throw new ImportOverrideError("series");
  const episodes: Array<QueueEpisode & { id: number }> = [];
  for (const id of episodeIds) {
    const e = series.episodes.get(id);
    if (!e) throw new ImportOverrideError("episodes");
    episodes.push({ id, seasonNumber: e.seasonNumber, episodeNumber: e.episodeNumber });
  }
  return { series: { id: series.id, title: series.title }, episodes };
}

// Sonarr v3 reads only its single `language`: a `languages` array written
// here would be ignored and the file stored as Language Unknown. Refused (400,
// nothing sent) rather than silently dropped.
function catalogLanguages(catalog: ImportCatalog, row: ManualImportRow, languageIds: readonly number[]): Array<{ id: number; name: string }> {
  if (singleLanguage(row)) throw new ImportOverrideError("languages");
  const out: Array<{ id: number; name: string }> = [];
  for (const id of languageIds) {
    const l = catalog.languages.get(id);
    if (!l) throw new ImportOverrideError("languages");
    out.push(l);
  }
  return out;
}

/**
 * The arr's own rows for the chosen paths, corrections applied. A path the arr
 * did not report is dropped here — it never reaches a command (guardrail 5d).
 */
export function effectiveImportRows(
  service: QueueService,
  raw: unknown,
  selections: ReadonlyMap<string, ImportOverride>,
  catalog: ImportCatalog,
): Array<{ path: string; row: ManualImportRow }> {
  if (!Array.isArray(raw)) return [];
  const out: Array<{ path: string; row: ManualImportRow }> = [];
  const scanned = Math.min(raw.length, QUEUE_IMPORT_MAX_FILES * PROJECTION_SCAN_FACTOR);
  for (let i = 0; i < scanned && out.length < QUEUE_IMPORT_MAX_FILES; i++) {
    const r = raw[i] as ManualImportRow;
    if (!r || typeof r !== "object") continue;
    const path = validPath(r.path);
    if (path === null) continue;
    const override = selections.get(path);
    if (override === undefined) continue;
    out.push({ path, row: applyImportOverride(service, r, override, catalog) });
  }
  return out;
}

/** The arr's rows for the chosen paths, before corrections — what the catalog loader needs to see. */
export function selectedRawRows(raw: unknown, selections: ReadonlyMap<string, ImportOverride>): Array<{ row: ManualImportRow; override: ImportOverride }> {
  if (!Array.isArray(raw)) return [];
  const out: Array<{ row: ManualImportRow; override: ImportOverride }> = [];
  for (const r of raw as ManualImportRow[]) {
    const path = r && typeof r === "object" ? validPath(r.path) : null;
    const override = path !== null ? selections.get(path) : undefined;
    if (override !== undefined) out.push({ row: r, override });
  }
  return out;
}

const commonFields = (path: string, r: ManualImportRow, downloadId: string) => ({
  path,
  folderName: typeof r.folderName === "string" ? r.folderName : undefined,
  quality: r.quality,
  ...languageFields(r),
  releaseGroup: typeof r.releaseGroup === "string" ? r.releaseGroup : undefined,
  indexerFlags: typeof r.indexerFlags === "number" ? r.indexerFlags : 0,
  downloadId,
});

/**
 * The ManualImport command's `files`: the chosen rows (corrections applied)
 * that are mapped, each carrying back what the arr detected unless the admin
 * corrected it — the shape the arr UI sends. `downloadId` ties the import to
 * the tracked download so the queue item completes.
 */
export function manualImportFiles(
  service: QueueService,
  rows: ReadonlyArray<{ path: string; row: ManualImportRow }>,
  downloadId: string,
): Array<Record<string, unknown>> {
  const files: Array<Record<string, unknown>> = [];
  for (const { path, row: r } of rows) {
    const eps = service === "sonarr" ? rowEpisodes(r) : [];
    if (!isMapped(service, r, eps)) continue;
    if (service === "radarr") {
      files.push({ ...commonFields(path, r, downloadId), movieId: posInt(r.movie?.id) });
    } else {
      files.push({
        ...commonFields(path, r, downloadId),
        seriesId: posInt(r.series?.id),
        episodeIds: eps.map((e) => e.id),
        ...(r.releaseType !== undefined ? { releaseType: r.releaseType } : {}),
      });
    }
  }
  return files;
}

/**
 * The body for the arr's manual-import REPROCESS (POST /api/v3/manualimport):
 * the corrected rows, re-judged by the arr so the dialog shows fresh refusal
 * reasons. A row with no movie (Radarr) or series (Sonarr) can't be
 * reprocessed — the arr looks the title up by id — and is skipped.
 */
export function reprocessItems(
  service: QueueService,
  rows: ReadonlyArray<{ path: string; row: ManualImportRow }>,
  downloadId: string,
): Array<Record<string, unknown>> {
  const items: Array<Record<string, unknown>> = [];
  for (const { path, row: r } of rows) {
    const common = commonFields(path, r, downloadId);
    if (service === "radarr") {
      const movieId = posInt(r.movie?.id);
      if (movieId === null) continue;
      items.push({ ...common, movieId });
    } else {
      const seriesId = posInt(r.series?.id);
      if (seriesId === null) continue;
      const eps = rowEpisodes(r);
      items.push({
        ...common,
        seriesId,
        seasonNumber: eps[0]?.seasonNumber ?? null,
        episodeIds: eps.map((e) => e.id).filter((id): id is number => id !== null),
        ...(r.releaseType !== undefined ? { releaseType: r.releaseType } : {}),
      });
    }
  }
  return items;
}

/**
 * Folds the arr's reprocess answer back onto the corrected rows: its fresh
 * rejections, plus the episodes (Sonarr) or movie (Radarr) it resolved. The
 * series stays the corrected one — the reprocess resource doesn't echo it.
 * Display only: the import itself re-reads and re-applies (guardrail 5d).
 */
export function mergeReprocessed(
  rows: ReadonlyArray<{ path: string; row: ManualImportRow }>,
  answer: unknown,
): ManualImportRow[] {
  const byPath = new Map<string, ManualImportRow>();
  if (Array.isArray(answer)) {
    for (const a of answer as ManualImportRow[]) {
      const p = a && typeof a === "object" ? validPath(a.path) : null;
      if (p !== null) byPath.set(p, a);
    }
  }
  return rows.map(({ path, row }) => {
    const a = byPath.get(path);
    if (!a) return row;
    return {
      ...row,
      rejections: a.rejections ?? [],
      ...(Array.isArray(a.episodes) && a.episodes.length > 0 ? { episodes: a.episodes } : {}),
      ...(a.movie && typeof a.movie === "object" ? { movie: a.movie } : {}),
    };
  });
}
