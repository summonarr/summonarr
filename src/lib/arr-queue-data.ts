// Admin → Download Queue: the data half. One live, paged /api/v3/queue read per
// configured Radarr and Sonarr instance (guardrail 32 — every instance, by its
// slug), folded and judged by the pure rules in arr-queue.ts, plus the mutations
// the page offers: removing a download (bulk DELETE) and grabbing a pending
// release (bulk POST). Posted ids NAME live records; they are never forwarded
// blindly (guardrail 5e). Every call goes through arrFetch (guardrail 5).
// Nothing is cached, and nothing in Summonarr is written except the audit row
// the route adds.
import { ArrResponseError, arrErrorMessage, arrFetch, arrFetchNoContent, getArrCfg, type ArrCfg } from "./arr";
import { ArrInstanceError, configuredArrCfg, enabledArrInstances, postArrCommand } from "./arr-admin";
import { settleArrInstances } from "./arr-instance-fanout";
import type { ArrErrorKind } from "./arr-error-kind";
import { pagedReadEnded } from "./arr-parse";
import { mapLimit } from "./concurrency";
import { forgetWarnOnChange, warnOnChange } from "./log-dedup";
import { prisma } from "./prisma";
import {
  effectiveImportRows,
  foldQueueRecords,
  importCandidates,
  ImportOverrideError,
  liveGrabIds,
  liveRemovalIds,
  manualImportFiles,
  mergeReprocessed,
  overrideNeeds,
  queueRemoveQuery,
  reprocessItems,
  selectedRawRows,
  sortQueueItems,
  type ImportCandidate,
  type ImportCatalog,
  type ImportMode,
  type ImportOverride,
  type QueueEpisode,
  type QueueItem,
  type QueueRemoveAction,
  type QueueRemoveMethod,
  type QueueService,
} from "./arr-queue";

export function parseQueueService(v: unknown): QueueService | null {
  return v === "radarr" || v === "sonarr" ? v : null;
}

export interface QueueReport {
  /** Configured instances that were read, per service (an integration switched off reads none). */
  instances: Array<{ service: QueueService; slug: string; name: string }>;
  /** Instances whose queue could not be read — their downloads are absent, not finished. */
  errors: Array<{ service: QueueService; instance: string; error: string; kind: ArrErrorKind }>;
  items: QueueItem[];
  /**
   * Present only when non-empty: instances whose queue ran past the page
   * ceiling, so only the first `read` of `total` records are listed — the
   * queue shown is incomplete, never complete. (`total` is the records read
   * when the arr reported no total: a lower bound.)
   */
  truncated?: Array<{ service: QueueService; instance: string; read: number; total: number }>;
}

// Same page shape and ceiling as the queue-membership reads in arr.ts: 250 per
// page, at most 40 pages (10k records) per instance. Exported for the paged
// reader's bounds pin (tests/arr-projection-bounds.test.mts).
export const PAGE_SIZE = 250;
const QUEUE_READ_TIMEOUT_MS = 20_000;
export const MAX_PAGES = 40;
// The page's whole read of one instance: each page has its own 20 s, but a
// slow instance on every one of 40 pages held the page (and its background
// refresh) for many minutes. Past this it answers what it read, marked
// incomplete — inside a reverse proxy's ~60 s.
export const QUEUE_LISTING_BUDGET_MS = 45_000;
const LISTING_CONCURRENCY = 4;
const REQUESTER_CHUNK = 1_000;
const MAX_REQUESTERS_PER_ROW = 5;

/** One instance's queue as one paged walk read it. */
export interface QueueListing {
  records: unknown[];
  /** The arr's totalRecords — or the records read when it reported none (a lower bound). */
  total: number;
  /** The page ceiling, not the end of the list, stopped the read: `records` is the first MAX_PAGES × PAGE_SIZE. */
  truncated: boolean;
  /** The signal stopped the read before its end: `records` is partial. */
  stopped: boolean;
  /** Pages read. */
  pages: number;
}

