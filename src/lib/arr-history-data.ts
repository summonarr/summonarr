// Admin → Download History: the data half of the History and Blocklist tabs.
// One instance at a time, paged by the arr itself — merging several instances'
// pages would need every instance's whole history to order one page honestly.
// Every call goes through arrFetch on a CONFIGURED instance (guardrails 5, 32).
// Nothing is cached except blocklist titles an older arr did not embed.
import { arrFetch, arrFetchNoContent, type ArrCfg } from "./arr";
import { configuredArrCfg, postArrCommand, type ArrService } from "./arr-admin";
import {
  historyEventQuery,
  pageOf,
  projectBlocklistRecords,
  projectHistoryRecords,
  type ArrHistoryEvent,
  type ArrPage,
  type BlocklistEntry,
  type HistoryFilterKind,
} from "./arr-history";
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
const MAX_TITLE_CACHE = 5_000;
const titleCache = processSingleton("arr-blocklist-titles", () => new Map<string, { info: TitleInfo | null; expiresAt: number }>());

async function titleFor(cfg: ArrCfg, service: ArrService, arrId: number, now: number): Promise<TitleInfo | null> {
  const key = `${cfg.url}\u0000${service}\u0000${arrId}`;
  const hit = titleCache.get(key);
  if (hit && hit.expiresAt > now) return hit.info;
  let info: TitleInfo | null = null;
  try {
    const r = await arrFetch<{ title?: unknown; year?: unknown; tmdbId?: unknown; tvdbId?: unknown }>(
      cfg, `/api/v3/${service === "radarr" ? "movie" : "series"}/${arrId}`, { quietErrors: true },
    );
    const pos = (v: unknown) => (typeof v === "number" && Number.isSafeInteger(v) && v > 0 ? v : null);
    if (typeof r?.title === "string") {
      info = { title: r.title.slice(0, 300), year: pos(r.year), tmdbId: pos(r.tmdbId), tvdbId: service === "sonarr" ? pos(r.tvdbId) : null };
    }
  } catch {
    // Cosmetic: the row keeps its release name; a title removed from the arr reads as unknown.
  }
  if (titleCache.size >= MAX_TITLE_CACHE) titleCache.clear();
  titleCache.set(key, { info, expiresAt: now + TITLE_TTL_MS });
  return info;
}

export async function loadBlocklistPage(
  service: ArrService,
  instance: string,
  paging: { page: number; pageSize: number },
): Promise<ArrPage<BlocklistEntry>> {
  const cfg = await configuredArrCfg(service, instance);
  const include = service === "radarr" ? "&includeMovie=true" : "&includeSeries=true";
  const raw = await arrFetch<unknown>(
    cfg,
    `/api/v3/blocklist?page=${paging.page}&pageSize=${paging.pageSize}&sortKey=date&sortDirection=descending${include}`,
  );
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

const BLOCKLIST_SCAN_PAGE = 1_000;
const BLOCKLIST_SCAN_PAGES = 20;

/**
 * Remove releases from the blocklist (Radarr/Sonarr's bulk DELETE), so they
 * can be grabbed again. Every id must be on the instance's blocklist as it
 * reads now (newest first — the page the admin is looking at is found early;
 * guardrail 5e), else BlocklistGoneError and nothing is sent.
 */
export async function removeFromBlocklist(service: ArrService, instance: string, ids: readonly number[]): Promise<void> {
  const cfg = await configuredArrCfg(service, instance);
  const wanted = new Set(ids);
  for (let page = 1; page <= BLOCKLIST_SCAN_PAGES && wanted.size > 0; page++) {
    const raw = await arrFetch<{ records?: unknown; totalRecords?: unknown } | null>(
      cfg, `/api/v3/blocklist?page=${page}&pageSize=${BLOCKLIST_SCAN_PAGE}&sortKey=date&sortDirection=descending`,
    );
    const records = Array.isArray(raw?.records) ? (raw.records as Array<{ id?: unknown } | null>) : [];
    for (const r of records) if (typeof r?.id === "number") wanted.delete(r.id);
    const total = typeof raw?.totalRecords === "number" ? raw.totalRecords : 0;
    if (records.length === 0 || page * BLOCKLIST_SCAN_PAGE >= total) break;
  }
  if (wanted.size > 0) throw new BlocklistGoneError();
  await arrFetchNoContent(cfg, "/api/v3/blocklist/bulk", { method: "DELETE", body: JSON.stringify({ ids: [...ids] }) });
}

/** Empty the instance's whole blocklist (the arr's own ClearBlocklist command). */
export async function clearBlocklist(service: ArrService, instance: string): Promise<void> {
  const cfg = await configuredArrCfg(service, instance);
  await postArrCommand(cfg, { name: "ClearBlocklist" });
}
