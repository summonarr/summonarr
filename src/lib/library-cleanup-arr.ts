// Library cleanup — the Radarr/Sonarr half: which *arr instances hold a title,
// what it weighs on disk, and the delete itself. Every call goes through
// arrFetch/arrFetchNoContent (guardrail 5), and every instance is addressed by
// its arrInstance slug (guardrail 32): a title can sit in the default, the 4K
// and a named instance at once, and a cleanup removes it from every one.
import { ArrResponseError, arrFetch, arrFetchNoContent, getArrCfg, resolveTmdbToTvdb, type ArrCfg } from "./arr";
import { getSyncableArrInstances } from "./arr-instance-registry";
import { coalesce, mapLimit, settleLimit } from "./concurrency";
import { isFeatureEnabled } from "./features";
import { cleanupKey, sonarrStatusIsAiring, type CleanupMediaType } from "./library-cleanup";
import type { NwArrSeasonStat } from "./never-watched";
import { processSingleton } from "./process-singleton";
import { safeMessage } from "./arr-parse";

export type ArrService = "radarr" | "sonarr";

export interface ArrLibraryEntry {
  service: ArrService;
  instance: string;
  arrId: number;
  tmdbId: number | null;
  tvdbId: number | null;
  title: string;
  sizeOnDisk: number;
  // Sonarr only; null for movies and for an unrecognised status.
  airing: boolean | null;
  // When the arr added the title — one of the arrival dates the never-watched
  // report takes the earliest of (a media server's own "added" resets on re-add).
  added?: Date | null;
  // Sonarr only: per-season file statistics (specials included as season 0).
  seasons?: NwArrSeasonStat[];
}

export interface ArrLibraryIndex {
  // cleanupKey(tmdbId, mediaType) → every instance entry carrying that tmdbId.
  byKey: Map<string, ArrLibraryEntry[]>;
  // Sonarr entries that carry NO tmdbId (Sonarr v3, or a series TVDB never
  // cross-referenced), by tvdbId — reachable only through a TVDB lookup.
  tvdbOnly: Map<number, ArrLibraryEntry[]>;
  // Instances whose listing could not be read this time. Their titles have no
  // size and no delete target, which the UI reports rather than hides. `error`
  // is browser-safe (one line, credentials masked — safeMessage), because both
  // admin pages show it: a bare instance name told the admin nothing to act on.
  errors: Array<{ service: ArrService; instance: string; error: string }>;
}

type RadarrMovieRow = { id?: unknown; tmdbId?: unknown; title?: unknown; sizeOnDisk?: unknown; added?: unknown };
type SonarrSeriesRow = {
  id?: unknown;
  tmdbId?: unknown;
  tvdbId?: unknown;
  title?: unknown;
  status?: unknown;
  added?: unknown;
  statistics?: { sizeOnDisk?: unknown } | null;
  seasons?: Array<{ seasonNumber?: unknown; statistics?: { sizeOnDisk?: unknown; episodeFileCount?: unknown } | null }> | null;
};

const posInt = (v: unknown): number | null => (typeof v === "number" && Number.isInteger(v) && v > 0 ? v : null);
const nonNeg = (v: unknown): number => (typeof v === "number" && Number.isFinite(v) && v > 0 ? v : 0);

// The arrs report an unknown date as 0001-01-01; anything before the Unix epoch
// is that sentinel, not a date.
function arrDate(v: unknown): Date | null {
  if (typeof v !== "string" || v.length === 0) return null;
  const d = new Date(v);
  return Number.isFinite(d.getTime()) && d.getTime() > 0 ? d : null;
}

function sonarrSeasons(rows: SonarrSeriesRow["seasons"]): NwArrSeasonStat[] {
  const out: NwArrSeasonStat[] = [];
  for (const s of Array.isArray(rows) ? rows : []) {
    const n = typeof s?.seasonNumber === "number" && Number.isInteger(s.seasonNumber) && s.seasonNumber >= 0 ? s.seasonNumber : null;
    if (n === null) continue;
    const files = s.statistics?.episodeFileCount;
    out.push({
      seasonNumber: n,
      sizeOnDisk: nonNeg(s.statistics?.sizeOnDisk),
      episodeFileCount: typeof files === "number" && Number.isInteger(files) && files > 0 ? files : 0,
    });
  }
  return out;
}