/**
 * One instance's queue, page by page, on a connection the caller resolved.
 * `signal` (the arr monitor's — guardrail 41 — or the page's read budget):
 * once it aborts no further page is read and the page in flight is cancelled;
 * the walk RETURNS what it has, marked `stopped`, and never throws for the abort.
 *
 * Offset paging over a queue that changes between pages can skip a record (one
 * leaving an earlier page shifts the next page's first record back onto the
 * page already read). The arr offers no cursor, so the listing accepts it: the
 * page's next re-read shows the record, and a write re-reads before it calls a
 * posted id gone (liveQueueRows).
 */
export async function readQueueListing(cfg: ArrCfg, service: QueueService, signal?: AbortSignal): Promise<QueueListing> {
  const records: unknown[] = [];
  let total: number | null = null;
  let ended = false;
  let stopped = false;
  let pages = 0;
  for (let page = 1; page <= MAX_PAGES; page++) {
    const res = signal?.aborted ? STOPPED : await readQueuePage(cfg, service, page, signal);
    if (res === STOPPED) {
      stopped = true;
      break;
    }
    pages = page;
    const batch = Array.isArray(res?.records) ? res.records : [];
    // At most a page's worth per page (an honest arr never sends more), appended
    // one by one: a spread push of a hostile page past ~125k records throws
    // RangeError, and an uncapped page would let one answer outgrow the page cap.
    for (const r of batch.slice(0, PAGE_SIZE)) records.push(r);
    total = typeof res?.totalRecords === "number" && Number.isFinite(res.totalRecords) ? res.totalRecords : null;
    if (pagedReadEnded(page, PAGE_SIZE, batch.length, res?.totalRecords)) {
      ended = true;
      break;
    }
  }
  return {
    records,
    total: total ?? records.length,
    truncated: !ended && !stopped && (total === null || total > records.length),
    stopped,
    pages,
  };
}

// The walk was stopped by its signal (distinct from an empty answer, which ends it).
const STOPPED = Symbol("queue-read-stopped");

// One page of the walk, or STOPPED when `signal` cancelled it — the walk
// returns, never throws, on an abort.
async function readQueuePage(
  cfg: ArrCfg,
  service: QueueService,
  page: number,
  signal: AbortSignal | undefined,
): Promise<{ records?: unknown; totalRecords?: unknown } | null | typeof STOPPED> {
  // Unknown items — downloads the arr can't match to a title — are included:
  // they are the ones that never import on their own and need an admin.
  const include = service === "radarr"
    ? "includeMovie=true&includeUnknownMovieItems=true"
    : "includeSeries=true&includeEpisode=true&includeUnknownSeriesItems=true";
  try {
    // Quiet: loadDownloadQueue reports a failed instance once (warnOnChange).
    // The page re-reads every 20 s: a dark instance answers "unreachable" well
    // inside that instead of holding every poll for the 30 s default.
    return await arrFetch<{ records?: unknown; totalRecords?: unknown }>(
      cfg, `/api/v3/queue?page=${page}&pageSize=${PAGE_SIZE}&sortKey=added&sortDirection=ascending&${include}`,
      { quietErrors: true, timeoutMs: QUEUE_READ_TIMEOUT_MS, ...(signal ? { signal } : {}) },
    );
  } catch (err) {
    if (signal?.aborted) return STOPPED;
    throw err;
  }
}

// readQueueListing by instance slug — the seam the paged reader's pins
// (bounds, abort) drive it through; production callers resolve their own
// connection. The whole listing comes back, so a caller can't mistake a
// stopped or truncated walk for the full queue.
export async function readQueuePages(service: QueueService, instance: string, signal?: AbortSignal): Promise<QueueListing> {
  const cfg = await getArrCfg(service, instance);
  if (!cfg) throw new Error("not configured");
  return readQueueListing(cfg, service, signal);
}

// Who asked for each title: the requesters of a non-declined request (pending,
// approved or available) for the same title on the same instance. Cosmetic — a
// failed read leaves the column empty rather than failing the page. The rows
// are indexed ONCE by (media type, instance, id) — a TV request found by both
// its tmdb and its tvdb id lands in one name Set — so each item is two lookups,
// never a scan of every request (guardrail 5i: linear over a 10k-record queue).
// The index key of one title on one instance: written from the request rows,
// read back per queue item — one format for both.
const requesterKey = (mediaType: "MOVIE" | "TV", instance: string, id: { tmdb: number } | { tvdb: number }): string =>
  `${mediaType}|${instance}|${"tmdb" in id ? `tmdb:${id.tmdb}` : `tvdb:${id.tvdb}`}`;

