// Admin → Download Queue: the pure rules. Turns raw Radarr/Sonarr
// /api/v3/queue records into one row per DOWNLOAD and decides which rows need an
// admin's attention. Zero imports, zero I/O; the data half is arr-queue-data.ts.
//
//   • Sonarr reports one queue record PER EPISODE, so a season pack is N records
//     sharing one downloadId. They fold into one row carrying every record id —
//     a removal must send all of them in ONE bulk call, or the first DELETE
//     removes the download and blocklists it and the rest 404 (or blocklist the
//     same release again). Size/progress are the download's, not a sum: every
//     episode record repeats the whole release's size.
//   • A row needs attention when Radarr/Sonarr say so — a tracked-download
//     status of warning/error, an import that is blocked or failed, or a queue
//     status of failed/warning/client-unavailable. Nothing here guesses from
//     progress or age; the arr already folds stalled torrents into a warning.

export type QueueService = "radarr" | "sonarr";

export type QueuePhase =
  | "downloading"
  | "queued"
  | "paused"
  | "delay"
  | "importPending"
  | "importing"
  | "importBlocked"
  | "failed"
  | "clientUnavailable"
  | "unknown";

export const QUEUE_PHASES: readonly QueuePhase[] = [
  "downloading", "queued", "paused", "delay", "importPending", "importing", "importBlocked", "failed", "clientUnavailable", "unknown",
];

export interface QueueEpisode {
  seasonNumber: number;
  episodeNumber: number;
}

export interface QueueItem {
  service: QueueService;
  instance: string;
  /** Every queue record id this row covers (one per episode for a Sonarr pack). Removal sends them all. */
  ids: number[];
  downloadId: string | null;
  /** The release name. */
  title: string;
  /** The movie or series title. */
  mediaTitle: string;
  year: number | null;
  tmdbId: number | null;
  tvdbId: number | null;
  /** Radarr movie id / Sonarr series id. */
  arrMediaId: number | null;
  episodes: QueueEpisode[];
  quality: string | null;
  size: number;
  sizeLeft: number;
  /** 0..1, from size and sizeLeft. */
  progress: number;
  timeLeftSeconds: number | null;
  estimatedCompletion: string | null;
  added: string | null;
  phase: QueuePhase;
  /**
   * A release Radarr/Sonarr are HOLDING (a delay profile, an unavailable client,
   * a fallback) and have not sent to a download client yet. It can be grabbed
   * now; it has no files to import and nothing in a client to remove.
   */
  pending: boolean;
  /** The download client has a post-import category, so "change category" is a removal option. */
  canChangeCategory: boolean;
  trackedStatus: "ok" | "warning" | "error" | null;
  /** What Radarr/Sonarr say is wrong, deduplicated. */
  messages: string[];
  protocol: "torrent" | "usenet" | "unknown";
  downloadClient: string | null;
  indexer: string | null;
  attention: boolean;
  /** Summonarr users with a non-declined request for the title on this instance. Filled by the data layer. */
  requesters: string[];
}

// Bounds on what one row carries to the browser. A pathological import can
// report hundreds of status lines; the page needs the first few.
const MAX_MESSAGES = 6;
const MAX_MESSAGE_LEN = 300;
const MAX_TEXT = 500;

const posInt = (v: unknown): number | null => (typeof v === "number" && Number.isInteger(v) && v > 0 ? v : null);
const nonNegInt = (v: unknown): number | null => (typeof v === "number" && Number.isInteger(v) && v >= 0 ? v : null);
const text = (v: unknown, max = MAX_TEXT): string => (typeof v === "string" ? v.slice(0, max) : "");
const textOrNull = (v: unknown, max = MAX_TEXT): string | null => (typeof v === "string" && v.trim() !== "" ? v.slice(0, max) : null);
const bytes = (v: unknown): number => (typeof v === "number" && Number.isFinite(v) && v > 0 ? v : 0);
function isoOrNull(v: unknown): string | null {
  if (typeof v !== "string" || v === "") return null;
  const ms = Date.parse(v);
  return Number.isFinite(ms) ? new Date(ms).toISOString() : null;
}

/**
 * A .NET TimeSpan as Radarr/Sonarr serialize it: "hh:mm:ss", "d.hh:mm:ss",
 * either with an optional fractional second. Seconds, or null when absent or
 * unparseable (a stalled download sends no timeleft at all).
 */
