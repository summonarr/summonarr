// Admin → Download History: the data half of the History and Blocklist tabs.
// One instance at a time, paged by the arr itself — merging several instances'
// pages would need every instance's whole history to order one page honestly.
// Every call goes through arrFetch on a CONFIGURED instance (guardrails 5, 32).
// Nothing is cached except blocklist titles an older arr did not embed.
import { ArrResponseError, arrFetch, arrFetchNoContent, type ArrCfg } from "./arr";
import { commandIdsOf, configuredArrCfg, postArrCommand, type ArrService } from "./arr-admin";
import {
  historyEventQuery,
  pageOf,
  projectBlocklistRecords,
  projectHistoryRecords,
  removedBlocklistEntry,
  type ArrHistoryEvent,
  type ArrPage,
  type BlocklistEntry,
  type HistoryFilterKind,
  type RemovedBlocklistEntry,
} from "./arr-history";
import { pagedReadEnded } from "./arr-parse";
import { settleLimit } from "./concurrency";
import { processSingleton } from "./process-singleton";

export async function loadHistoryPage(
  service: ArrService,
  instance: string,
  paging: { page: number; pageSize: number },
  kind: HistoryFilterKind | null,
): Promise<ArrPage<ArrHistoryEvent>> {
  const cfg = await configuredArrCfg(service, instance);
  const include = service === "radarr" ? "includeMovie=true" : "includeSeries=true&includeEpisode=true";
  const filter = kind ? `&${historyEventQuery(service, kind)}` : "";
  const raw = await arrFetch<unknown>(
    cfg,
    `/api/v3/history?page=${paging.page}&pageSize=${paging.pageSize}&sortKey=date&sortDirection=descending&${include}${filter}`,
  );
  return pageOf(raw, (records) => projectHistoryRecords(service, instance, records), paging);
}

// ── blocklist ────────────────────────────────────────────────────────────────

// Titles for blocklist rows whose arr did not embed the movie/series. Keyed by
// the instance's URL and the arr's id; short-lived so a renamed title catches up.
type TitleInfo = { title: string; year: number | null; tmdbId: number | null; tvdbId: number | null };
const TITLE_TTL_MS = 10 * 60_000;
// A failed lookup (a timeout, a 5xx) is not an answer: kept only long enough
// that a burst of reloads doesn't re-ask, never for a whole TITLE_TTL_MS.
const TITLE_RETRY_MS = 30_000;
const MAX_TITLE_CACHE = 5_000;
const titleCache = processSingleton("arr-blocklist-titles", () => new Map<string, { info: TitleInfo | null; expiresAt: number }>());
// Lookups in flight, by the same key: two page loads at once (two tabs, the
// page and its snapshot refresh) share one arr read per title instead of each
// asking for every title on the page.
const titleInFlight = processSingleton("arr-blocklist-titles:in-flight", () => new Map<string, Promise<TitleInfo | null>>());

function titleFor(cfg: ArrCfg, service: ArrService, arrId: number, now: number): Promise<TitleInfo | null> {
  const key = `${cfg.url}\u0000${service}\u0000${arrId}`;
  const hit = titleCache.get(key);
  if (hit && hit.expiresAt > now) return Promise.resolve(hit.info);
  const pending = titleInFlight.get(key);
  if (pending) return pending;
  const lookup = fetchTitle(cfg, service, arrId, key, now).finally(() => titleInFlight.delete(key));
  titleInFlight.set(key, lookup);
  return lookup;
}