async function attachRequesters(items: QueueItem[]): Promise<void> {
  const movieIds = [...new Set(items.filter((i) => i.service === "radarr" && i.tmdbId !== null).map((i) => i.tmdbId as number))];
  const tvTmdbIds = [...new Set(items.filter((i) => i.service === "sonarr" && i.tmdbId !== null).map((i) => i.tmdbId as number))];
  const tvdbIds = [...new Set(items.filter((i) => i.service === "sonarr" && i.tvdbId !== null).map((i) => i.tvdbId as number))];
  if (movieIds.length + tvTmdbIds.length + tvdbIds.length === 0) return;
  const byTitle = new Map<string, Set<string>>();
  const index = (key: string, name: string) => {
    const names = byTitle.get(key);
    if (names) names.add(name);
    else byTitle.set(key, new Set([name]));
  };
  const read = async (mediaType: "MOVIE" | "TV", by: "tmdbId" | "tvdbId", ids: number[]) => {
    for (let i = 0; i < ids.length; i += REQUESTER_CHUNK) {
      const rows = await prisma.mediaRequest.findMany({
        where: { status: { not: "DECLINED" }, mediaType, [by]: { in: ids.slice(i, i + REQUESTER_CHUNK) } },
        select: { tmdbId: true, tvdbId: true, mediaType: true, arrInstance: true, user: { select: { name: true, email: true } } },
      });
      for (const r of rows) {
        const name = r.user.name?.trim() || r.user.email;
        const mediaType = r.mediaType === "MOVIE" ? "MOVIE" : "TV";
        index(requesterKey(mediaType, r.arrInstance, { tmdb: r.tmdbId }), name);
        if (r.tvdbId !== null) index(requesterKey(mediaType, r.arrInstance, { tvdb: r.tvdbId }), name);
      }
    }
  };
  try {
    await read("MOVIE", "tmdbId", movieIds);
    await read("TV", "tmdbId", tvTmdbIds);
    await read("TV", "tvdbId", tvdbIds);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    warnOnChange("queue:requesters", message, `[queue] requester lookup failed: ${message}`);
    return;
  }
  forgetWarnOnChange("queue:requesters");
  for (const item of items) {
    const mediaType = item.service === "radarr" ? "MOVIE" : "TV";
    const names = new Set<string>();
    const keys = [
      item.tmdbId !== null ? requesterKey(mediaType, item.instance, { tmdb: item.tmdbId }) : null,
      item.tvdbId !== null ? requesterKey(mediaType, item.instance, { tvdb: item.tvdbId }) : null,
    ];
    for (const key of keys) {
      for (const name of (key && byTitle.get(key)) || []) {
        if (names.size >= MAX_REQUESTERS_PER_ROW) break;
        names.add(name);
      }
    }
    item.requesters = [...names];
  }
}

// One instance's listing for the page, within QUEUE_LISTING_BUDGET_MS. A budget
// that ran out before ANY page answered is a timed-out instance; after some,
// what was read is listed and marked incomplete.
async function readQueueForPage(service: QueueService, instance: string): Promise<{ listing: QueueListing; rows: QueueItem[]; cut: boolean }> {
  const cfg = await getArrCfg(service, instance);
  if (!cfg) throw new Error("not configured");
  const budget = AbortSignal.timeout(QUEUE_LISTING_BUDGET_MS);
  const listing = await readQueueListing(cfg, service, budget);
  if (listing.stopped && listing.pages === 0) {
    throw queueBudgetError();
  }
  return { listing, rows: foldQueueRecords(service, instance, listing.records), cut: listing.truncated || listing.stopped };
}