export function parseTimeSpan(v: unknown): number | null {
  if (typeof v !== "string") return null;
  const m = /^(?:(\d+)\.)?(\d{1,2}):(\d{2}):(\d{2})(?:\.\d+)?$/.exec(v.trim());
  if (!m) return null;
  const [, d, h, min, s] = m;
  return (d ? Number(d) * 86_400 : 0) + Number(h) * 3_600 + Number(min) * 60 + Number(s);
}

export type QueueRecord = {
  id?: unknown;
  downloadId?: unknown;
  title?: unknown;
  movieId?: unknown;
  movie?: { tmdbId?: unknown; title?: unknown; year?: unknown } | null;
  seriesId?: unknown;
  series?: { tmdbId?: unknown; tvdbId?: unknown; title?: unknown; year?: unknown } | null;
  episode?: { seasonNumber?: unknown; episodeNumber?: unknown } | null;
  seasonNumber?: unknown;
  quality?: { quality?: { name?: unknown } | null } | null;
  size?: unknown;
  sizeleft?: unknown;
  timeleft?: unknown;
  estimatedCompletionTime?: unknown;
  added?: unknown;
  status?: unknown;
  trackedDownloadStatus?: unknown;
  trackedDownloadState?: unknown;
  statusMessages?: unknown;
  errorMessage?: unknown;
  protocol?: unknown;
  downloadClient?: unknown;
  downloadClientHasPostImportCategory?: unknown;
  indexer?: unknown;
};

const lc = (v: unknown): string => (typeof v === "string" ? v.toLowerCase() : "");

/** The one place a record's state becomes a phase. The tracked state (import pipeline) wins over the client status. */
export function queuePhase(status: unknown, trackedState: unknown): QueuePhase {
  switch (lc(trackedState)) {
    case "importblocked": return "importBlocked";
    case "importpending": return "importPending";
    case "importing":
    case "imported": return "importing";
    case "failed":
    case "failedpending": return "failed";
  }
  switch (lc(status)) {
    case "downloading": return "downloading";
    case "queued": return "queued";
    case "paused": return "paused";
    case "delay": return "delay";
    case "failed": return "failed";
    case "downloadclientunavailable": return "clientUnavailable";
    case "fallback": return "delay";
    case "completed": return "importPending";
    // "warning" is a downloading item the client flagged (stalled, no
    // connections); the attention flag carries the warning itself.
    case "warning": return "downloading";
  }
  return "unknown";
}

/** The statuses of a release Radarr/Sonarr are holding back (never sent to a client). */
export function isPendingStatus(status: unknown): boolean {
  const s = lc(status);
  return s === "delay" || s === "downloadclientunavailable" || s === "fallback";
}

function trackedStatusOf(v: unknown): "ok" | "warning" | "error" | null {
  const s = lc(v);
  return s === "ok" || s === "warning" || s === "error" ? s : null;
}

/** Radarr/Sonarr's own verdict that an admin should look — see the module header. */
export function needsAttention(r: Pick<QueueRecord, "status" | "trackedDownloadStatus" | "trackedDownloadState">): boolean {
  const tracked = trackedStatusOf(r.trackedDownloadStatus);
  if (tracked === "warning" || tracked === "error") return true;
  const state = lc(r.trackedDownloadState);
  if (state === "importblocked" || state === "failedpending" || state === "failed") return true;
  const status = lc(r.status);
  return status === "failed" || status === "warning" || status === "downloadclientunavailable";
}

function messagesOf(r: QueueRecord): string[] {
  const out: string[] = [];
  const push = (m: unknown) => {
    const s = typeof m === "string" ? m.trim() : "";
    if (s && !out.includes(s.slice(0, MAX_MESSAGE_LEN))) out.push(s.slice(0, MAX_MESSAGE_LEN));
  };
  push(r.errorMessage);
  if (Array.isArray(r.statusMessages)) {
    for (const sm of r.statusMessages as Array<{ title?: unknown; messages?: unknown } | null>) {
      if (!sm || typeof sm !== "object") continue;
      if (Array.isArray(sm.messages) && sm.messages.length > 0) for (const m of sm.messages) push(m);
      else push(sm.title);
    }
  }
  return out.slice(0, MAX_MESSAGES);
}

function protocolOf(v: unknown): QueueItem["protocol"] {
  const s = lc(v);
  return s === "torrent" || s === "usenet" ? s : "unknown";
}