async function fetchTitle(cfg: ArrCfg, service: ArrService, arrId: number, key: string, now: number): Promise<TitleInfo | null> {
  let info: TitleInfo | null = null;
  let ttl = TITLE_TTL_MS;
  try {
    const r = await arrFetch<{ title?: unknown; year?: unknown; tmdbId?: unknown; tvdbId?: unknown }>(
      cfg, `/api/v3/${service === "radarr" ? "movie" : "series"}/${arrId}`, { quietErrors: true },
    );
    const pos = (v: unknown) => (typeof v === "number" && Number.isSafeInteger(v) && v > 0 ? v : null);
    if (typeof r?.title === "string") {
      info = { title: r.title.slice(0, 300), year: pos(r.year), tmdbId: pos(r.tmdbId), tvdbId: service === "sonarr" ? pos(r.tvdbId) : null };
    }
  } catch (err) {
    // Cosmetic: the row keeps its release name. A title removed from the arr
    // (404) reads as unknown until it expires; any other failure is retried soon.
    if (!(err instanceof ArrResponseError && err.status === 404)) ttl = TITLE_RETRY_MS;
  }
  // Re-inserted at the back, and the oldest entry goes when full — a full
  // cache never drops every title at once (a burst of re-fetches).
  titleCache.delete(key);
  if (titleCache.size >= MAX_TITLE_CACHE) {
    const oldest = titleCache.keys().next();
    if (!oldest.done) titleCache.delete(oldest.value);
  }
  titleCache.set(key, { info, expiresAt: now + ttl });
  return info;
}

export async function loadBlocklistPage(
  service: ArrService,
  instance: string,
  paging: { page: number; pageSize: number },
): Promise<ArrPage<BlocklistEntry>> {
  const cfg = await configuredArrCfg(service, instance);
  const include = service === "radarr" ? "&includeMovie=true" : "&includeSeries=true";
  const raw = await readBlocklist(cfg, paging.page, paging.pageSize, include);
  const page = pageOf(raw, (records) => projectBlocklistRecords(service, instance, records), paging);
  const missing = [...new Set(page.records.filter((r) => r.mediaTitle === "" && r.arrMediaId !== null).map((r) => r.arrMediaId as number))];
  if (missing.length > 0) {
    const now = Date.now();
    const settled = await settleLimit(missing, 4, (id) => titleFor(cfg, service, id, now));
    const byId = new Map<number, TitleInfo>();
    settled.forEach((s, i) => {
      if (s.status === "fulfilled" && s.value) byId.set(missing[i], s.value);
    });
    for (const r of page.records) {
      const info = r.arrMediaId !== null ? byId.get(r.arrMediaId) : undefined;
      if (!info || r.mediaTitle !== "") continue;
      r.mediaTitle = info.title;
      r.year = info.year;
      r.tmdbId = info.tmdbId;
      r.tvdbId = info.tvdbId;
    }
  }
  return page;
}

/** Some of the ids are not on the instance's blocklist (removed meanwhile, or never were). */
export class BlocklistGoneError extends Error {}

/**
 * The instance has no /blocklist API: Radarr before v4 and Sonarr v3 builds
 * before August 2021 called it the blacklist (/blacklist, ClearBlacklist) and
 * answer /blocklist with 404 — which must not read as "that item is gone".
 */
export class BlocklistUnsupportedError extends Error {}

// The arr's own list order, the one the Blocklist tab pages through.
const BLOCKLIST_ORDER = "sortKey=date&sortDirection=descending";

async function readBlocklist(cfg: ArrCfg, page: number, pageSize: number, include = ""): Promise<unknown> {
  try {
    return await arrFetch<unknown>(cfg, `/api/v3/blocklist?page=${page}&pageSize=${pageSize}&${BLOCKLIST_ORDER}${include}`);
  } catch (err) {
    if (err instanceof ArrResponseError && err.status === 404) throw new BlocklistUnsupportedError();
    throw err;
  }
}

const BLOCKLIST_SCAN_PAGE = 1_000;
const BLOCKLIST_SCAN_PAGES = 20;

/**
 * Remove releases from the blocklist (Radarr/Sonarr's bulk DELETE), so they
 * can be grabbed again. Every id must be on the instance's blocklist as it
 * reads now (guardrail 5e), else BlocklistGoneError and nothing is sent.
 * `viewed` is the page the admin picked them from: it is re-read first, and
 * the newest-first scan (up to BLOCKLIST_SCAN_PAGES × BLOCKLIST_SCAN_PAGE
 * records, every one embedding its movie/series) runs only for ids that page
 * no longer holds. When that scan stops at its cap with ids still missing, the
 * viewed page's neighbours are re-read too (an entry deep in the list shifts
 * by a page when one is added or removed above it). Resolves to what was
 * removed, in `ids` order, for the audit.
 */