/** Every configured instance's queue, one row per download, attention first. */
export async function loadDownloadQueue(): Promise<QueueReport> {
  const instances: QueueReport["instances"] = await enabledArrInstances();
  // The page re-reads every 20s while open: an instance that stays down is
  // one unchanged condition, logged once until it changes (guardrail 7b).
  const outcomes = await settleArrInstances(instances, LISTING_CONCURRENCY, (inst) => readQueueForPage(inst.service, inst.slug), {
    key: (inst) => `queue:${inst.service}:${inst.slug}`,
    message: (inst, error) => `[queue] ${inst.service} instance "${inst.slug}" queue read failed: ${error}`,
  });
  const report: QueueReport = { instances, errors: [], items: [] };
  const truncated: NonNullable<QueueReport["truncated"]> = [];
  for (const o of outcomes) {
    const { service, slug } = o.inst;
    if (!o.ok) {
      report.errors.push({ service, instance: slug, error: o.error, kind: o.kind });
      continue;
    }
    // One by one, never a spread push of an upstream-sized list (guardrail 5i).
    for (const row of o.value.rows) report.items.push(row);
    const { listing, cut } = o.value;
    if (cut) truncated.push({ service, instance: slug, read: listing.records.length, total: Math.max(listing.total, listing.records.length) });
  }
  if (truncated.length > 0) report.truncated = truncated;
  await attachRequesters(report.items);
  sortQueueItems(report.items);
  return report;
}

export class QueueInstanceError extends Error {}
/** Posted ids matched nothing (still pending, for a grab) on a fresh read of that instance's queue. */
export class QueueGoneError extends Error {}

// The instance must be a CONFIGURED one: a slug is never turned into a
// Setting-key read for an instance the registry doesn't list (guardrail 32 —
// configuredArrCfg), refused here as this module's own error.
async function configuredCfg(service: QueueService, instance: string): Promise<ArrCfg> {
  try {
    return await configuredArrCfg(service, instance);
  } catch (err) {
    if (err instanceof ArrInstanceError) throw new QueueInstanceError(instance);
    throw err;
  }
}

// The fresh read a write's posted ids are matched against. Offset paging over a
// queue that changes between pages can SKIP a record: one leaving an earlier
// page shifts the next page's first record back onto the page already read. So
// a walk of several pages that misses a posted id is read again ONCE before the
// id is called gone. Every id sent is still named by a fresh read (5c/5e).
async function liveQueueRows(
  cfg: ArrCfg,
  service: QueueService,
  instance: string,
  ids: readonly number[],
): Promise<{ rows: QueueItem[]; cut: boolean }> {
  // One budget covers both reads. A walk the budget cut short is never trusted
  // as "gone": nothing read means a timeout, and a partial read only matches
  // what it did see (a posted id it missed is dropped, never sent). `cut` tells
  // the caller the answer is partial, so "nothing matched" is a timeout there,
  // never "gone".
  const budget = AbortSignal.timeout(QUEUE_LISTING_BUDGET_MS);
  const first = await readQueueListing(cfg, service, budget);
  if (first.stopped && first.pages === 0) throw queueBudgetError();
  const rows = foldQueueRecords(service, instance, first.records);
  if (first.stopped) return { rows, cut: true };
  if (first.pages <= 1) return { rows, cut: false };
  const live = new Set<number>();
  for (const row of rows) for (const id of row.ids) live.add(id);
  if (ids.every((id) => live.has(id))) return { rows, cut: false };
  const second = await readQueueListing(cfg, service, budget);
  // A cut second read never replaces the complete first one: what the first
  // read named is still sent, and an id it missed is not called gone.
  if (second.stopped) return { rows, cut: true };
  return { rows: foldQueueRecords(service, instance, second.records), cut: false };
}

function queueBudgetError(): Error {
  const err = new Error(`queue read timed out after ${QUEUE_LISTING_BUDGET_MS / 1000}s`);
  err.name = "TimeoutError";
  return err;
}

/**
 * Remove downloads from one instance's queue through Radarr/Sonarr's bulk
 * DELETE — ONE call. Posted ids are names for downloads the instance currently
 * reports: a fresh read (liveQueueRows) is folded and intersected first, then
 * ONE record id per matched download is sent (`liveRemovalIds` / 5c). An API
 * caller that posts every episode id of a Sonarr pack still blocklists once.
 * Throws `QueueGoneError` when nothing posted is still in the queue, so the
 * route 409s without sending a DELETE.
 */