// Small, fixed: one listing per instance, each up to a library-sized body.
const LISTING_CONCURRENCY = 3;

// 502/503/504 come from whatever sits in front of Radarr/Sonarr (a reverse
// proxy, a gateway) when the arr is restarting, busy importing, or drops a
// long response — the full /movie or /series listing is exactly the request
// that trips it. The listing is an idempotent GET, so it is retried ONCE after
// a pause; a second failure is reported as before (a down instance still shows
// its banner and still refuses deletes). Any other status — a 401 from a bad
// key, a 404 from a wrong URL — is not retried: waiting can't fix it.
const LISTING_RETRY_STATUSES = new Set([502, 503, 504]);
let listingRetryDelayMs = 2_000;

export function _setArrListingRetryDelayForTests(ms: number): void {
  listingRetryDelayMs = ms;
}

async function fetchListing<T>(cfg: ArrCfg, path: string): Promise<T> {
  try {
    return await arrFetch<T>(cfg, path);
  } catch (err) {
    if (!(err instanceof ArrResponseError) || !LISTING_RETRY_STATUSES.has(err.status)) throw err;
    await new Promise((resolve) => setTimeout(resolve, listingRetryDelayMs));
    return arrFetch<T>(cfg, path);
  }
}

async function listInstance(service: ArrService, instance: string): Promise<ArrLibraryEntry[]> {
  const cfg = await getArrCfg(service, instance);
  if (!cfg) return [];
  if (service === "radarr") {
    const rows = await fetchListing<RadarrMovieRow[]>(cfg, "/api/v3/movie");
    const out: ArrLibraryEntry[] = [];
    for (const r of Array.isArray(rows) ? rows : []) {
      const arrId = posInt(r.id);
      if (arrId === null) continue;
      out.push({
        service, instance, arrId,
        tmdbId: posInt(r.tmdbId),
        tvdbId: null,
        title: typeof r.title === "string" ? r.title : "",
        sizeOnDisk: nonNeg(r.sizeOnDisk),
        airing: null,
        added: arrDate(r.added),
      });
    }
    return out;
  }
  const rows = await fetchListing<SonarrSeriesRow[]>(cfg, "/api/v3/series");
  const out: ArrLibraryEntry[] = [];
  for (const r of Array.isArray(rows) ? rows : []) {
    const arrId = posInt(r.id);
    if (arrId === null) continue;
    out.push({
      service, instance, arrId,
      tmdbId: posInt(r.tmdbId),
      tvdbId: posInt(r.tvdbId),
      title: typeof r.title === "string" ? r.title : "",
      sizeOnDisk: nonNeg(r.statistics?.sizeOnDisk),
      airing: sonarrStatusIsAiring(r.status),
      added: arrDate(r.added),
      seasons: sonarrSeasons(r.seasons),
    });
  }
  return out;
}

// One listing per configured instance of each enabled service. Never throws:
// a failed instance is reported in `errors` and simply contributes nothing.
export async function loadArrLibraryIndex(): Promise<ArrLibraryIndex> {
  const [radarrOn, sonarrOn] = await Promise.all([
    isFeatureEnabled("feature.integration.radarr"),
    isFeatureEnabled("feature.integration.sonarr"),
  ]);
  const [radarr, sonarr] = await Promise.all([
    radarrOn ? getSyncableArrInstances("radarr") : Promise.resolve([]),
    sonarrOn ? getSyncableArrInstances("sonarr") : Promise.resolve([]),
  ]);
  const targets: Array<{ service: ArrService; instance: string }> = [
    ...radarr.map((i) => ({ service: "radarr" as const, instance: i.slug })),
    ...sonarr.map((i) => ({ service: "sonarr" as const, instance: i.slug })),
  ];
  const settled = await settleLimit(targets, LISTING_CONCURRENCY, (t) => listInstance(t.service, t.instance));

  const index: ArrLibraryIndex = { byKey: new Map(), tvdbOnly: new Map(), errors: [] };
  settled.forEach((s, i) => {
    const t = targets[i];
    if (s.status === "rejected") {
      const reason = s.reason;
      index.errors.push({ ...t, error: safeMessage(reason instanceof Error ? reason.message : String(reason)) ?? "unknown error" });
      console.warn(`[cleanup] ${t.service} instance "${t.instance}" listing failed:`, reason instanceof Error ? reason.message : reason);
      return;
    }
    for (const e of s.value) {
      if (e.tmdbId !== null) {
        const key = cleanupKey(e.tmdbId, e.service === "radarr" ? "MOVIE" : "TV");
        const list = index.byKey.get(key);
        if (list) list.push(e);
        else index.byKey.set(key, [e]);
      } else if (e.service === "sonarr" && e.tvdbId !== null) {
        const list = index.tvdbOnly.get(e.tvdbId);
        if (list) list.push(e);
        else index.tvdbOnly.set(e.tvdbId, [e]);
      }
    }
  });
  return index;
}