export async function removeFromBlocklist(
  service: ArrService,
  instance: string,
  ids: readonly number[],
  viewed: { page: number; pageSize: number } | null = null,
): Promise<RemovedBlocklistEntry[]> {
  const cfg = await configuredArrCfg(service, instance);
  const search = blocklistSearch(cfg, service, ids);
  if (viewed) await search.take(viewed.page, viewed.pageSize);
  const scannedThrough = await scanBlocklist(search);
  if (viewed && scannedThrough !== null) await rereadNeighbours(search, viewed, scannedThrough);
  if (search.wanted.size > 0) throw new BlocklistGoneError();
  await arrFetchNoContent(cfg, "/api/v3/blocklist/bulk", { method: "DELETE", body: JSON.stringify({ ids: [...ids] }) });
  return ids.map((id) => search.found.get(id) as RemovedBlocklistEntry);
}

interface BlocklistSearch {
  /** The ids not yet seen on a fresh read. */
  wanted: Set<number>;
  found: Map<number, RemovedBlocklistEntry>;
  /** Read one page and claim the wanted ids it holds; how many records it held and the arr's total. */
  take(page: number, pageSize: number): Promise<{ count: number; totalRecords: unknown }>;
}

function blocklistSearch(cfg: ArrCfg, service: ArrService, ids: readonly number[]): BlocklistSearch {
  const wanted = new Set(ids);
  const found = new Map<number, RemovedBlocklistEntry>();
  return {
    wanted,
    found,
    async take(page, pageSize) {
      const raw = (await readBlocklist(cfg, page, pageSize)) as { records?: unknown; totalRecords?: unknown } | null;
      const records: unknown[] = Array.isArray(raw?.records) ? raw.records : [];
      for (const r of records) {
        const entry = removedBlocklistEntry(service, r);
        if (entry && wanted.delete(entry.id)) found.set(entry.id, entry);
      }
      return { count: records.length, totalRecords: raw?.totalRecords };
    },
  };
}

// The newest-first scan, only while ids are still wanted. Answers the records
// it read through, or null once it reached the end of the list.
async function scanBlocklist(search: BlocklistSearch): Promise<number | null> {
  let scannedThrough = 0;
  for (let page = 1; page <= BLOCKLIST_SCAN_PAGES && search.wanted.size > 0; page++) {
    const { count, totalRecords } = await search.take(page, BLOCKLIST_SCAN_PAGE);
    // An arr that reported no total has reached the end only on a short page —
    // a missing total read as 0 called page 1 a complete scan.
    if (pagedReadEnded(page, BLOCKLIST_SCAN_PAGE, count, totalRecords)) return null;
    scannedThrough = page * BLOCKLIST_SCAN_PAGE;
  }
  return scannedThrough;
}

// The scan stopped at its cap short of the list's end, and the viewed page
// lies past it: an entry picked there moves to the NEXT page when one is
// blocklisted meanwhile (newest first) and to the previous one when one is
// removed. Re-read those two pages — each still read fresh, never trusted
// from the browser — before calling it gone. A neighbour inside the scanned
// range was read by the scan already.
async function rereadNeighbours(search: BlocklistSearch, viewed: { page: number; pageSize: number }, scannedThrough: number): Promise<void> {
  for (const page of [viewed.page + 1, viewed.page - 1]) {
    if (search.wanted.size === 0) return;
    if (page >= 1 && page * viewed.pageSize > scannedThrough) await search.take(page, viewed.pageSize);
  }
}

/**
 * Empty the instance's whole blocklist (the arr's own ClearBlocklist command).
 * Answers the command's id — the page follows it and re-reads the list once it ends.
 */
export async function clearBlocklist(service: ArrService, instance: string): Promise<{ commandIds: number[] }> {
  const cfg = await configuredArrCfg(service, instance);
  return { commandIds: commandIdsOf([await postArrCommand(cfg, { name: "ClearBlocklist" })]) };
}
