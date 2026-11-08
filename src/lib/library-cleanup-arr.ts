// Library cleanup — the Radarr/Sonarr half: which *arr instances hold a title,
// what it weighs on disk, and the delete itself. Every call goes through
// arrFetch/arrFetchNoContent (guardrail 5), and every instance is addressed by
// its arrInstance slug (guardrail 32): a title can sit in the default, the 4K
// and a named instance at once, and a cleanup removes it from every one.
import { createHash } from "node:crypto";
import { ArrResponseError, arrErrorKind, arrFetch, arrFetchNoContent, getArrCfg, resolveTmdbToTvdb, type ArrCfg } from "./arr";
import type { ArrErrorKind } from "./arr-error-kind";
import { asRecord } from "./arr-client";
import { getSyncableArrInstances } from "./arr-instance-registry";
import { coalesce, mapLimit, settleLimit } from "./concurrency";
import { isFeatureEnabled } from "./features";
import { cleanupKey, sonarrStatusIsAiring, type CleanupMediaType } from "./library-cleanup";
import type { NwArrSeasonStat } from "./never-watched";
import { processSingleton } from "./process-singleton";
import { safeMessage } from "./arr-parse";
import { getCache } from "./tmdb-cache";
import { TmdbToTvdbCache } from "./arr-id-map";

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
  // When the arr added the title. NOT an arrival: an arr holds a title long
  // before any file exists (an approval pushed before release, an import-list
  // add). The never-watched loader reads it only as a bound — a fulfilled
  // request older than this instance's current entry belongs to a deleted copy
  // (guardrail 14d).
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
  // is browser-safe (one line, credentials masked — safeMessage) but English;
  // the pages show `kind` (arrErrorKind), translated through the literal
  // ARR_ERROR_KIND_KEYS like every admin arr surface (guardrail 5e), and keep
  // `error` only as the fallback for an entry without one. Optional in the type
  // only so a hand-built index (a test, a caller judging failedArrInstances)
  // needn't invent one; loadArrLibraryIndex always sets it.
  errors: Array<{ service: ArrService; instance: string; error: string; kind?: ArrErrorKind }>;
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
//
// Only a FAST failure is retried. A restart's 502/503 answers in milliseconds;
// a gateway that gave up after ~30 s waiting on a busy arr would cost a second
// full arrFetch timeout, and the cleanup dry run and execute read this listing
// synchronously, behind a reverse proxy that closes the request at ~60 s — the
// browser would get the proxy's 502 while the execute went on deleting
// (guardrail 37a). A slow failure is reported at once instead.
const LISTING_RETRY_STATUSES = new Set([502, 503, 504]);
const LISTING_RETRY_FAST_FAIL_MS = 10_000;
let listingRetryDelayMs = 2_000;
let listingRetryFastFailMs = LISTING_RETRY_FAST_FAIL_MS;

export function _setArrListingRetryDelayForTests(ms: number): void {
  listingRetryDelayMs = ms;
}

// `null` restores the production bound.
export function _setArrListingRetryFastFailForTests(ms: number | null): void {
  listingRetryFastFailMs = ms ?? LISTING_RETRY_FAST_FAIL_MS;
}

async function fetchListing<T>(cfg: ArrCfg, path: string): Promise<T> {
  const started = Date.now();
  try {
    return await arrFetch<T>(cfg, path);
  } catch (err) {
    if (!(err instanceof ArrResponseError) || !LISTING_RETRY_STATUSES.has(err.status)) throw err;
    if (Date.now() - started > listingRetryFastFailMs) throw err;
    await new Promise((resolve) => setTimeout(resolve, listingRetryDelayMs));
    return arrFetch<T>(cfg, path);
  }
}

