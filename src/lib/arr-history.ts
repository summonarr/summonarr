// Radarr/Sonarr download history and blocklist — the pure half. Projects the
// arrs' history records and blocklist entries down to what the admin pages
// show. Zero I/O; the data half is arr-history-data.ts (the History page,
// the Blocklist tab) and arr-title-data.ts (one title's history).
//
// A history record's `data` is a free-form string map the arr fills per event,
// and for a grab it holds the release's `downloadUrl` and `guid` — which, for
// Newznab/Torznab indexers, embed the admin's indexer apikey. Only the named
// fields below are read from it; nothing else in `data` ever leaves the server
// (guardrail 5e).
import {
  int,
  isoOrNull,
  namesOf,
  nonNegInt,
  posInt,
  protocolOf,
  qualityOf,
  safeMessage,
  text,
  textOrNull,
  type Protocol,
  type QualityTag,
} from "./arr-parse";
import type { ArrService } from "./arr-instances";

export type HistoryKind = "grabbed" | "imported" | "failed" | "deleted" | "renamed" | "ignored" | "unknown";
/** The kinds the History page can filter on, in the arrs' own order. */
export const HISTORY_FILTER_KINDS = ["grabbed", "imported", "failed", "deleted", "renamed", "ignored"] as const;
export type HistoryFilterKind = (typeof HISTORY_FILTER_KINDS)[number];

export function parseHistoryKind(v: unknown): HistoryFilterKind | null {
  return typeof v === "string" && (HISTORY_FILTER_KINDS as readonly string[]).includes(v) ? (v as HistoryFilterKind) : null;
}

// The arrs' history event enums. Radarr: Grabbed 1, DownloadFolderImported 3,
// DownloadFailed 4, MovieFileDeleted 6, MovieFolderImported 7, MovieFileRenamed 8,
// DownloadIgnored 9. Sonarr: Grabbed 1, SeriesFolderImported 2,
// DownloadFolderImported 3, DownloadFailed 4, EpisodeFileDeleted 5,
// EpisodeFileRenamed 6, DownloadIgnored 7. They DIFFER past 4, so a filter
// is always translated per service. ONE id per kind: an older arr's paging
// joins a repeated key into "3,2" and fails to read it as a number, and the
// folder-import events (Sonarr 2, Radarr 7) are not written upstream anyway.
const EVENT_IDS: Record<ArrService, Record<HistoryFilterKind, number>> = {
  radarr: { grabbed: 1, imported: 3, failed: 4, deleted: 6, renamed: 8, ignored: 9 },
  sonarr: { grabbed: 1, imported: 3, failed: 4, deleted: 5, renamed: 6, ignored: 7 },
};
// Read-side only: a record may still carry a folder-import event.
const EXTRA_KIND_IDS: Record<ArrService, Record<number, HistoryKind>> = {
  radarr: { 7: "imported" },
  sonarr: { 2: "imported" },
};

/** The `eventType` query for a kind. */
export function historyEventQuery(service: ArrService, kind: HistoryFilterKind): string {
  return `eventType=${EVENT_IDS[service][kind]}`;
}

const KIND_BY_NAME: Record<string, HistoryKind> = {
  grabbed: "grabbed",
  downloadfolderimported: "imported",
  seriesfolderimported: "imported",
  moviefolderimported: "imported",
  downloadfailed: "failed",
  moviefiledeleted: "deleted",
  episodefiledeleted: "deleted",
  moviefilerenamed: "renamed",
  episodefilerenamed: "renamed",
  downloadignored: "ignored",
};

/** A record's eventType — the enum's name (what the API sends) or its number — as a kind. */
export function historyKindOf(service: ArrService, eventType: unknown): HistoryKind {
  if (typeof eventType === "string") return KIND_BY_NAME[eventType.toLowerCase()] ?? "unknown";
  if (typeof eventType === "number") {
    for (const kind of HISTORY_FILTER_KINDS) if (EVENT_IDS[service][kind] === eventType) return kind;
    return EXTRA_KIND_IDS[service][eventType] ?? "unknown";
  }
  return "unknown";
}

export interface HistoryEpisode { seasonNumber: number; episodeNumber: number; title: string }