export async function removeFromQueue(
  service: QueueService,
  instance: string,
  ids: readonly number[],
  action: QueueRemoveAction,
  method: QueueRemoveMethod,
): Promise<number[]> {
  const cfg = await configuredCfg(service, instance);
  const live = await liveQueueRows(cfg, service, instance, ids);
  const idsToSend = liveRemovalIds(live.rows, ids);
  if (idsToSend.length === 0) throw live.cut ? queueBudgetError() : new QueueGoneError();
  await arrFetchNoContent(cfg, `/api/v3/queue/bulk?${queueRemoveQuery(action, method)}`, {
    method: "DELETE",
    body: JSON.stringify({ ids: idsToSend }),
  });
  return idsToSend;
}

/**
 * Send releases Radarr/Sonarr are HOLDING (a delay profile, an unavailable
 * client, a fallback) to the download client now — the arr's own "Grab" on a
 * pending queue item. Posted ids are names: a fresh read (liveQueueRows) is folded
 * and intersected first (`liveGrabIds` — only still-pending rows, ONE id per
 * download), then ONE bulk POST. Throws `QueueGoneError` when nothing posted is
 * still pending, so the route 409s without sending a grab.
 */
export async function grabPending(service: QueueService, instance: string, ids: readonly number[]): Promise<number[]> {
  const cfg = await configuredCfg(service, instance);
  const live = await liveQueueRows(cfg, service, instance, ids);
  const idsToSend = liveGrabIds(live.rows, ids);
  if (idsToSend.length === 0) throw live.cut ? queueBudgetError() : new QueueGoneError();
  await arrFetchNoContent(cfg, "/api/v3/queue/grab/bulk", { method: "POST", body: JSON.stringify({ ids: idsToSend }) });
  return idsToSend;
}

/**
 * Ask every configured, enabled instance to re-check its downloads now
 * (RefreshMonitoredDownloads — the arr runs it every minute on its own). The
 * way to retry an import after fixing what blocked it (a permission, a disk, a
 * mapping changed in the arr) without waiting. Commands are queued, not awaited.
 */
export async function recheckDownloads(): Promise<{ instances: number; errors: Array<{ service: QueueService; instance: string; error: string; kind: ArrErrorKind }> }> {
  const instances = await enabledArrInstances();
  const outcomes = await settleArrInstances(instances, LISTING_CONCURRENCY, async (inst) => {
    const cfg = await getArrCfg(inst.service, inst.slug);
    if (!cfg) throw new Error("not configured");
    await postArrCommand(cfg, { name: "RefreshMonitoredDownloads" });
  });
  const errors: Array<{ service: QueueService; instance: string; error: string; kind: ArrErrorKind }> = [];
  for (const o of outcomes) {
    if (!o.ok) errors.push({ service: o.inst.service, instance: o.inst.slug, error: o.error, kind: o.kind });
  }
  return { instances: instances.length, errors };
}

// ── importing a blocked download ─────────────────────────────────────────────

const manualImportPath = (downloadId: string) => `/api/v3/manualimport?${new URLSearchParams({ downloadId }).toString()}`;

export interface ImportChoice { id: number; name: string }

/** The instance's qualities (in its own weight order) and languages — the editor's dropdowns. */
async function readQualities(cfg: ArrCfg): Promise<Map<number, { name: string; quality: unknown }>> {
  const defs = await arrFetch<unknown>(cfg, "/api/v3/qualitydefinition");
  const out = new Map<number, { name: string; quality: unknown }>();
  if (!Array.isArray(defs)) return out;
  const sorted = [...(defs as Array<{ weight?: unknown; title?: unknown; quality?: { id?: unknown; name?: unknown } | null } | null>)]
    .filter((d): d is { weight?: unknown; title?: unknown; quality: { id?: unknown; name?: unknown } } => !!d && !!d.quality && typeof d.quality === "object")
    .sort((a, b) => (typeof a.weight === "number" ? a.weight : 0) - (typeof b.weight === "number" ? b.weight : 0));
  for (const d of sorted) {
    const id = d.quality.id;
    if (typeof id !== "number" || !Number.isSafeInteger(id)) continue;
    const name = typeof d.title === "string" && d.title ? d.title : typeof d.quality.name === "string" ? d.quality.name : String(id);
    out.set(id, { name: name.slice(0, 100), quality: d.quality });
  }
  return out;
}

