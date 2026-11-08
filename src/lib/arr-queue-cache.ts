// "Is this title in the download queue?" for the library scan and the download
// check: one paged walk of an instance's queue, cached for a few seconds and
// shared by concurrent misses. Every answer is tri-state: true, false, or null
// for "couldn't tell", which callers treat as still pending. Re-exported by
// arr.ts.
import { arrFetch, asRecord, singleFlight, type ArrCfg, type ArrRecord } from "./arr-client";
import { getCfg, type ArrVariant } from "./arr-config";
import { lookupSeriesIdsCached } from "./arr-id-map";
import { pagedReadEnded, posInt } from "./arr-parse";
import { check, v } from "./validate";

const QUEUE_STATE_TTL_MS = 15 * 1000;
const QUEUE_PAGE_SIZE = 250;
// A safety limit on the walk: 40 pages of 250 is 10,000 records. A queue longer
// than that is read as INCOMPLETE, never as all of it: a title past the cap would
// otherwise read "not downloading", and the library scan would run early.
export const QUEUE_MAX_PAGES = 40;

type QueueService = "radarr" | "sonarr";

/**
 * The titles in one instance's queue. `tvdbIds` is Sonarr's only (Radarr keys
 * on tmdbId). `unmapped` is true when some queued series carries no positive
 * tmdbId (Sonarr v3 never sends one; v4 leaves it 0 for a series it couldn't
 * map), so a tmdbId missing from `tmdbIds` proves nothing about that queue.
 * `complete` is false when the walk stopped before the end of the queue (the
 * page cap, or an arr that ignored the page size): a title missing from it is
 * then unknown, not absent.
 */
export interface QueueState {
  tmdbIds: Set<number>;
  tvdbIds: Set<number>;
  unmapped: boolean;
  complete: boolean;
}

const QUEUE_INCLUDE: Record<QueueService, string> = { radarr: "includeMovie=true", sonarr: "includeSeries=true" };
const QUEUE_LABEL: Record<QueueService, string> = { radarr: "Radarr", sonarr: "Sonarr" };

const QueuePage = v.object({ records: v.array(v.unknown()), totalRecords: v.optional(v.unknown()) });

// One cache per service and URL (`radarr::<url>` / `sonarr::<url>`), plus the
// read in flight for each key: concurrent misses (the download checks, the
// library scan, the sync backstop) share one paged walk.
const queueCache = new Map<string, { state: QueueState; expiresAt: number }>();
const queueInFlight = new Map<string, Promise<QueueState | null>>();

/** Fold one queue record into the state (pure; exported for the unit suite). */
export function foldQueueRecord(service: QueueService, record: ArrRecord, state: QueueState): void {
  if (service === "radarr") {
    const tmdbId = posInt(asRecord(record.movie)?.tmdbId);
    if (tmdbId !== null) state.tmdbIds.add(tmdbId);
    return;
  }
  const series = asRecord(record.series);
  if (!series) return;
  const tvdbId = posInt(series.tvdbId);
  if (tvdbId !== null) state.tvdbIds.add(tvdbId);
  const tmdbId = posInt(series.tmdbId);
  if (tmdbId !== null) state.tmdbIds.add(tmdbId);
  else if (tvdbId !== null) state.unmapped = true;
}

/**
 * Walk the queue page by page until the arr says it ended (pagedReadEnded:
 * totalRecords covered, an empty page, or — with no total — a short one).
 * Each page is read up to its page size: a page holding more is an arr that
 * ignored the size, whose later pages would repeat it, so the read stops there
 * as incomplete. An answer that isn't a queue page throws, like a failed read.
 */
async function readQueueState(cfg: ArrCfg, service: QueueService): Promise<QueueState> {
  const state: QueueState = { tmdbIds: new Set(), tvdbIds: new Set(), unmapped: false, complete: false };
  for (let page = 1; page <= QUEUE_MAX_PAGES; page++) {
    const parsed = check(QueuePage, await arrFetch<unknown>(cfg, `/api/v3/queue?page=${page}&pageSize=${QUEUE_PAGE_SIZE}&${QUEUE_INCLUDE[service]}`));
    if (!parsed.ok) throw new Error(`unusable queue page (${parsed.error})`);
    const { records, totalRecords } = parsed.value;
    for (let i = 0; i < records.length && i < QUEUE_PAGE_SIZE; i++) {
      const record = asRecord(records[i]);
      if (record) foldQueueRecord(service, record, state);
    }
    if (records.length > QUEUE_PAGE_SIZE) return state;
    if (pagedReadEnded(page, QUEUE_PAGE_SIZE, records.length, totalRecords)) {
      state.complete = true;
      return state;
    }
  }
  return state;
}