export interface ArrHistoryEvent {
  id: number;
  service: ArrService;
  instance: string;
  kind: HistoryKind;
  date: string | null;
  /** The release name. */
  sourceTitle: string;
  /** Radarr movie id / Sonarr series id. */
  arrMediaId: number | null;
  mediaTitle: string;
  year: number | null;
  tmdbId: number | null;
  tvdbId: number | null;
  episode: HistoryEpisode | null;
  /**
   * Sonarr's episode id for the record. Sonarr v4's per-series history
   * (/history/series) embeds no `episode`, so a reader that needs S/E joins this
   * against the series' episode list.
   */
  episodeId: number | null;
  quality: string | null;
  qualityTags: QualityTag[];
  languages: string[];
  customFormats: string[];
  customFormatScore: number | null;
  downloadId: string | null;
  // From `data`, by name only — see the file header.
  indexer: string | null;
  downloadClient: string | null;
  releaseGroup: string | null;
  protocol: Protocol;
  size: number | null;
  /** Why a file was deleted (Upgrade, MissingFromDisk, Manual). */
  reason: string | null;
  /** A failure's or an ignore's message, credentials masked. */
  message: string | null;
  /** Where an import picked the file up, and where it put it. */
  droppedPath: string | null;
  importedPath: string | null;
  /** A rename's before and after. */
  sourcePath: string | null;
  path: string | null;
}

type Raw = Record<string, unknown>;
const obj = (v: unknown): Raw | null => (v && typeof v === "object" && !Array.isArray(v) ? (v as Raw) : null);

/** The history record's data map, keys lower-cased (the arrs have sent both Pascal and camel case). */
function dataOf(v: unknown): Map<string, string> {
  const out = new Map<string, string>();
  const d = obj(v);
  if (!d) return out;
  for (const [k, val] of Object.entries(d)) if (typeof val === "string") out.set(k.toLowerCase(), val);
  return out;
}

function sizeFrom(s: string | undefined): number | null {
  if (!s || !/^\d{1,16}$/.test(s)) return null;
  const n = Number(s);
  return Number.isSafeInteger(n) && n > 0 ? n : null;
}

/** A record's `languages` — or the singular `language` object Sonarr v3 and older Radarr send instead. */
function languagesOf(r: Raw): string[] {
  const list = namesOf(r.languages);
  return list.length > 0 || !obj(r.language) ? list : namesOf([r.language]);
}

/** One /api/v3/history record → an event, or null when it has no usable id. */
export function projectHistoryRecord(service: ArrService, instance: string, raw: unknown): ArrHistoryEvent | null {
  const r = obj(raw);
  const id = posInt(r?.id);
  if (!r || id === null) return null;
  const media = obj(service === "radarr" ? r.movie : r.series);
  const ep = service === "sonarr" ? obj(r.episode) : null;
  const epSeason = nonNegInt(ep?.seasonNumber);
  const epNumber = nonNegInt(ep?.episodeNumber);
  const d = dataOf(r.data);
  const { quality, qualityTags } = qualityOf(r.quality);
  const get = (k: string, max = 300) => textOrNull(d.get(k), max);
  return {
    id,
    service,
    instance,
    kind: historyKindOf(service, r.eventType),
    date: isoOrNull(r.date),
    sourceTitle: text(r.sourceTitle, 500),
    arrMediaId: posInt(service === "radarr" ? r.movieId : r.seriesId),
    mediaTitle: text(media?.title, 300),
    year: posInt(media?.year),
    tmdbId: posInt(media?.tmdbId),
    tvdbId: service === "sonarr" ? posInt(media?.tvdbId) : null,
    episode: epSeason !== null && epNumber !== null ? { seasonNumber: epSeason, episodeNumber: epNumber, title: text(ep?.title, 300) } : null,
    episodeId: service === "sonarr" ? posInt(r.episodeId) : null,
    quality,
    qualityTags,
    languages: languagesOf(r),
    customFormats: namesOf(r.customFormats),
    customFormatScore: int(r.customFormatScore),
    downloadId: textOrNull(r.downloadId, 200),
    indexer: get("indexer", 200),
    downloadClient: get("downloadclientname", 200) ?? get("downloadclient", 200),
    releaseGroup: get("releasegroup", 100),
    protocol: protocolOf(d.get("protocol")),
    size: sizeFrom(d.get("size")),
    reason: get("reason", 100),
    message: safeMessage(d.get("message")),
    droppedPath: get("droppedpath", 1_000),
    importedPath: get("importedpath", 1_000),
    sourcePath: get("sourcerelativepath", 1_000) ?? get("sourcepath", 1_000),
    path: get("relativepath", 1_000) ?? get("path", 1_000),
  };
}