async function readLanguages(cfg: ArrCfg): Promise<Map<number, { id: number; name: string }>> {
  const langs = await arrFetch<unknown>(cfg, "/api/v3/language");
  const out = new Map<number, { id: number; name: string }>();
  if (!Array.isArray(langs)) return out;
  for (const l of langs as Array<{ id?: unknown; name?: unknown } | null>) {
    if (typeof l?.id === "number" && Number.isSafeInteger(l.id) && typeof l.name === "string") out.set(l.id, { id: l.id, name: l.name.slice(0, 100) });
  }
  return out;
}

export interface ImportListing {
  files: ImportCandidate[];
  /** The instance's own choices for the per-file editor. Empty when they could not be read. */
  qualities: ImportChoice[];
  languages: ImportChoice[];
}

// A dropdown's choices, or none when the instance couldn't list them — the
// dialog then offers no correction for that field. Logged once per unchanged
// condition (guardrail 7b): the dialog re-reads on every open.
async function choicesOrEmpty<K, V>(service: QueueService, instance: string, what: "qualities" | "languages", read: Promise<Map<K, V>>): Promise<Map<K, V>> {
  const logKey = `queue:import-${what}:${service}:${instance}`;
  try {
    const out = await read;
    forgetWarnOnChange(logKey);
    return out;
  } catch (err) {
    const error = arrErrorMessage(err);
    warnOnChange(logKey, error, `[queue] ${service} instance "${instance}" ${what} for the import editor could not be read: ${error}`);
    return new Map<K, V>();
  }
}

/**
 * The files Radarr/Sonarr found in one download, what each matched to and why
 * it was refused, plus the instance's qualities and languages for the editor.
 * The two lists are conveniences: a failure there leaves them empty rather
 * than failing the listing.
 */
export async function loadImportCandidates(service: QueueService, instance: string, downloadId: string): Promise<ImportListing> {
  const cfg = await configuredCfg(service, instance);
  const [raw, qualities, languages] = await Promise.all([
    arrFetch<unknown>(cfg, manualImportPath(downloadId)),
    choicesOrEmpty(service, instance, "qualities", readQualities(cfg)),
    choicesOrEmpty(service, instance, "languages", readLanguages(cfg)),
  ]);
  return {
    files: importCandidates(service, raw),
    qualities: [...qualities].map(([id, q]) => ({ id, name: q.name })),
    languages: [...languages.values()].map((l) => ({ id: l.id, name: l.name })),
  };
}

/** Nothing the admin chose is (still) importable — imported meanwhile, gone, or never matched. */
export class NothingToImportError extends Error {}

/** Distinct titles one import's corrections may re-match to (each is a catalog read). */
export const MAX_CATALOG_TITLES = 20;
// Catalog reads in flight at once (guardrail 31): a preview and its import
// each read every title named, and a slow arr serialized them all.
const CATALOG_CONCURRENCY = 4;

// Exactly the catalog the corrections need, read from the instance itself: a
// movie/series the instance doesn't have, an episode of another series, a
// quality or language it doesn't define, is refused (ImportOverrideError) by
// applyImportOverride rather than sent upstream. Past MAX_CATALOG_TITLES the
// request is refused as such ("tooManyTitles") before any read.
async function loadCatalog(cfg: ArrCfg, rows: ReturnType<typeof selectedRawRows>): Promise<ImportCatalog> {
  const needs = overrideNeeds(rows);
  if (needs.movieIds.length + needs.seriesIds.length > MAX_CATALOG_TITLES) throw new ImportOverrideError("tooManyTitles");
  const [qualities, languages] = await Promise.all([
    needs.qualities ? readQualities(cfg) : Promise.resolve(new Map<number, { name: string; quality: unknown }>()),
    needs.languages ? readLanguages(cfg) : Promise.resolve(new Map<number, { id: number; name: string }>()),
  ]);
  // A few titles at a time; the first non-404 failure fails the call (mapLimit
  // stops claiming titles after it).
  const movies = await readCatalogMovies(cfg, needs.movieIds);
  const series = await readCatalogSeries(cfg, needs.seriesIds);
  return {
    qualities: new Map([...qualities].map(([k, v]) => [k, v.quality])),
    languages,
    movies,
    series,
  };
}

