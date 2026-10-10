// Admin → Download Queue: the data half. One live, paged /api/v3/queue read per
// configured Radarr and Sonarr instance (guardrail 32 — every instance, by its
// slug), folded and judged by the pure rules in arr-queue.ts, plus the one
// mutation the page offers: removing a download through Radarr/Sonarr's own
// bulk queue DELETE. Every call goes through arrFetch (guardrail 5). Nothing is
// cached, and nothing in Summonarr is written except the audit row the route adds.
import { arrErrorMessage, arrFetch, arrFetchNoContent, getArrCfg } from "./arr";
import { getSyncableArrInstances } from "./arr-instance-registry";
import { settleLimit } from "./concurrency";
import { isFeatureEnabled } from "./features";
import { forgetWarnOnChange, warnOnChange } from "./log-dedup";
import { prisma } from "./prisma";
import {
  foldQueueRecords,
  queueRemoveQuery,
  sortQueueItems,
  type QueueItem,
  type QueueRemoveAction,
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

/**
 * Remove downloads from one instance's queue through Radarr/Sonarr's bulk
 * DELETE — one call for every id, so a Sonarr season pack (one record per
 * episode) is removed, and blocklisted, exactly once. The instance must be a
 * CONFIGURED one: a slug is never turned into a Setting-key read for an
 * instance the registry doesn't list.
 */
export async function removeFromQueue(
  service: QueueService,
  instance: string,
  ids: readonly number[],
  action: QueueRemoveAction,
  removeFromClient: boolean,
): Promise<void> {
  const configured = await getSyncableArrInstances(service);
  if (!configured.some((i) => i.slug === instance)) throw new QueueInstanceError(instance);
  const cfg = await getArrCfg(service, instance);
  if (!cfg) throw new QueueInstanceError(instance);
  await arrFetchNoContent(cfg, `/api/v3/queue/bulk?${queueRemoveQuery(action, removeFromClient)}`, {
    method: "DELETE",
    body: JSON.stringify({ ids: [...ids] }),
  });
}