export function projectHistoryRecords(service: ArrService, instance: string, raw: unknown): ArrHistoryEvent[] {
  if (!Array.isArray(raw)) return [];
  const out: ArrHistoryEvent[] = [];
  for (const r of raw) {
    const e = projectHistoryRecord(service, instance, r);
    if (e) out.push(e);
  }
  return out;
}

/** Newest first; ties by id, newest first. */
export function sortHistoryEvents(events: ArrHistoryEvent[]): ArrHistoryEvent[] {
  return events.sort((a, b) => (b.date ?? "").localeCompare(a.date ?? "") || b.id - a.id);
}

// ── rows: one per download event ─────────────────────────────────────────────

/**
 * One row of a history list. Sonarr writes a Grabbed, Imported and Failed
 * record PER EPISODE of a download, all carrying its `downloadId`, so a
 * 10-episode pack is ten identical records — and ten Mark failed buttons, each
 * of which fails the WHOLE download. A row folds them back into the one event
 * they describe.
 */
export interface HistoryRow {
  /** Unique within a list (instance + the lead's id). */
  key: string;
  /** The newest record: the row's date, release and quality, and the id a Mark failed sends. */
  lead: ArrHistoryEvent;
  /** Every record folded into the row, the lead included, in episode order. */
  events: ArrHistoryEvent[];
  /** The distinct episodes the row covers, in S/E order (only those the arr embedded). */
  episodes: HistoryEpisode[];
  /** Distinct episodes — by S/E, else Sonarr's episode id, else the record. 0 for a movie. */
  episodeCount: number;
  /** Season numbers the row covers, ascending. */
  seasons: number[];
  /** On a paged list, a folded Sonarr row touches the page's top / bottom edge — more of it may be on the neighbouring page. */
  continuesBefore: boolean;
  continuesAfter: boolean;
}

const downloadKey = (e: ArrHistoryEvent) => (e.downloadId !== null ? `${e.instance}\u0000${e.downloadId}` : null);

/**
 * The longest gap between two consecutive records of one folded row. Sonarr
 * writes a grab's or a failure's per-episode records in the same instant, and
 * an import's as each file lands — seconds apart, minutes for a large pack
 * copied across disks — while a re-grab of the same info hash or a second
 * import of the download is a separate, later event. The gap is measured from
 * the PREVIOUS record of the run, not its first, so a slow pack import stays
 * one row.
 */
export const HISTORY_FOLD_GAP_MS = 5 * 60_000;

/** Folded records of one Sonarr download: same instance, download id and series. */
const foldKey = (e: ArrHistoryEvent) =>
  e.service === "sonarr" && e.downloadId !== null ? `${e.instance}\u0000${e.downloadId}\u0000${e.arrMediaId ?? ""}` : null;

/** `next` continues the run that `prev` ends: the same kind, written within HISTORY_FOLD_GAP_MS of it. */
function continuesRun(prev: ArrHistoryEvent, next: ArrHistoryEvent): boolean {
  if (prev.kind !== next.kind) return false;
  const a = prev.date !== null ? Date.parse(prev.date) : NaN;
  const b = next.date !== null ? Date.parse(next.date) : NaN;
  // An undated record can't be shown to belong to the same moment: its own row.
  return Number.isFinite(a) && Number.isFinite(b) && Math.abs(b - a) <= HISTORY_FOLD_GAP_MS;
}

/**
 * The list's rows, in list order (a row sits where its first record does).
 * Only SONARR records fold — Radarr writes one record per event, never one per
 * episode — and only when they share an instance, a downloadId and a series,
 * and form one unbroken run of one kind among that download's records by id,
 * each written within HISTORY_FOLD_GAP_MS of the one before. A torrent grabbed,
 * failed and grabbed again keeps one info hash, and its two grabs are two
 * events — also on a list filtered to grabs, where the failure between them
 * isn't there to cut the run (the time gap does). Only what the list holds is
 * folded: `edges` (a paged list) marks a folded row at either end, whose other
 * records may be on the neighbouring page.
 */