function toItem(service: QueueService, instance: string, r: QueueRecord, id: number): QueueItem {
  const media = service === "radarr" ? r.movie : r.series;
  const size = bytes(r.size);
  const sizeLeft = Math.min(bytes(r.sizeleft), size);
  const episode = r.episode;
  const episodes: QueueEpisode[] = [];
  if (service === "sonarr" && episode) {
    const season = nonNegInt(episode.seasonNumber);
    const number = nonNegInt(episode.episodeNumber);
    if (season !== null && number !== null) episodes.push({ seasonNumber: season, episodeNumber: number });
  }
  return {
    service,
    instance,
    ids: [id],
    downloadId: textOrNull(r.downloadId, 200),
    title: text(r.title),
    mediaTitle: text(media?.title),
    year: posInt(media?.year),
    tmdbId: posInt(media?.tmdbId),
    tvdbId: service === "sonarr" ? posInt(r.series?.tvdbId) : null,
    arrMediaId: posInt(service === "radarr" ? r.movieId : r.seriesId),
    episodes,
    quality: textOrNull(r.quality?.quality?.name, 100),
    size,
    sizeLeft,
    progress: size > 0 ? Math.max(0, Math.min(1, (size - sizeLeft) / size)) : 0,
    timeLeftSeconds: parseTimeSpan(r.timeleft),
    estimatedCompletion: isoOrNull(r.estimatedCompletionTime),
    added: isoOrNull(r.added),
    phase: queuePhase(r.status, r.trackedDownloadState),
    trackedStatus: trackedStatusOf(r.trackedDownloadStatus),
    messages: messagesOf(r),
    protocol: protocolOf(r.protocol),
    downloadClient: textOrNull(r.downloadClient, 200),
    indexer: textOrNull(r.indexer, 200),
    attention: needsAttention(r),
    pending: isPendingStatus(r.status),
    canChangeCategory: r.downloadClientHasPostImportCategory === true,
    requesters: [],
  };
}

// Folding a later episode record into the row its download already started.
function mergeInto(row: QueueItem, next: QueueItem): void {
  row.ids.push(...next.ids);
  for (const e of next.episodes) {
    if (!row.episodes.some((x) => x.seasonNumber === e.seasonNumber && x.episodeNumber === e.episodeNumber)) row.episodes.push(e);
  }
  for (const m of next.messages) if (row.messages.length < MAX_MESSAGES && !row.messages.includes(m)) row.messages.push(m);
  row.attention ||= next.attention;
  row.canChangeCategory ||= next.canChangeCategory;
  // The release's own numbers repeat on every record; keep the largest view.
  if (next.size > row.size) {
    row.size = next.size;
    row.sizeLeft = next.sizeLeft;
    row.progress = next.progress;
  }
  if (row.trackedStatus !== "error" && next.trackedStatus && next.trackedStatus !== "ok") row.trackedStatus = next.trackedStatus;
}

/**
 * Raw records of ONE instance → one row per download. Records without a valid
 * id are dropped (nothing could act on them). Sonarr records sharing a
 * downloadId fold together; a record without a downloadId (a pending release
 * Sonarr has not sent to a client yet) stands alone.
 */
export function foldQueueRecords(service: QueueService, instance: string, records: readonly unknown[]): QueueItem[] {
  const rows: QueueItem[] = [];
  const byDownload = new Map<string, QueueItem>();
  for (const raw of records) {
    if (!raw || typeof raw !== "object") continue;
    const r = raw as QueueRecord;
    const id = posInt(r.id);
    if (id === null) continue;
    const item = toItem(service, instance, r, id);
    const key = service === "sonarr" && item.downloadId ? `${item.downloadId}:${item.arrMediaId ?? ""}` : null;
    const existing = key ? byDownload.get(key) : undefined;
    if (existing) {
      mergeInto(existing, item);
      continue;
    }
    if (key) byDownload.set(key, item);
    rows.push(item);
  }
  for (const row of rows) row.episodes.sort((a, b) => a.seasonNumber - b.seasonNumber || a.episodeNumber - b.episodeNumber);
  return rows;
}

const PHASE_ORDER: Record<QueuePhase, number> = {
  importBlocked: 0, failed: 1, clientUnavailable: 2, importPending: 3, importing: 4,
  downloading: 5, paused: 6, queued: 7, delay: 8, unknown: 9,
};

/** Rows needing attention first, then by pipeline stage, then the soonest to finish. */
export function sortQueueItems(items: QueueItem[]): QueueItem[] {
  return items.sort((a, b) => {
    if (a.attention !== b.attention) return a.attention ? -1 : 1;
    if (a.phase !== b.phase) return PHASE_ORDER[a.phase] - PHASE_ORDER[b.phase];
    const ta = a.timeLeftSeconds ?? Number.POSITIVE_INFINITY;
    const tb = b.timeLeftSeconds ?? Number.POSITIVE_INFINITY;
    if (ta !== tb) return ta - tb;
    return a.mediaTitle.localeCompare(b.mediaTitle);
  });
}

