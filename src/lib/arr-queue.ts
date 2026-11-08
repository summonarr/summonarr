// Admin → Download Queue: the pure rules. Turns raw Radarr/Sonarr
// /api/v3/queue records into one row per DOWNLOAD and decides which rows need an
// admin's attention. No I/O; the data half is arr-queue-data.ts. Its only
// imports are the zero-import readers in arr-parse.ts — safeMessage among them,
// so a queue or import line can't carry an indexer apikey to the browser
// (guardrail 5e) — the shared arr-queue-types.ts, and the Manual Import half
// (arr-queue-import.ts, arr-queue-import-selection.ts), re-exported below.
//
//   • Sonarr reports one queue record PER EPISODE, so a season pack is N records
//     sharing one downloadId. They fold into one row carrying every record id;
//     a removal sends ONE of them in ONE bulk call (`removalIds`) — any record
//     resolves the whole download, and Sonarr v3 blocklists once per id sent.
//     Size/progress are the download's, not a sum: every episode record
//     repeats the whole release's size.
//   • A row needs attention when Radarr/Sonarr say so — a tracked-download
//     status of warning/error, an import that is blocked or failed, or a queue
//     status of failed/warning/client-unavailable. Nothing here guesses from
//     progress or age; the arr already folds stalled torrents into a warning.

import {
  bytes,
  isoOrNull,
  languageNamesOf,
  MAX_LABELS,
  namesOf,
  nonNegInt,
  posInt,
  PROJECTION_SCAN_FACTOR,
  protocolOf,
  qualityOf,
  safeMessage,
  text,
  textOrNull,
  type QualityTag,
} from "@/lib/arr-parse";

import { MAX_MESSAGE_LEN, MAX_MESSAGES, type QueueEpisode, type QueueService } from "./arr-queue-types";

export { MAX_LABELS, PROJECTION_SCAN_FACTOR };
export type { QualityTag };
export { MAX_MESSAGES };
export type { QueueEpisode, QueueService };
// The Manual Import half (candidates, corrections, the command's payload) and
// the import dialog's selection rules live beside this module; re-exported so
// every importer keeps one entry point.
export * from "./arr-queue-import";
export * from "./arr-queue-import-selection";


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

export interface QueueItem {
  service: QueueService;
  instance: string;
  /** Every queue record id this row covers (one per episode for a Sonarr pack). Removal sends one per download (`removalIds`). */
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
  /** The release's revision as Radarr/Sonarr tag it next to the quality: a PROPER (version > 1), a REPACK, or REAL. */
  qualityTags: QualityTag[];
  languages: string[];
  /** Custom formats the release matched, and their summed score in the title's quality profile. */
  customFormats: string[];
  customFormatScore: number | null;
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
  /** Where the download client put the files, as the arr sees that path. */
  outputPath: string | null;
  attention: boolean;
  /** Summonarr users with a non-declined request for the title on this instance. Filled by the data layer. */
  requesters: string[];
}

// A record's lists come from the arr, capped only by arrFetch's 50 MB, and the
// fold runs synchronously (the arr-watch cron, the queue page, the Why?
// status). So each list is deduped through a Set, kept to its cap, and READ at
// most PROJECTION_SCAN_FACTOR times its cap (guardrail 5i) — namesOf, from
// arr-parse, does the same for languages and custom formats.

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
  quality?: { quality?: { name?: unknown } | null; revision?: { version?: unknown; real?: unknown; isRepack?: unknown } | null } | null;
  languages?: unknown;
  /** Sonarr v3's shape: ONE language object, no `languages` array. */
  language?: unknown;
  customFormats?: unknown;
  customFormatScore?: unknown;
  outputPath?: unknown;
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

// The first MAX_MESSAGES distinct messages, in order. Collection stops at the
// cap, and each list (statusMessages, and every entry's messages) is read at
// most PROJECTION_SCAN_FACTOR × the cap deep.
function messagesOf(r: QueueRecord): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  const scan = MAX_MESSAGES * PROJECTION_SCAN_FACTOR;
  const push = (m: unknown) => {
    const s = safeMessage(m, MAX_MESSAGE_LEN) ?? "";
    if (s && !seen.has(s)) {
      seen.add(s);
      out.push(s);
    }
  };
  push(r.errorMessage);
  if (Array.isArray(r.statusMessages)) {
    const list = r.statusMessages as Array<{ title?: unknown; messages?: unknown } | null>;
    for (let i = 0, n = Math.min(list.length, scan); i < n && out.length < MAX_MESSAGES; i++) {
      const sm = list[i];
      if (!sm || typeof sm !== "object") continue;
      const messages = sm.messages;
      if (Array.isArray(messages) && messages.length > 0) {
        for (let j = 0, k = Math.min(messages.length, scan); j < k && out.length < MAX_MESSAGES; j++) push(messages[j]);
      } else push(sm.title);
    }
  }
  return out;
}

