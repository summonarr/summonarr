// Admin → Download Queue: the data half. One live, paged /api/v3/queue read per
// configured Radarr and Sonarr instance (guardrail 32 — every instance, by its
// slug), folded and judged by the pure rules in arr-queue.ts, plus the one
// mutation the page offers: removing a download through Radarr/Sonarr's own
// bulk queue DELETE. Every call goes through arrFetch (guardrail 5). Nothing is
// cached, and nothing in Summonarr is written except the audit row the route adds.
import { ArrResponseError, arrErrorMessage, arrFetch, arrFetchNoContent, getArrCfg, type ArrCfg } from "./arr";
import { getSyncableArrInstances } from "./arr-instance-registry";
import { settleLimit } from "./concurrency";
import { isFeatureEnabled } from "./features";
import { forgetWarnOnChange, warnOnChange } from "./log-dedup";
import { prisma } from "./prisma";
import {
  effectiveImportRows,
  foldQueueRecords,
  importCandidates,
  ImportOverrideError,
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

export const QUEUE_SERVICES: readonly QueueService[] = ["radarr", "sonarr"];

export function parseQueueService(v: unknown): QueueService | null {
  return v === "radarr" || v === "sonarr" ? v : null;
}

export interface QueueReport {
  /** Configured instances that were read, per service (an integration switched off reads none). */
  instances: Array<{ service: QueueService; slug: string; name: string }>;
  /** Instances whose queue could not be read — their downloads are absent, not finished. */
  errors: Array<{ service: QueueService; instance: string; error: string }>;
  items: QueueItem[];
}

// Same page shape and ceiling as the queue-membership reads in arr.ts: 250 per
// page, at most 40 pages (10k records) per instance.
const PAGE_SIZE = 250;
const MAX_PAGES = 40;
const LISTING_CONCURRENCY = 4;
const REQUESTER_CHUNK = 1_000;
const MAX_REQUESTERS_PER_ROW = 5;

async function readQueuePages(service: QueueService, instance: string): Promise<unknown[]> {
  const cfg = await getArrCfg(service, instance);
  if (!cfg) throw new Error("not configured");
  // Unknown items — downloads the arr can't match to a title — are included:
  // they are the ones that never import on their own and need an admin.
  const include = service === "radarr"
    ? "includeMovie=true&includeUnknownMovieItems=true"
    : "includeSeries=true&includeEpisode=true&includeUnknownSeriesItems=true";
  const records: unknown[] = [];
  for (let page = 1; page <= MAX_PAGES; page++) {
    // Quiet: loadDownloadQueue reports a failed instance once (warnOnChange).
    const res = await arrFetch<{ records?: unknown; totalRecords?: unknown }>(
      cfg, `/api/v3/queue?page=${page}&pageSize=${PAGE_SIZE}&${include}`, { quietErrors: true },
    );
    const batch = Array.isArray(res?.records) ? res.records : [];
    records.push(...batch);
    const total = typeof res?.totalRecords === "number" ? res.totalRecords : 0;
    if (batch.length === 0 || page * PAGE_SIZE >= total) break;
  }
  return records;
}

async function enabledInstances(): Promise<QueueReport["instances"]> {
  const out: QueueReport["instances"] = [];
  for (const service of QUEUE_SERVICES) {
    if (!(await isFeatureEnabled(`feature.integration.${service}`))) continue;
    for (const inst of await getSyncableArrInstances(service)) out.push({ service, slug: inst.slug, name: inst.name });
  }
  return out;
}

// Who asked for each title: the requesters of a non-declined request (pending,
// approved or available) for the same title on the same instance. Cosmetic — a
// failed read leaves the column empty rather than failing the page.
async function attachRequesters(items: QueueItem[]): Promise<void> {
  const movieIds = [...new Set(items.filter((i) => i.service === "radarr" && i.tmdbId !== null).map((i) => i.tmdbId as number))];
  const tvTmdbIds = [...new Set(items.filter((i) => i.service === "sonarr" && i.tmdbId !== null).map((i) => i.tmdbId as number))];
  const tvdbIds = [...new Set(items.filter((i) => i.service === "sonarr" && i.tvdbId !== null).map((i) => i.tvdbId as number))];
  if (movieIds.length + tvTmdbIds.length + tvdbIds.length === 0) return;
  type Row = { tmdbId: number; tvdbId: number | null; mediaType: string; arrInstance: string; user: { name: string | null; email: string } };
  const rows: Row[] = [];
  const read = async (where: Record<string, unknown>) => {
    rows.push(...(await prisma.mediaRequest.findMany({
      where: { status: { not: "DECLINED" }, ...where },
      select: { tmdbId: true, tvdbId: true, mediaType: true, arrInstance: true, user: { select: { name: true, email: true } } },
    })));
  };
  try {
    for (let i = 0; i < movieIds.length; i += REQUESTER_CHUNK) {
      await read({ mediaType: "MOVIE", tmdbId: { in: movieIds.slice(i, i + REQUESTER_CHUNK) } });
    }
    for (let i = 0; i < tvTmdbIds.length; i += REQUESTER_CHUNK) {
      await read({ mediaType: "TV", tmdbId: { in: tvTmdbIds.slice(i, i + REQUESTER_CHUNK) } });
    }
    for (let i = 0; i < tvdbIds.length; i += REQUESTER_CHUNK) {
      await read({ mediaType: "TV", tvdbId: { in: tvdbIds.slice(i, i + REQUESTER_CHUNK) } });
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    warnOnChange("queue:requesters", message, `[queue] requester lookup failed: ${message}`);
    return;
  }
  forgetWarnOnChange("queue:requesters");
  for (const item of items) {
    const mediaType = item.service === "radarr" ? "MOVIE" : "TV";
    const names = new Set<string>();
    for (const r of rows) {
      if (r.mediaType !== mediaType || r.arrInstance !== item.instance) continue;
      const sameTitle =
        (item.tmdbId !== null && r.tmdbId === item.tmdbId) ||
        (item.tvdbId !== null && r.tvdbId !== null && r.tvdbId === item.tvdbId);
      if (sameTitle) names.add(r.user.name?.trim() || r.user.email);
    }
    item.requesters = [...names].slice(0, MAX_REQUESTERS_PER_ROW);
  }
}

/** Every configured instance's queue, one row per download, attention first. */
export async function loadDownloadQueue(): Promise<QueueReport> {
  const instances = await enabledInstances();
  const settled = await settleLimit(instances, LISTING_CONCURRENCY, async (inst) =>
    foldQueueRecords(inst.service, inst.slug, await readQueuePages(inst.service, inst.slug)),
  );
  const report: QueueReport = { instances, errors: [], items: [] };
  settled.forEach((s, i) => {
    const inst = instances[i];
    // The page re-reads every 20s while open: an instance that stays down is
    // one unchanged condition, logged once until it changes (guardrail 7b).
    const logKey = `queue:${inst.service}:${inst.slug}`;
    if (s.status === "fulfilled") {
      report.items.push(...s.value);
      forgetWarnOnChange(logKey);
      return;
    }
    const error = arrErrorMessage(s.reason);
    report.errors.push({ service: inst.service, instance: inst.slug, error });
    warnOnChange(logKey, error, `[queue] ${inst.service} instance "${inst.slug}" queue read failed: ${error}`);
  });
  await attachRequesters(report.items);
  sortQueueItems(report.items);
  return report;
}

export class QueueInstanceError extends Error {}

// The instance must be a CONFIGURED one: a slug is never turned into a
// Setting-key read for an instance the registry doesn't list.
async function configuredCfg(service: QueueService, instance: string) {
  const configured = await getSyncableArrInstances(service);
  if (!configured.some((i) => i.slug === instance)) throw new QueueInstanceError(instance);
  const cfg = await getArrCfg(service, instance);
  if (!cfg) throw new QueueInstanceError(instance);
  return cfg;
}

/**
 * Remove downloads from one instance's queue through Radarr/Sonarr's bulk
 * DELETE — one call for every id, so a Sonarr season pack (one record per
 * episode) is removed, and blocklisted, exactly once (guardrail 5c).
 */
export async function removeFromQueue(
  service: QueueService,
  instance: string,
  ids: readonly number[],
  action: QueueRemoveAction,
  method: QueueRemoveMethod,
): Promise<void> {
  const cfg = await configuredCfg(service, instance);
  await arrFetchNoContent(cfg, `/api/v3/queue/bulk?${queueRemoveQuery(action, method)}`, {
    method: "DELETE",
    body: JSON.stringify({ ids: [...ids] }),
  });
}

/**
 * Send releases Radarr/Sonarr are HOLDING (a delay profile, …) to the download
 * client now — the arr's own "Grab" on a pending queue item. One bulk call; the
 * arr 404s an id that is no longer pending.
 */
export async function grabPending(service: QueueService, instance: string, ids: readonly number[]): Promise<void> {
  const cfg = await configuredCfg(service, instance);
  await arrFetchNoContent(cfg, "/api/v3/queue/grab/bulk", { method: "POST", body: JSON.stringify({ ids: [...ids] }) });
}

/**
 * Ask every configured, enabled instance to re-check its downloads now
 * (RefreshMonitoredDownloads — the arr runs it every minute on its own). The
 * way to retry an import after fixing what blocked it (a permission, a disk, a
 * mapping changed in the arr) without waiting. Commands are queued, not awaited.
 */
export async function recheckDownloads(): Promise<{ instances: number; errors: Array<{ service: QueueService; instance: string; error: string }> }> {
  const instances = await enabledInstances();
  const settled = await settleLimit(instances, LISTING_CONCURRENCY, async (inst) => {
    const cfg = await getArrCfg(inst.service, inst.slug);
    if (!cfg) throw new Error("not configured");
    await arrFetch<unknown>(cfg, "/api/v3/command", { method: "POST", body: JSON.stringify({ name: "RefreshMonitoredDownloads" }) });
  });
  const errors: Array<{ service: QueueService; instance: string; error: string }> = [];
  settled.forEach((r, i) => {
    if (r.status === "rejected") errors.push({ service: instances[i].service, instance: instances[i].slug, error: arrErrorMessage(r.reason) });
  });
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
    readQualities(cfg).catch(() => new Map<number, { name: string; quality: unknown }>()),
    readLanguages(cfg).catch(() => new Map<number, { id: number; name: string }>()),
  ]);
  return {
    files: importCandidates(service, raw),
    qualities: [...qualities].map(([id, q]) => ({ id, name: q.name })),
    languages: [...languages.values()].map((l) => ({ id: l.id, name: l.name })),
  };
}