export function groupHistoryEvents(
  events: readonly ArrHistoryEvent[],
  edges: { hasPrevious: boolean; hasNext: boolean } | null = null,
): HistoryRow[] {
  // Per Sonarr download: its records by id, cut into runs of one kind and moment.
  const byDownload = new Map<string, ArrHistoryEvent[]>();
  for (const e of events) {
    const k = foldKey(e);
    if (k === null) continue;
    const list = byDownload.get(k);
    if (list) list.push(e);
    else byDownload.set(k, [e]);
  }
  const runOf = new Map<ArrHistoryEvent, ArrHistoryEvent[]>();
  for (const list of byDownload.values()) {
    list.sort((a, b) => a.id - b.id);
    let run: ArrHistoryEvent[] = [];
    for (const e of list) {
      if (run.length > 0 && !continuesRun(run[run.length - 1], e)) run = [];
      run.push(e);
      runOf.set(e, run);
    }
  }
  const first = events[0];
  const last = events[events.length - 1];
  const rows: HistoryRow[] = [];
  const emitted = new Set<ArrHistoryEvent[]>();
  for (const e of events) {
    const run = runOf.get(e) ?? [e];
    if (emitted.has(run)) continue;
    emitted.add(run);
    const lead = run.reduce((a, b) => (b.id > a.id ? b : a));
    const sorted = [...run].sort(
      (a, b) =>
        (a.episode?.seasonNumber ?? -1) - (b.episode?.seasonNumber ?? -1) ||
        (a.episode?.episodeNumber ?? -1) - (b.episode?.episodeNumber ?? -1) ||
        a.id - b.id,
    );
    const episodes: HistoryEpisode[] = [];
    const seen = new Set<string>();
    const seasons = new Set<number>();
    for (const x of sorted) {
      const id = x.episode ? `se:${x.episode.seasonNumber}:${x.episode.episodeNumber}` : x.episodeId !== null ? `ep:${x.episodeId}` : `rec:${x.id}`;
      if (seen.has(id)) continue;
      seen.add(id);
      if (x.episode) {
        episodes.push(x.episode);
        seasons.add(x.episode.seasonNumber);
      }
    }
    const pages = run.length > 1 && lead.service === "sonarr" && edges !== null;
    rows.push({
      key: `${lead.instance}:${lead.id}`,
      lead,
      events: sorted,
      episodes,
      episodeCount: lead.service === "sonarr" ? seen.size : 0,
      seasons: [...seasons].sort((a, b) => a - b),
      continuesBefore: pages && edges.hasPrevious && run.includes(first),
      continuesAfter: pages && edges.hasNext && run.includes(last),
    });
  }
  return rows;
}

/** What the list's other records say happened to a grab's download since. */
export interface GrabState {
  /** A failure newer than the grab — the download is already failed; marking it again would blocklist and search twice. */
  failed: boolean;
  /** An import newer than the grab — Mark failed still blocklists the release and searches again. */
  imported: boolean;
}

/**
 * A grab row's state, from the records the list holds. Only a record NEWER
 * than the grab counts (a higher id — ids are the arr's insert order): a
 * torrent grabbed again after a failure keeps its info hash. A list filtered
 * to one kind holds no failures or imports, so it reads as neither.
 */
export function grabStateOf(row: HistoryRow, events: readonly ArrHistoryEvent[]): GrabState {
  const k = downloadKey(row.lead);
  if (row.lead.kind !== "grabbed" || k === null) return { failed: false, imported: false };
  let failed = false;
  let imported = false;
  for (const e of events) {
    if (e.id <= row.lead.id || downloadKey(e) !== k) continue;
    if (e.kind === "failed") failed = true;
    else if (e.kind === "imported") imported = true;
  }
  return { failed, imported };
}

// ── paging ───────────────────────────────────────────────────────────────────

export interface ArrPage<T> {
  page: number;
  pageSize: number;
  totalRecords: number;
  records: T[];
}

export const MAX_PAGE_SIZE = 100;

/** A page number and size from a query string, bounded; null when malformed. */
export function parsePaging(rawPage: string | null, rawSize: string | null): { page: number; pageSize: number } | null {
  const page = rawPage === null || rawPage === "" ? 1 : /^\d{1,6}$/.test(rawPage) ? Number(rawPage) : NaN;
  const pageSize = rawSize === null || rawSize === "" ? 50 : /^\d{1,3}$/.test(rawSize) ? Number(rawSize) : NaN;
  if (!Number.isInteger(page) || page < 1 || !Number.isInteger(pageSize) || pageSize < 1 || pageSize > MAX_PAGE_SIZE) return null;
  return { page, pageSize };
}