// ── removal ──────────────────────────────────────────────────────────────────

/**
 * What the admin asked for, in Radarr/Sonarr's own vocabulary (the arr UI's
 * "Remove from queue" dialog):
 *   remove          — drop it from the queue (and, with removeFromClient, the client). No blocklist.
 *   blocklist       — remove AND blocklist the release, so it is never grabbed again. No new search.
 *   blocklistSearch — remove, blocklist, and let Radarr/Sonarr search for a replacement
 *                     (their own "redownload failed" logic — a season pack is searched as a
 *                     season, one episode as an episode). Honours the arr's
 *                     "Redownload Failed" setting; with it off no search runs.
 */
export type QueueRemoveAction = "remove" | "blocklist" | "blocklistSearch";

export function isQueueRemoveAction(v: unknown): v is QueueRemoveAction {
  return v === "remove" || v === "blocklist" || v === "blocklistSearch";
}

/**
 * HOW the download leaves the queue — the arr dialog's "Removal method":
 *   removeFromClient — delete it (and its files) from the download client
 *   changeCategory   — leave it in the client, moved to the client's
 *                      post-import category (only when the client has one —
 *                      QueueItem.canChangeCategory)
 *   ignore           — leave it in the client untouched; the arr stops tracking it
 */
export type QueueRemoveMethod = "removeFromClient" | "changeCategory" | "ignore";

export function isQueueRemoveMethod(v: unknown): v is QueueRemoveMethod {
  return v === "removeFromClient" || v === "changeCategory" || v === "ignore";
}

/**
 * The bulk DELETE's query string. Every flag is sent explicitly: Radarr and
 * Sonarr default `removeFromClient` to TRUE, so an omitted flag is not "off".
 * With neither removeFromClient nor changeCategory set and no blocklist the arr
 * IGNORES the download (stops tracking it, leaves it in the client).
 */
export function queueRemoveQuery(action: QueueRemoveAction, method: QueueRemoveMethod): string {
  const blocklist = action !== "remove";
  const skipRedownload = action !== "blocklistSearch";
  return new URLSearchParams({
    removeFromClient: String(method === "removeFromClient"),
    blocklist: String(blocklist),
    skipRedownload: String(skipRedownload),
    changeCategory: String(method === "changeCategory"),
  }).toString();
}

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

/** Whether the arr matched the file far enough for the ManualImport command to accept it. */
function isMapped(service: QueueService, row: ManualImportRow): boolean {
  if (service === "radarr") return posInt(row.movie?.id) !== null;
  const eps = rowEpisodes(row);
  return posInt(row.series?.id) !== null && eps.length > 0 && eps.every((e) => e.id !== null);
}

function validPath(v: unknown): string | null {
  return typeof v === "string" && v.length > 0 && v.length <= MAX_PATH ? v : null;
}