/** Nothing the admin chose is (still) importable — imported meanwhile, gone, or never matched. */
export class NothingToImportError extends Error {}

const MAX_CATALOG_TITLES = 20;

// Exactly the catalog the corrections need, read from the instance itself: a
// movie/series the instance doesn't have, an episode of another series, a
// quality or language it doesn't define, is refused (ImportOverrideError) by
// applyImportOverride rather than sent upstream.
async function loadCatalog(service: QueueService, cfg: ArrCfg, rows: ReturnType<typeof selectedRawRows>): Promise<ImportCatalog> {
  const needs = overrideNeeds(rows);
  if (needs.movieIds.length + needs.seriesIds.length > MAX_CATALOG_TITLES) throw new ImportOverrideError(service === "radarr" ? "movie" : "series");
  const notFound = async <T>(p: Promise<T>): Promise<T | null> => {
    try {
      return await p;
    } catch (err) {
      if (err instanceof ArrResponseError && err.status === 404) return null;
      throw err;
    }
  };
  const [qualities, languages] = await Promise.all([
    needs.qualities ? readQualities(cfg) : Promise.resolve(new Map<number, { name: string; quality: unknown }>()),
    needs.languages ? readLanguages(cfg) : Promise.resolve(new Map<number, { id: number; name: string }>()),
  ]);
  const movies = new Map<number, { id: number; title: string; year: number | null }>();
  for (const id of needs.movieIds) {
    const m = await notFound(arrFetch<{ id?: unknown; title?: unknown; year?: unknown }>(cfg, `/api/v3/movie/${id}`));
    if (m && m.id === id) movies.set(id, { id, title: typeof m.title === "string" ? m.title : String(id), year: typeof m.year === "number" && m.year > 0 ? m.year : null });
  }
  const series = new Map<number, { id: number; title: string; episodes: Map<number, QueueEpisode> }>();
  for (const id of needs.seriesIds) {
    const sr = await notFound(arrFetch<{ id?: unknown; title?: unknown }>(cfg, `/api/v3/series/${id}`));
    if (!sr || sr.id !== id) continue;
    const eps = await arrFetch<unknown>(cfg, `/api/v3/episode?seriesId=${id}`);
    const episodes = new Map<number, QueueEpisode>();
    if (Array.isArray(eps)) {
      for (const e of eps as Array<{ id?: unknown; seasonNumber?: unknown; episodeNumber?: unknown } | null>) {
        if (typeof e?.id === "number" && typeof e.seasonNumber === "number" && typeof e.episodeNumber === "number") {
          episodes.set(e.id, { seasonNumber: e.seasonNumber, episodeNumber: e.episodeNumber });
        }
      }
    }
    series.set(id, { id, title: typeof sr.title === "string" ? sr.title : String(id), episodes });
  }
  return {
    qualities: new Map([...qualities].map(([k, v]) => [k, v.quality])),
    languages,
    movies,
    series,
  };
}

async function correctedRows(service: QueueService, cfg: ArrCfg, downloadId: string, selections: ReadonlyMap<string, ImportOverride>) {
  const raw = await arrFetch<unknown>(cfg, manualImportPath(downloadId));
  const catalog = await loadCatalog(service, cfg, selectedRawRows(raw, selections));
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