/**
 * The page to show instead when the one asked for came back empty although the
 * list is not — its last records were removed, or a link named a page the list
 * no longer has: the last page, by the size the arr answered with. Null when
 * the page stands (or an arr reports a total its pages don't hold).
 */
export function lastPageIfStranded(page: number, data: { records: readonly unknown[]; totalRecords: number; pageSize: number }): number | null {
  if (data.records.length > 0 || data.totalRecords === 0 || page <= 1) return null;
  const last = Math.max(1, Math.ceil(data.totalRecords / Math.max(1, data.pageSize)));
  return last < page ? last : null;
}

/** The arr's paging envelope, its records projected. */
export function pageOf<T>(raw: unknown, project: (records: unknown) => T[], fallback: { page: number; pageSize: number }): ArrPage<T> {
  const r = obj(raw);
  return {
    page: posInt(r?.page) ?? fallback.page,
    pageSize: posInt(r?.pageSize) ?? fallback.pageSize,
    totalRecords: nonNegInt(r?.totalRecords) ?? 0,
    records: project(r?.records),
  };
}

// ── blocklist ────────────────────────────────────────────────────────────────

export interface BlocklistEntry {
  id: number;
  service: ArrService;
  instance: string;
  arrMediaId: number | null;
  mediaTitle: string;
  year: number | null;
  tmdbId: number | null;
  tvdbId: number | null;
  /** Sonarr: how many episodes the release covered. */
  episodeCount: number;
  sourceTitle: string;
  date: string | null;
  quality: string | null;
  qualityTags: QualityTag[];
  languages: string[];
  customFormats: string[];
  protocol: Protocol;
  indexer: string | null;
  /** Why it was blocklisted, credentials masked. */
  message: string | null;
}

/** /api/v3/blocklist records → entries. The title comes from the embedded movie/series when the arr sends one. */
export function projectBlocklistRecords(service: ArrService, instance: string, raw: unknown): BlocklistEntry[] {
  if (!Array.isArray(raw)) return [];
  const out: BlocklistEntry[] = [];
  for (const x of raw) {
    const r = obj(x);
    const id = posInt(r?.id);
    if (!r || id === null) continue;
    const media = obj(service === "radarr" ? r.movie : r.series);
    const { quality, qualityTags } = qualityOf(r.quality);
    out.push({
      id,
      service,
      instance,
      arrMediaId: posInt(service === "radarr" ? r.movieId : r.seriesId),
      mediaTitle: text(media?.title, 300),
      year: posInt(media?.year),
      tmdbId: posInt(media?.tmdbId),
      tvdbId: service === "sonarr" ? posInt(media?.tvdbId) : null,
      episodeCount: service === "sonarr" && Array.isArray(r.episodeIds) ? r.episodeIds.length : 0,
      sourceTitle: text(r.sourceTitle, 500),
      date: isoOrNull(r.date),
      quality,
      qualityTags,
      languages: languagesOf(r),
      customFormats: namesOf(r.customFormats),
      protocol: protocolOf(r.protocol),
      indexer: textOrNull(r.indexer, 200),
      message: safeMessage(r.message),
    });
  }
  return out;
}

/** What the audit keeps of a blocklist record being removed — once it's gone, its id points at nothing. */
export interface RemovedBlocklistEntry {
  id: number;
  /** The release name, bounded. */
  release: string;
  /** Radarr movie id / Sonarr series id. */
  arrMediaId: number | null;
}

export function removedBlocklistEntry(service: ArrService, raw: unknown): RemovedBlocklistEntry | null {
  const r = obj(raw);
  const id = posInt(r?.id);
  if (!r || id === null) return null;
  return { id, release: text(r.sourceTitle, 500), arrMediaId: posInt(service === "radarr" ? r.movieId : r.seriesId) };
}

/** A comma-separated id list from a query string (blocklist ids, file ids), bounded; null when malformed. */
export function parseIdList(raw: string | null, max = 500): number[] | null {
  if (raw === null || raw === "" || raw.length > max * 12) return null;
  const parts = raw.split(",");
  if (parts.length > max) return null;
  const out = new Set<number>();
  for (const p of parts) {
    if (!/^\d{1,12}$/.test(p)) return null;
    const n = Number(p);
    if (!Number.isSafeInteger(n) || n <= 0) return null;
    out.add(n);
  }
  return [...out];
}
