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
    case "completed": return "importPending";
    // "warning" is a downloading item the client flagged (stalled, no
    // connections); the attention flag carries the warning itself.
    case "warning": return "downloading";
  }
  return "unknown";
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
 * The bulk DELETE's query string. Every flag is sent explicitly: Radarr and
 * Sonarr default `removeFromClient` to TRUE, so an omitted flag is not "off".
 * With removeFromClient false and no blocklist the arr IGNORES the download
 * (stops tracking it, leaves it in the client), which is what "remove from the
 * queue only" means there.
 */
export function queueRemoveQuery(action: QueueRemoveAction, removeFromClient: boolean): string {
  const blocklist = action !== "remove";
  const skipRedownload = action !== "blocklistSearch";
  return new URLSearchParams({
    removeFromClient: String(removeFromClient),
    blocklist: String(blocklist),
    skipRedownload: String(skipRedownload),
    changeCategory: "false",
  }).toString();
}