// A listing this code can't read as one (no config by the time it is listed, a
// body that isn't an array) throws like a failed request: an empty answer would
// read as a healthy instance holding nothing, and failedArrInstances — which the
// delete route relies on not to half-delete a title — would never name it.
async function listInstance(service: ArrService, instance: string): Promise<ArrLibraryEntry[]> {
  const cfg = await getArrCfg(service, instance);
  if (!cfg) throw new Error("instance not configured");
  if (service === "radarr") {
    const rows = await fetchListing<unknown>(cfg, "/api/v3/movie");
    if (!Array.isArray(rows)) throw new Error("unexpected listing body");
    const out: ArrLibraryEntry[] = [];
    for (const row of rows) {
      const r: RadarrMovieRow | null = asRecord(row);
      if (!r) continue;
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
  const rows = await fetchListing<unknown>(cfg, "/api/v3/series");
  if (!Array.isArray(rows)) throw new Error("unexpected listing body");
  const out: ArrLibraryEntry[] = [];
  for (const row of rows) {
    // Every field is read through a guard below, so the declared shape is a reading aid.
    const r = asRecord(row) as SonarrSeriesRow | null;
    if (!r) continue;
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
      index.errors.push({ ...t, error: safeMessage(reason instanceof Error ? reason.message : String(reason)) ?? "unknown error", kind: arrErrorKind(reason) });
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
// `gen` moves on every invalidation (a cleanup delete, a title manager Add or
// Remove). A listing begun before one read the library as it was BEFORE the
// change, so it is never stored, and a caller arriving after the invalidation
// never joins it — the generation is part of the coalesce key (the guardrail-19b
// shape the never-watched report applies to its own cache).
const indexCache = processSingleton("library-cleanup:arr-index", () => ({ value: null as ArrLibraryIndex | null, at: 0, gen: 0 }));

export function invalidateArrLibraryIndexCache(): void {
  indexCache.value = null;
  indexCache.gen++;
}

// `fresh` skips the stored listing, but still joins a listing already in
// flight for the current generation: every change that could make that listing
// stale (a cleanup delete, a title manager Add or Remove) invalidates first,
// which moves the generation, so a joined listing never predates it.
export async function getCachedArrLibraryIndex(opts: { fresh?: boolean } = {}): Promise<{ index: ArrLibraryIndex; at: Date }> {
  const ttl = indexCache.value && indexCache.value.errors.length > 0 ? INDEX_ERROR_TTL_MS : INDEX_TTL_MS;
  if (!opts.fresh && indexCache.value && Date.now() - indexCache.at < ttl) {
    return { index: indexCache.value, at: new Date(indexCache.at) };
  }
  const gen = indexCache.gen;
  return coalesce(`library-cleanup:arr-index:${gen}`, async () => {
    const index = await loadArrLibraryIndex();
    const at = Date.now();
    if (indexCache.gen === gen) {
      indexCache.value = index;
      indexCache.at = at;
    }
    return { index, at: new Date(at) };
  });
}

// The shared index as it is in memory right now, or null — NEVER a listing. For
// a page render (the detail-page never-watched chip) that wants the same
// Radarr/Sonarr facts as the report when they are already at hand, but must not
// list every instance's whole library (up to 50 MB each, 30 s on a down arr) to
// get them. Any age: the chip reads only an entry's `added`, which moves only
// on a re-add in the arr.
export function peekCachedArrLibraryIndex(): ArrLibraryIndex | null {
  return indexCache.value;
}

// The instances of a title's service ("default" for the unnamed one) whose
// listing failed. While any did, the delete route refuses every title of that
// service — one of them may hold a copy nobody can see, and a partial removal
// would half-delete the title — and the never-watched report calls none of them
// eligible (guardrail 14d: one rule, both places).
export function failedArrInstances(index: Pick<ArrLibraryIndex, "errors">, mediaType: CleanupMediaType): string[] {
  const service: ArrService = mediaType === "MOVIE" ? "radarr" : "sonarr";
  return index.errors.filter((e) => e.service === service).map((e) => e.instance || "default");
}

// The exact set a cleanup dry run planned — every (title, instance, arr entry) —
// as one opaque value the execute echoes back (guardrail 14b). The count alone
// let a same-sized DIFFERENT set through: one copy dropping out while another
// appeared on a second instance would delete an entry the admin never saw.
// Order-free (sorted), so only the set matters.
export function cleanupTargetsFingerprint(
  plan: ReadonlyArray<{ tmdbId: number; mediaType: CleanupMediaType; targets: ReadonlyArray<Pick<ArrLibraryEntry, "service" | "instance" | "arrId">> }>,
): string {
  const lines = plan.flatMap((p) => p.targets.map((t) => `${p.mediaType}:${p.tmdbId}>${t.service}:${t.instance}:${t.arrId}`)).sort();
  return createHash("sha256").update(lines.join("\n")).digest("hex");
}

// How a lookup reaches TMDB's tmdb→tvdb cross-reference (resolveTmdbToTvdb).
// "fetch" — the delete route: a miss is a live TMDB call, awaited, because the
// delete must find every copy it was asked to remove (14b). "cached" — every
// READ path (the cleanup page, the never-watched report, the /admin/stats
// figure): the cache only, never a TMDB call inside the request. On Sonarr v3
// every series is tvdb-only, so a cold cache meant one external_ids fetch per
// show inside a page render — 1,500 shows at 4 at a time ran past a reverse
// proxy's 60–100 s and the admin saw a 502 (the guardrail-37a lesson). A miss
// reads as "no cross-reference" and is filled in the background (below), so
// the next load has it. Report ⊆ dry run either way: a missed cross-reference
// leaves a tvdb-only show with no copies, and a show with no copies is never
// eligible, while the dry run (fetch) can only find MORE copies and requests.
export type CrossRefMode = "fetch" | "cached";

// MUST equal the key resolveTmdbToTvdb (arr.ts) reads and writes — pinned by
// tests/cleanup-read-paths.test.mts.
export function tmdbToTvdbCacheKey(tmdbId: number): string {
  return `tmdb-to-tvdb:${tmdbId}`;
}

const CROSS_REF_CONCURRENCY = 4;
const CROSS_REF_FILL_BATCH = 200;
const CROSS_REF_FILL_MAX_QUEUE = 50_000;
const crossRefFill = processSingleton("library-cleanup:tvdb-crossref-fill", () => ({
  queued: new Set<number>(),
  running: null as Promise<void> | null,
}));

// ONE background drain per process (a second load's misses join its queue,
// never a second fan-out), bounded at CROSS_REF_CONCURRENCY and awaiting every
// lookup (guardrail 31/31a). resolveTmdbToTvdb never throws and caches only a
// definitive answer, so a failed lookup is simply retried by a later load.
function scheduleCrossRefFill(tmdbIds: readonly number[]): void {
  for (const id of tmdbIds) {
    if (crossRefFill.queued.size >= CROSS_REF_FILL_MAX_QUEUE) break;
    crossRefFill.queued.add(id);
  }
  if (crossRefFill.running || crossRefFill.queued.size === 0) return;
  crossRefFill.running = (async () => {
    try {
      while (crossRefFill.queued.size > 0) {
        // Taken off the Set's iterator: copying a 50k queue per batch was quadratic.
        const batch: number[] = [];
        for (const id of crossRefFill.queued) {
          batch.push(id);
          if (batch.length >= CROSS_REF_FILL_BATCH) break;
        }
        await mapLimit(batch, CROSS_REF_CONCURRENCY, async (id) => {
          await resolveTmdbToTvdb(id);
        });
        for (const id of batch) crossRefFill.queued.delete(id);
      }
    } catch (err) {
      console.warn("[cleanup] tvdb cross-reference fill stopped:", err instanceof Error ? err.message : err);
      crossRefFill.queued.clear();
    } finally {
      crossRefFill.running = null;
    }
  })();
}

// For tests: wait for the background fill to drain.
export function crossRefFillIdle(): Promise<void> {
  return crossRefFill.running ?? Promise.resolve();
}

// tmdbId → TMDB's tvdb id, for the given shows (null: TMDB names none). An id
// ABSENT from the map is unknown: in "cached" mode a cache miss (queued for the
// background fill); in "fetch" mode a lookup that failed — resolveTmdbToTvdb
// answers null for a failure and for "no tvdb id" alike, and caches only the
// definitive answer, so a null with no cache row after it is the failure.
export async function lookupTmdbToTvdb(tmdbIds: readonly number[], mode: CrossRefMode): Promise<Map<number, number | null>> {
  const out = new Map<number, number | null>();
  const ids = [...new Set(tmdbIds)];
  if (mode === "fetch") {
    await mapLimit(ids, CROSS_REF_CONCURRENCY, async (id) => {
      const tvdbId = await resolveTmdbToTvdb(id);
      if (tvdbId !== null || (await cachedCrossRef(id)) !== undefined) out.set(id, tvdbId);
    });
    return out;
  }
  const misses: number[] = [];
  await mapLimit(ids, CROSS_REF_CONCURRENCY, async (id) => {
    const cached = await cachedCrossRef(id);
    if (cached !== undefined) out.set(id, cached);
    else misses.push(id);
  });
  if (misses.length > 0) scheduleCrossRefFill(misses);
  return out;
}

/** The cached cross-reference: the tvdb id, null for "TMDB names none", undefined for no (readable) row. */
async function cachedCrossRef(tmdbId: number): Promise<number | null | undefined> {
  try {
    // The row resolveTmdbToTvdb writes; any other shape is a miss, since its
    // tvdb id picks which Sonarr series a cleanup deletes.
    const cached = await getCache(tmdbToTvdbCacheKey(tmdbId), TmdbToTvdbCache);
    return cached ? cached.tvdbId : undefined;
  } catch {
    // An unreadable cache row is a miss — never a verdict, never a throw.
    return undefined;
  }
}

export interface ArrTargets {
  /** cleanupKey → every instance entry to delete. */
  targets: Map<string, ArrLibraryEntry[]>;
  /**
   * cleanupKey → the tvdb-only Sonarr instances whose copy couldn't be looked
   * for, because TMDB's cross-reference for the show is unknown (a failed
   * lookup, or a cache miss on a read path). Such a title may hold a copy the
   * targets don't list.
   */
  unresolved: Map<string, string[]>;
}

// The delete targets for each title: every instance entry carrying its tmdbId,
// plus — on every Sonarr instance that did not name the show by tmdbId — the
// tvdbId-only entries TMDB's own cross-reference points at. A v4 Sonarr naming
// the show doesn't make a v3 instance's tvdb-only copy any less a copy (14b:
// every holder is a target). Bounded: the TVDB lookup runs only for the
// selected titles that some tvdb-only instance could still hold, and only when
// tvdb-only entries exist at all. `crossRef` is required on purpose: every
// caller decides whether a miss may cost a TMDB call (the delete route) or must
// not (a read path). A title listed twice is resolved once.
export async function resolveArrTargetsChecked(
  items: ReadonlyArray<{ tmdbId: number; mediaType: CleanupMediaType }>,
  index: ArrLibraryIndex,
  crossRef: CrossRefMode,
): Promise<ArrTargets> {
  const targets = new Map<string, ArrLibraryEntry[]>();
  const unresolved = new Map<string, string[]>();
  // The Sonarr instances that list any series tvdb-only — once per call.
  const tvdbOnlyInstances = new Set<string>();
  for (const list of index.tvdbOnly.values()) {
    for (const e of list) if (e.service === "sonarr") tvdbOnlyInstances.add(e.instance);
  }
  const misses: Array<{ tmdbId: number; list: ArrLibraryEntry[]; key: string; unmatched: string[] }> = [];
  for (const it of items) {
    const key = cleanupKey(it.tmdbId, it.mediaType);
    if (targets.has(key)) continue;
    const list = [...(index.byKey.get(key) ?? [])];
    targets.set(key, list);
    if (it.mediaType !== "TV" || tvdbOnlyInstances.size === 0) continue;
    const matched = new Set(list.filter((e) => e.service === "sonarr").map((e) => e.instance));
    const unmatched = [...tvdbOnlyInstances].filter((i) => !matched.has(i));
    if (unmatched.length > 0) misses.push({ tmdbId: it.tmdbId, list, key, unmatched });
  }
  if (misses.length > 0) {
    const tvdbOf = await lookupTmdbToTvdb(misses.map((m) => m.tmdbId), crossRef);
    for (const m of misses) {
      if (!tvdbOf.has(m.tmdbId)) {
        unresolved.set(m.key, m.unmatched.map((i) => i || "default"));
        continue;
      }
      const tvdbId = tvdbOf.get(m.tmdbId);
      if (tvdbId == null) continue;
      const unmatched = new Set(m.unmatched);
      for (const e of index.tvdbOnly.get(tvdbId) ?? []) {
        if (e.service === "sonarr" && unmatched.has(e.instance)) m.list.push(e);
      }
    }
  }
  return { targets, unresolved };
}

/** resolveArrTargetsChecked's targets alone — for the read paths, where an unknown cross-reference only means fewer copies. */
export async function resolveArrTargets(
  items: ReadonlyArray<{ tmdbId: number; mediaType: CleanupMediaType }>,
  index: ArrLibraryIndex,
  crossRef: CrossRefMode,
): Promise<Map<string, ArrLibraryEntry[]>> {
  return (await resolveArrTargetsChecked(items, index, crossRef)).targets;
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