// A title the instance doesn't have (404) is absent from the catalog — the
// correction naming it is then refused — never a failed call.
async function orNotFound<T>(p: Promise<T>): Promise<T | null> {
  try {
    return await p;
  } catch (err) {
    if (err instanceof ArrResponseError && err.status === 404) return null;
    throw err;
  }
}

async function readCatalogMovies(cfg: ArrCfg, ids: readonly number[]): Promise<Map<number, { id: number; title: string; year: number | null }>> {
  const movies = new Map<number, { id: number; title: string; year: number | null }>();
  const rows = await mapLimit(ids, CATALOG_CONCURRENCY, (id) =>
    orNotFound(arrFetch<{ id?: unknown; title?: unknown; year?: unknown }>(cfg, `/api/v3/movie/${id}`)),
  );
  ids.forEach((id, i) => {
    const m = rows[i];
    if (m && m.id === id) movies.set(id, { id, title: typeof m.title === "string" ? m.title : String(id), year: typeof m.year === "number" && m.year > 0 ? m.year : null });
  });
  return movies;
}

// A series' episodes are read only once the series itself answered.
async function readCatalogSeries(cfg: ArrCfg, ids: readonly number[]): Promise<Map<number, { id: number; title: string; episodes: Map<number, QueueEpisode> }>> {
  const series = new Map<number, { id: number; title: string; episodes: Map<number, QueueEpisode> }>();
  const rows = await mapLimit(ids, CATALOG_CONCURRENCY, async (id) => {
    const sr = await orNotFound(arrFetch<{ id?: unknown; title?: unknown }>(cfg, `/api/v3/series/${id}`));
    if (!sr || sr.id !== id) return null;
    const eps = await arrFetch<unknown>(cfg, `/api/v3/episode?seriesId=${id}`);
    const episodes = new Map<number, QueueEpisode>();
    if (Array.isArray(eps)) {
      for (const e of eps as Array<{ id?: unknown; seasonNumber?: unknown; episodeNumber?: unknown } | null>) {
        if (typeof e?.id === "number" && typeof e.seasonNumber === "number" && typeof e.episodeNumber === "number") {
          episodes.set(e.id, { seasonNumber: e.seasonNumber, episodeNumber: e.episodeNumber });
        }
      }
    }
    return { id, title: typeof sr.title === "string" ? sr.title : String(id), episodes };
  });
  for (const sr of rows) if (sr) series.set(sr.id, sr);
  return series;
}

async function correctedRows(service: QueueService, cfg: ArrCfg, downloadId: string, selections: ReadonlyMap<string, ImportOverride>) {
  const raw = await arrFetch<unknown>(cfg, manualImportPath(downloadId));
  const catalog = await loadCatalog(cfg, selectedRawRows(raw, selections));
  return effectiveImportRows(service, raw, selections, catalog);
}

/**
 * The chosen files with the admin's corrections applied, RE-JUDGED by the arr
 * (its manual-import reprocess) — fresh refusal reasons and, for Sonarr, the
 * episodes it resolves. `rechecked` is false when the arr couldn't reprocess
 * (an older version without the endpoint, or nothing reprocessable chosen):
 * the corrections are still shown, with the arr's earlier verdict.
 */