/** /api/v3/manualimport → what the import dialog shows. Rows without a path are dropped. */
export function importCandidates(service: QueueService, raw: unknown): ImportCandidate[] {
  if (!Array.isArray(raw)) return [];
  const out: ImportCandidate[] = [];
  for (const r of raw as ManualImportRow[]) {
    if (!r || typeof r !== "object") continue;
    const path = validPath(r.path);
    if (path === null) continue;
    const episodes = service === "sonarr" ? rowEpisodes(r).map(({ seasonNumber, episodeNumber }) => ({ seasonNumber, episodeNumber })) : [];
    let target: string | null = null;
    if (service === "radarr" && r.movie && typeof r.movie.title === "string" && r.movie.title) {
      const year = posInt(r.movie.year);
      target = year ? `${r.movie.title} (${year})` : r.movie.title;
    } else if (service === "sonarr" && r.series && typeof r.series.title === "string" && r.series.title) {
      target = r.series.title;
    }
    const languages = Array.isArray(r.languages)
      ? (r.languages as Array<{ name?: unknown } | null>).map((l) => (typeof l?.name === "string" ? l.name : "")).filter(Boolean).slice(0, 10)
      : [];
    const rejections = Array.isArray(r.rejections)
      ? (r.rejections as Array<{ reason?: unknown } | null>)
          .map((x) => (typeof x?.reason === "string" ? x.reason.slice(0, MAX_MESSAGE_LEN) : ""))
          .filter(Boolean)
          .slice(0, MAX_MESSAGES)
      : [];
    const qualityObj = r.quality && typeof r.quality === "object" ? (r.quality as { quality?: { name?: unknown; id?: unknown } }).quality : undefined;
    const quality = qualityObj?.name;
    const languageIds = Array.isArray(r.languages)
      ? (r.languages as Array<{ id?: unknown } | null>)
          .map((l) => (typeof l?.id === "number" && Number.isSafeInteger(l.id) ? l.id : null))
          .filter((id): id is number => id !== null)
      : [];
    out.push({
      path,
      name: text(r.relativePath) || text(r.name) || path.slice(-200),
      size: bytes(r.size),
      quality: typeof quality === "string" && quality ? quality.slice(0, 100) : null,
      languages,
      releaseGroup: textOrNull(r.releaseGroup, 100),
      target,
      episodes,
      rejections,
      importable: isMapped(service, r),
      movieId: service === "radarr" ? posInt(r.movie?.id) : null,
      seriesId: service === "sonarr" ? posInt(r.series?.id) : null,
      episodeIds: service === "sonarr" ? rowEpisodes(r).map((e) => e.id).filter((id): id is number => id !== null) : [],
      qualityId: typeof qualityObj?.id === "number" && Number.isSafeInteger(qualityObj.id) ? qualityObj.id : null,
      languageIds,
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

/** A correction the arr's own catalogs don't back (unknown movie, episode of another series, …). */
export class ImportOverrideError extends Error {
  readonly field: "movie" | "series" | "episodes" | "quality" | "languages";
  constructor(field: ImportOverrideError["field"]) {
    super(`invalid ${field}`);
    this.field = field;
  }
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
  if (service === "radarr" && override.movieId !== undefined) {
    const movie = catalog.movies.get(override.movieId);
    if (!movie) throw new ImportOverrideError("movie");
    out.movie = { id: movie.id, title: movie.title, year: movie.year };
  }
  if (service === "sonarr" && override.episodeIds !== undefined) {
    const seriesId = override.seriesId ?? posInt(row.series?.id);
    const series = seriesId !== null && seriesId !== undefined ? catalog.series.get(seriesId) : undefined;
    if (!series) throw new ImportOverrideError("series");
    const episodes = override.episodeIds.map((id) => {
      const e = series.episodes.get(id);
      if (!e) throw new ImportOverrideError("episodes");
      return { id, seasonNumber: e.seasonNumber, episodeNumber: e.episodeNumber };
    });
    out.series = { id: series.id, title: series.title };
    out.episodes = episodes;
  }
  if (override.qualityId !== undefined) {
    const quality = catalog.qualities.get(override.qualityId);
    if (quality === undefined) throw new ImportOverrideError("quality");
    // A hand-picked quality is a plain first release, not a proper/repack.
    out.quality = { quality, revision: { version: 1, real: 0, isRepack: false } };
  }
  if (override.languageIds !== undefined) {
    out.languages = override.languageIds.map((id) => {
      const l = catalog.languages.get(id);
      if (!l) throw new ImportOverrideError("languages");
      return l;
    });
  }
  if (override.releaseGroup !== undefined) out.releaseGroup = override.releaseGroup;
  if (service === "sonarr" && override.releaseType !== undefined) out.releaseType = override.releaseType;
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
  for (const r of raw as ManualImportRow[]) {
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
  languages: Array.isArray(r.languages) ? r.languages : [],
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
    if (!isMapped(service, r)) continue;
    if (service === "radarr") {
      files.push({ ...commonFields(path, r, downloadId), movieId: posInt(r.movie?.id) });
    } else {
      files.push({
        ...commonFields(path, r, downloadId),
        seriesId: posInt(r.series?.id),
        episodeIds: rowEpisodes(r).map((e) => e.id),
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

/**
 * What the Import dialog pre-selects: the matched files the arr had no
 * objection to; when every matched file was refused (the usual blocked
 * import), all of them — the admin opened Import to override exactly those
 * refusals. An unmatched file is never pre-selected (it can't be imported).
 */
export function defaultImportSelection(files: readonly ImportCandidate[]): Set<string> {
  const matched = files.filter((f) => f.importable);
  const clean = matched.filter((f) => f.rejections.length === 0);
  return new Set((clean.length > 0 ? clean : matched).map((f) => f.path));
}

/** A download id as Radarr/Sonarr report it (a client hash or job id): printable ASCII, bounded. */
export function isDownloadId(v: unknown): v is string {
  return typeof v === "string" && /^[\x21-\x7e]{1,200}$/.test(v);
}
