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
    quality,
    qualityTags,
    languages: namesOf(r.languages),
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
      languages: namesOf(r.languages),
      customFormats: namesOf(r.customFormats),
      protocol: protocolOf(r.protocol),
      indexer: textOrNull(r.indexer, 200),
      message: safeMessage(r.message),
    });
  }
  return out;
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