export async function previewImport(
  service: QueueService,
  instance: string,
  downloadId: string,
  selections: ReadonlyMap<string, ImportOverride>,
): Promise<{ files: ImportCandidate[]; rechecked: boolean }> {
  const cfg = await configuredCfg(service, instance);
  const rows = await correctedRows(service, cfg, downloadId, selections);
  const items = reprocessItems(service, rows, downloadId);
  let answer: unknown = null;
  let rechecked = false;
  if (items.length > 0) {
    try {
      answer = await arrFetch<unknown>(cfg, "/api/v3/manualimport", { method: "POST", body: JSON.stringify(items) });
      rechecked = true;
    } catch (err) {
      if (!(err instanceof ArrResponseError) || (err.status !== 404 && err.status !== 405)) throw err;
    }
  }
  // Not re-judged: the arr's EARLIER refusal reasons stay on show (the dialog
  // says they predate the edit) — blanking them would read as "no objections".
  const merged = rechecked ? mergeReprocessed(rows, answer) : rows.map(({ row }) => row);
  return { files: importCandidates(service, merged), rechecked };
}

/**
 * Import the chosen files of one download (the arr's ManualImport command),
 * overriding the arr's own refusal, with the admin's corrections applied. The
 * list is RE-READ from the arr here and every correction is checked against
 * the instance's own catalogs — a path or object from the browser never
 * reaches the command (guardrail 5d). Returns once the command is queued; the
 * arr imports in the background and the queue row moves to importing/imported.
 */
export async function importFromQueue(
  service: QueueService,
  instance: string,
  downloadId: string,
  selections: ReadonlyMap<string, ImportOverride>,
  importMode: ImportMode,
): Promise<{ files: number }> {
  const cfg = await configuredCfg(service, instance);
  const files = manualImportFiles(service, await correctedRows(service, cfg, downloadId, selections), downloadId);
  if (files.length === 0) throw new NothingToImportError();
  await arrFetch<unknown>(cfg, "/api/v3/command", {
    method: "POST",
    body: JSON.stringify({ name: "ManualImport", importMode, files }),
  });
  return { files: files.length };
}

// ── the corrections' pickers ─────────────────────────────────────────────────

export interface ImportTarget { id: number; title: string; year: number | null }

/**
 * Titles the INSTANCE HAS that match a search — what a file can be re-matched
 * to (a manual import needs the movie/series in the arr already). The arr's own
 * lookup marks a library title with a positive id; the rest are dropped.
 */
export async function searchImportTargets(service: QueueService, instance: string, term: string): Promise<ImportTarget[]> {
  const cfg = await configuredCfg(service, instance);
  const path = service === "radarr" ? "/api/v3/movie/lookup" : "/api/v3/series/lookup";
  const rows = await arrFetch<unknown>(cfg, `${path}?${new URLSearchParams({ term }).toString()}`);
  if (!Array.isArray(rows)) return [];
  const out: ImportTarget[] = [];
  for (const r of rows as Array<{ id?: unknown; title?: unknown; year?: unknown } | null>) {
    if (typeof r?.id !== "number" || !Number.isSafeInteger(r.id) || r.id <= 0 || typeof r.title !== "string") continue;
    out.push({ id: r.id, title: r.title.slice(0, 300), year: typeof r.year === "number" && r.year > 0 ? r.year : null });
    if (out.length >= 25) break;
  }
  return out;
}

export interface ImportEpisodeChoice extends QueueEpisode { id: number; title: string; hasFile: boolean }

/** One Sonarr series' episodes, for picking what a file holds. */
export async function loadSeriesEpisodes(instance: string, seriesId: number): Promise<ImportEpisodeChoice[]> {
  const cfg = await configuredCfg("sonarr", instance);
  const rows = await arrFetch<unknown>(cfg, `/api/v3/episode?seriesId=${seriesId}`);
  if (!Array.isArray(rows)) return [];
  const out: ImportEpisodeChoice[] = [];
  for (const e of rows as Array<{ id?: unknown; seasonNumber?: unknown; episodeNumber?: unknown; title?: unknown; hasFile?: unknown } | null>) {
    if (typeof e?.id !== "number" || typeof e.seasonNumber !== "number" || typeof e.episodeNumber !== "number") continue;
    out.push({
      id: e.id,
      seasonNumber: e.seasonNumber,
      episodeNumber: e.episodeNumber,
      title: typeof e.title === "string" ? e.title.slice(0, 300) : "",
      hasFile: e.hasFile === true,
    });
  }
  return out.sort((a, b) => a.seasonNumber - b.seasonNumber || a.episodeNumber - b.episodeNumber);
}