const scoreOf = (v: unknown): number | null => (typeof v === "number" && Number.isSafeInteger(v) ? v : null);

function toItem(service: QueueService, instance: string, r: QueueRecord, id: number): QueueItem {
  const media = service === "radarr" ? r.movie : r.series;
  const quality = qualityOf(r.quality);
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
    quality: quality.quality,
    qualityTags: quality.qualityTags,
    // Its `languages` list, or Sonarr v3's ONE `language` object (QueueResource has no list there).
    languages: languageNamesOf(r),
    customFormats: namesOf(r.customFormats),
    customFormatScore: scoreOf(r.customFormatScore),
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
    outputPath: textOrNull(r.outputPath, 1_000),
    attention: needsAttention(r),
    pending: isPendingStatus(r.status),
    canChangeCategory: r.downloadClientHasPostImportCategory === true,
    requesters: [],
  };
}

const episodeKey = (e: QueueEpisode): string => `${e.seasonNumber}:${e.episodeNumber}`;

// Pipeline stages, the ones needing a hand first: the queue's order, and which
// of a folded download's records names its phase.
const PHASE_ORDER: Record<QueuePhase, number> = {
  importBlocked: 0, failed: 1, clientUnavailable: 2, importPending: 3, importing: 4,
  downloading: 5, paused: 6, queued: 7, delay: 8, unknown: 9,
};

// Folding a later episode record into the row its download already started.
// `episodeKeys` is the row's episodes as a Set: the folded list has no cap (one
// entry per record), so a scan of it per record was quadratic.
function mergeInto(row: QueueItem, next: QueueItem, episodeKeys: Set<string>): void {
  row.ids.push(...next.ids);
  for (const e of next.episodes) {
    const key = episodeKey(e);
    if (episodeKeys.has(key)) continue;
    episodeKeys.add(key);
    row.episodes.push(e);
  }
  for (const m of next.messages) if (row.messages.length < MAX_MESSAGES && !row.messages.includes(m)) row.messages.push(m);
  row.attention ||= next.attention;
  // The most pressing record's phase, like attention: a pack with one import
  // blocked episode is blocked, not "downloading" because its first record was.
  if (PHASE_ORDER[next.phase] < PHASE_ORDER[row.phase]) row.phase = next.phase;
  row.canChangeCategory ||= next.canChangeCategory;
  // One release, so these normally repeat; a record that lacked them must not blank the row.
  for (const l of next.languages) if (row.languages.length < MAX_LABELS && !row.languages.includes(l)) row.languages.push(l);
  for (const f of next.customFormats) if (row.customFormats.length < MAX_LABELS && !row.customFormats.includes(f)) row.customFormats.push(f);
  row.customFormatScore ??= next.customFormatScore;
  row.outputPath ??= next.outputPath;
  row.quality ??= next.quality;
  if (row.qualityTags.length === 0) row.qualityTags = next.qualityTags;
  row.downloadClient ??= next.downloadClient;
  row.indexer ??= next.indexer;
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
  const byDownload = new Map<string, { row: QueueItem; episodeKeys: Set<string> }>();
  // The queue is read page by page while it changes (the arr's default order is
  // time left, which moves with progress), so a record can land on two pages.
  // One record is one record: a repeat would be a second row with the same key,
  // and a Sonarr pack would list its id twice.
  const seenIds = new Set<number>();
  for (const raw of records) {
    if (!raw || typeof raw !== "object") continue;
    const r = raw as QueueRecord;
    const id = posInt(r.id);
    if (id === null || seenIds.has(id)) continue;
    seenIds.add(id);
    const item = toItem(service, instance, r, id);
    const key = service === "sonarr" && item.downloadId ? `${item.downloadId}:${item.arrMediaId ?? ""}` : null;
    const existing = key ? byDownload.get(key) : undefined;
    if (existing) {
      mergeInto(existing.row, item, existing.episodeKeys);
      continue;
    }
    if (key) byDownload.set(key, { row: item, episodeKeys: new Set(item.episodes.map(episodeKey)) });
    rows.push(item);
  }
  for (const row of rows) row.episodes.sort((a, b) => a.seasonNumber - b.seasonNumber || a.episodeNumber - b.episodeNumber);
  return rows;
}