// Returns null when the queue could not be read AND no stale state exists, so
// callers don't mistake a fetch failure for an empty queue (which would yield
// false "not downloading" → spurious notifies / premature scans). A successful
// read (even empty) returns a state.
async function getQueueState(cfg: ArrCfg, service: QueueService): Promise<QueueState | null> {
  const cacheKey = `${service}::${cfg.url}`;
  const cached = queueCache.get(cacheKey);
  if (cached && cached.expiresAt > Date.now()) return cached.state;
  return singleFlight(queueInFlight, cacheKey, async () => {
    const now = Date.now();
    try {
      const state = await readQueueState(cfg, service);
      queueCache.set(cacheKey, { state, expiresAt: now + QUEUE_STATE_TTL_MS });
      return state;
    } catch (err) {
      const stale = queueCache.get(cacheKey);
      if (stale) {
        console.warn(`[arr] ${QUEUE_LABEL[service]} queue read failed, serving stale queue data:`, err instanceof Error ? err.message : err);
        return stale.state;
      }
      console.error(`[arr] ${QUEUE_LABEL[service]} queue read failed, no cache:`, err instanceof Error ? err.message : err);
      return null;
    }
  });
}

// Not found in a queue read: absent when the read covered the whole queue,
// unknown when it didn't.
const notFound = (queue: QueueState): false | null => (queue.complete ? false : null);

// Tri-state: true = in queue; false = confirmed not in queue (or no Radarr
// configured); null = couldn't determine (queue fetch failed, or the title isn't
// in the part of the queue that was read). Callers MUST treat null as "still
// pending", not "not downloading", or a queue outage fires false "download
// pending" notifies and premature scans.
export async function isMovieDownloadingInRadarr(tmdbId: number, variant: ArrVariant = ""): Promise<boolean | null> {
  const cfg = await getCfg("radarr", variant);
  if (!cfg) return false;
  try {
    const queue = await getQueueState(cfg, "radarr");
    if (queue === null) return null;
    return queue.tmdbIds.has(tmdbId) ? true : notFound(queue);
  } catch { return null; }
}

// The movies in the queue; null when unknown — the queue couldn't be read, or
// was longer than the walk reads.
export async function countRadarrQueue(variant: ArrVariant = ""): Promise<number | null> {
  try {
    const cfg = await getCfg("radarr", variant);
    if (!cfg) return null;
    const queue = await getQueueState(cfg, "radarr");
    if (queue === null || !queue.complete) return null;
    return queue.tmdbIds.size;
  } catch { return null; }
}

// Same tri-state contract as isMovieDownloadingInRadarr — null = unknown.
//
// Answered from the queue records' own tmdbId first (Sonarr v4 sends it on each
// record's series). `series/lookup` runs only when some queued series has no
// tmdbId — Sonarr v3, or a series it couldn't map — because only then can this
// title be in the queue without its tmdbId showing. The lookup makes Sonarr
// query its internet metadata service; when that stalled, every check here
// burned 30s and came back unknown, which the library scan reads as "still
// downloading" and retries. Its verified answer is reused for a while
// (lookupSeriesIdsCached), since the scan asks about the same show repeatedly.
export async function isSeriesDownloadingInSonarr(tmdbId: number, variant: ArrVariant = ""): Promise<boolean | null> {
  const cfg = await getCfg("sonarr", variant);
  if (!cfg) return false;
  try {
    const queue = await getQueueState(cfg, "sonarr");
    if (queue === null) return null;
    if (queue.tmdbIds.has(tmdbId)) return true;
    // Every queued series named its tmdbId and none is this one (an empty queue
    // included): Sonarr is not downloading it, whatever the lookup would say.
    if (!queue.unmapped) return notFound(queue);
    // An unresolved lookup is UNKNOWN, not "not in queue": a degraded Sonarr
    // `tmdb:` lookup plus a transient TMDB cross-reference failure also land
    // here, and a confident false fires a spurious "download pending" notify
    // for a series Sonarr may be actively downloading. The lookup's tvdbId is
    // held to a positive integer, so a malformed one can't become a confident
    // false either.
    const series = await lookupSeriesIdsCached(cfg, tmdbId);
    if (!series) return null;
    return queue.tvdbIds.has(series.tvdbId) ? true : notFound(queue);
  } catch { return null; }
}

// The series in the queue; null when unknown, as countRadarrQueue.
export async function countSonarrQueue(variant: ArrVariant = ""): Promise<number | null> {
  try {
    const cfg = await getCfg("sonarr", variant);
    if (!cfg) return null;
    const queue = await getQueueState(cfg, "sonarr");
    if (queue === null || !queue.complete) return null;
    return queue.tvdbIds.size;
  } catch { return null; }
}