// The same index, shared for a few minutes: every read-only view (the
// never-watched report, the storage stats) would otherwise list every library in
// full on each load — up to 50 MB a body. Concurrent callers share one listing.
// The DELETE path never uses this: guardrail 14b needs fresh targets.
const INDEX_TTL_MS = 5 * 60 * 1000;
// A listing with a failed instance is kept only briefly: Sonarr answers 503 or
// times out under import load, and holding that for the full TTL kept "could
// not read Sonarr" on screen for five minutes after it had recovered. Short,
// not zero, so a page reloaded in a loop against a down instance doesn't
// re-list every healthy one each time.
const INDEX_ERROR_TTL_MS = 30 * 1000;
const indexCache = processSingleton("library-cleanup:arr-index", () => ({ value: null as ArrLibraryIndex | null, at: 0 }));

export function invalidateArrLibraryIndexCache(): void {
  indexCache.value = null;
}

export async function getCachedArrLibraryIndex(opts: { fresh?: boolean } = {}): Promise<{ index: ArrLibraryIndex; at: Date }> {
  const ttl = indexCache.value && indexCache.value.errors.length > 0 ? INDEX_ERROR_TTL_MS : INDEX_TTL_MS;
  if (!opts.fresh && indexCache.value && Date.now() - indexCache.at < ttl) {
    return { index: indexCache.value, at: new Date(indexCache.at) };
  }
  return coalesce("library-cleanup:arr-index", async () => {
    const index = await loadArrLibraryIndex();
    indexCache.value = index;
    indexCache.at = Date.now();
    return { index, at: new Date(indexCache.at) };
  });
}

// The delete targets for each title: every instance entry carrying its tmdbId,
// plus — for a show no Sonarr entry names by tmdbId — the tvdbId-only entries
// TMDB's own cross-reference points at. Bounded: the TVDB lookup runs only for
// the selected titles that missed, and only when tvdb-only entries exist at all.
export async function resolveArrTargets(
  items: ReadonlyArray<{ tmdbId: number; mediaType: CleanupMediaType }>,
  index: ArrLibraryIndex,
): Promise<Map<string, ArrLibraryEntry[]>> {
  const out = new Map<string, ArrLibraryEntry[]>();
  const misses: Array<{ tmdbId: number; key: string }> = [];
  for (const it of items) {
    const key = cleanupKey(it.tmdbId, it.mediaType);
    const hit = index.byKey.get(key) ?? [];
    out.set(key, [...hit]);
    if (it.mediaType === "TV" && index.tvdbOnly.size > 0 && !hit.some((e) => e.service === "sonarr")) {
      misses.push({ tmdbId: it.tmdbId, key });
    }
  }
  if (misses.length > 0) {
    await mapLimit(misses, 4, async (m) => {
      const tvdbId = await resolveTmdbToTvdb(m.tmdbId);
      if (tvdbId === null) return;
      const extra = index.tvdbOnly.get(tvdbId) ?? [];
      out.get(m.key)!.push(...extra);
    });
  }
  return out;
}

// Removes the title from that instance AND its files, and adds an import-list
// exclusion so an import list can't add it straight back. Throws on failure
// (ArrResponseError for a non-2xx) — the caller reports it per target.
export async function deleteArrEntry(entry: Pick<ArrLibraryEntry, "service" | "instance" | "arrId">): Promise<void> {
  const cfg = await getArrCfg(entry.service, entry.instance);
  if (!cfg) throw new Error(`${entry.service} instance "${entry.instance || "default"}" is not configured`);
  const path = entry.service === "radarr"
    ? `/api/v3/movie/${entry.arrId}?deleteFiles=true&addImportExclusion=true`
    : `/api/v3/series/${entry.arrId}?deleteFiles=true&addImportListExclusion=true`;
  await arrFetchNoContent(cfg, path, { method: "DELETE" });
}