/** Rows needing attention first, then by pipeline stage, then by title (stable across polls). */
export function sortQueueItems(items: QueueItem[]): QueueItem[] {
  return items.sort((a, b) => {
    if (a.attention !== b.attention) return a.attention ? -1 : 1;
    if (a.phase !== b.phase) return PHASE_ORDER[a.phase] - PHASE_ORDER[b.phase];
    // Never order by time left: it changes on every poll, so rows swapped
    // places under the admin on each auto-refresh.
    return a.mediaTitle.localeCompare(b.mediaTitle) || (a.ids[0] ?? 0) - (b.ids[0] ?? 0);
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

/**
 * The record ids a removal sends: ONE per download. A folded Sonarr pack
 * carries one record id per episode, but any one of them resolves the whole
 * tracked download on v3 and v4 (MarkAsFailed, RemoveItem and StopTracking
 * act per download). Sonarr v3's bulk remove loops over the ids with no
 * dedupe and stops tracking only after the loop, so N ids blocklisted the
 * release N times and asked the client to remove it N times (Deluge errors on
 * the repeat); v4 dedupes by downloadId anyway. A pending row has one id.
 */
export function removalIds(row: Pick<QueueItem, "ids">): number[] {
  return row.ids.slice(0, 1);
}

/**
 * Posted queue record ids are names for downloads the instance currently
 * holds — never forwarded blindly (guardrail 5e). Match any overlap with a
 * folded row's ids (a Sonarr pack is one download), then send ONE id per
 * download (`removalIds`) so Sonarr v3 blocklists once (guardrail 5c). An id
 * the live read does not have is dropped; an empty result means everything
 * posted is already gone.
 */
export function liveRemovalIds(rows: readonly QueueItem[], requested: readonly number[]): number[] {
  return selectLiveIds(rows, requested, () => true);
}

/**
 * Same selection as `liveRemovalIds`, restricted to releases the arr is still
 * HOLDING (`pending`). Grab is the arr's bulk POST on those rows; a downloading
 * or imported id the page still has must not be forwarded.
 */
export function liveGrabIds(rows: readonly QueueItem[], requested: readonly number[]): number[] {
  return selectLiveIds(rows, requested, (row) => row.pending);
}

function selectLiveIds(
  rows: readonly QueueItem[],
  requested: readonly number[],
  eligible: (row: QueueItem) => boolean,
): number[] {
  const want = new Set(requested);
  const out: number[] = [];
  const seen = new Set<number>();
  for (const row of rows) {
    if (!eligible(row)) continue;
    if (!row.ids.some((id) => want.has(id))) continue;
    const [id] = removalIds(row);
    if (id !== undefined && !seen.has(id)) {
      seen.add(id);
      out.push(id);
    }
  }
  return out;
}

/**
 * Whether a "Blocklist" (skipRedownload=true) on this instance can promise "no
 * new search". Sonarr v3 reads only removeFromClient and blocklist
 * (skipRedownload and changeCategory are ignored), so a blocklist there always
 * runs its redownload-failed search when that setting is on: `"searches"`.
 * Sonarr v4+ and Radarr (not gated — unverified against its source) honour it:
 * `"skipped"`. A Sonarr whose version is not known — the health read still
 * running, failed, no version reported, or unparseable — is `"unknown"`: the
 * dialog must neither promise "no new search" nor call the instance v3.
 */
export type BlocklistRedownload = "skipped" | "searches" | "unknown";

export function blocklistRedownload(service: QueueService, version: string | null | undefined): BlocklistRedownload {
  if (service !== "sonarr") return "skipped";
  const major = typeof version === "string" ? /^\s*(\d+)\./.exec(version) : null;
  if (major === null) return "unknown";
  return Number(major[1]) >= 4 ? "skipped" : "searches";
}

export type RecheckError = { service: QueueService; instance: string; kind?: unknown };

/**
 * What a Re-check downloads answer means for the page: how many instances
 * were asked, which refused, and whether every one did — the route answers
 * 202 even then, so a 2xx alone is not success.
 */
export function recheckOutcome(answer: { instances?: unknown; errors?: unknown } | null | undefined): {
  asked: number;
  failed: RecheckError[];
  allFailed: boolean;
} {
  const instances = typeof answer?.instances === "number" && Number.isSafeInteger(answer.instances) && answer.instances > 0 ? answer.instances : 0;
  const failed: RecheckError[] = [];
  if (Array.isArray(answer?.errors)) {
    for (const e of answer.errors as Array<{ service?: unknown; instance?: unknown; kind?: unknown } | null>) {
      if (!e || (e.service !== "radarr" && e.service !== "sonarr") || typeof e.instance !== "string") continue;
      failed.push({ service: e.service, instance: e.instance, kind: e.kind });
    }
  }
  const asked = Math.max(0, instances - failed.length);
  return { asked, failed, allFailed: failed.length > 0 && asked === 0 };
}

/** A download id as Radarr/Sonarr report it (a client hash or job id): printable ASCII, bounded. */
export function isDownloadId(v: unknown): v is string {
  return typeof v === "string" && /^[\x21-\x7e]{1,200}$/.test(v);
}
