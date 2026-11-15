// Telling one series apart across TMDB, TVDB and Sonarr (guardrail 14a): the
// cached tvdb→tmdb and tmdb→tvdb cross-references, the wrong-series guards every
// Sonarr `series/lookup` goes through, and the lookup itself. Re-exported by
// arr.ts.
import { prisma } from "./prisma";
import { safeFetchTrusted } from "./safe-fetch";
import { mapLimit } from "./concurrency";
import { sanitizeForLog } from "./sanitize";
import { getCache, getCacheMany, setCache } from "./tmdb-cache";
import { tmdbAuth, type TmdbAuth } from "./tmdb-auth";
import { posInt } from "./arr-parse";
import { processSingleton } from "./process-singleton";
import { check, v } from "./validate";
import { arrFetch, strictRecordList, unusableAnswer, type ArrCfg, type ArrRecord } from "./arr-client";

// Resolved mappings are stable for a year; unresolved ones re-try daily in case TMDB eventually adds the show
const TVDB_TO_TMDB_TTL_RESOLVED   = 365 * 24 * 60 * 60;
const TVDB_TO_TMDB_TTL_UNRESOLVED =        24 * 60 * 60;

// The reverse direction (TMDB's own TVDB cross-reference) is only a fallback for
// shows Sonarr's metadata can't resolve by tmdb id yet — overwhelmingly brand-new
// ones — so an unresolved answer re-tries within hours, not a day.
const TMDB_TO_TVDB_TTL_RESOLVED   = 30 * 24 * 60 * 60;
const TMDB_TO_TVDB_TTL_UNRESOLVED =       6 * 60 * 60;

// The stored rows. A row of any other shape (an older writer, a hand edit) is a
// cache miss, never a mapping.
const TvdbToTmdbCache = v.object({ tmdbId: v.nullable(v.int()) });
export const TmdbToTvdbCache = v.object({ tvdbId: v.nullable(v.int()) });
type TvdbToTmdbCache = { tmdbId: number | null };
type TmdbToTvdbCache = { tvdbId: number | null };

// TMDB's /find answer: the first TV result is the show. A result without a
// positive integer id is an answer we can't use, never "no such show".
const TmdbFindAnswer = v.object({ tv_results: v.optional(v.nullable(v.array(v.object({ id: v.int() })))) });
const TmdbExternalIds = v.object({ tvdb_id: v.optional(v.unknown()) });

const TMDB_FIND_CONCURRENCY = 5;
const LOOKUP_FAILED = "failed" as const;

const tvdbToTmdbKey = (tvdbId: number) => `tvdb-to-tmdb:${tvdbId}`;

// The cached half: every id with a stored row lands in `into` (or is known to
// have no mapping); the ids with no usable row come back.
async function readCachedTvdbMappings(tvdbIds: readonly number[], into: Map<number, number>): Promise<number[]> {
  // One batched cache read for the whole id set, instead of one read per id
  // (hundreds of round-trips per sync on libraries where Sonarr gives no tmdbId).
  const cachedRows = await getCacheMany<unknown>(tvdbIds.map(tvdbToTmdbKey));
  const uncached: number[] = [];
  for (const tvdbId of tvdbIds) {
    const cached = cachedRows.get(tvdbToTmdbKey(tvdbId));
    const row = cached === undefined ? null : check(TvdbToTmdbCache, cached);
    if (row?.ok) {
      if (row.value.tmdbId !== null) into.set(tvdbId, row.value.tmdbId);
    } else {
      uncached.push(tvdbId);
    }
  }
  return uncached;
}

// The requests half: a request that stored both ids names the mapping. Each hit
// is cached; the ids still unknown come back.
async function resolveFromRequests(uncached: readonly number[], into: Map<number, number>): Promise<number[]> {
  const reqRows = await prisma.mediaRequest.findMany({
    where: { mediaType: "TV", tvdbId: { in: [...uncached] } },
    select: { tvdbId: true, tmdbId: true },
  });
  const fromReq = new Map<number, number>();
  for (const r of reqRows) if (r.tvdbId != null) fromReq.set(r.tvdbId, r.tmdbId);
  const stillUnknown: number[] = [];
  const fromReqHits: Array<[tvdbId: number, tmdbId: number]> = [];
  for (const tvdbId of uncached) {
    const tmdbId = fromReq.get(tvdbId);
    if (tmdbId !== undefined) {
      into.set(tvdbId, tmdbId);
      fromReqHits.push([tvdbId, tmdbId]);
    } else {
      stillUnknown.push(tvdbId);
    }
  }
  // Batched like the read above: a cold cache on a big library is one write per
  // series, so they run a few at a time rather than one round-trip after another.
  await mapLimit(fromReqHits, 8, ([tvdbId, tmdbId]) =>
    setCache(tvdbToTmdbKey(tvdbId), { tmdbId } satisfies TvdbToTmdbCache, TVDB_TO_TMDB_TTL_RESOLVED),
  );
  return stillUnknown;
}

// A cache write is an optimisation: a failed one must not discard the answer
// TMDB just gave.
async function rememberLookup(key: string, value: unknown, ttlSeconds: number): Promise<void> {
  try {
    await setCache(key, value, ttlSeconds);
  } catch (err) {
    console.warn("[arr] id-map cache write failed for %s:", sanitizeForLog(key), sanitizeForLog(err instanceof Error ? err.message : err));
  }
}

// One TMDB /find lookup: the tmdbId, null for "TMDB has no such show" (cached as
// unresolved), or LOOKUP_FAILED when no usable answer came back (nothing cached).
async function findTmdbIdForTvdb(tvdbId: number, auth: TmdbAuth): Promise<number | null | typeof LOOKUP_FAILED> {
  try {
    const url = new URL(`https://api.themoviedb.org/3/find/${tvdbId}`);
    url.searchParams.set("external_source", "tvdb_id");
    const res = await safeFetchTrusted(url.toString(), {
      allowedHosts: ["api.themoviedb.org"],
      headers: auth.headers,
      timeoutMs: 10_000,
    });
    if (!res.ok) {
      console.warn("[arr] tvdb-to-tmdb TMDB lookup returned %s for tvdbId %s", sanitizeForLog(res.status), sanitizeForLog(tvdbId));
      return LOOKUP_FAILED;
    }
    const answer = check(TmdbFindAnswer, await res.json());
    const first = answer.ok ? answer.value.tv_results?.[0] : undefined;
    if (!answer.ok || (first !== undefined && posInt(first.id) === null)) {
      console.warn("[arr] tvdb-to-tmdb TMDB lookup sent an unusable answer for tvdbId %s", sanitizeForLog(tvdbId));
      return LOOKUP_FAILED;
    }
    const tmdbId = first?.id ?? null;
    await rememberLookup(
      tvdbToTmdbKey(tvdbId),
      { tmdbId } satisfies TvdbToTmdbCache,
      tmdbId !== null ? TVDB_TO_TMDB_TTL_RESOLVED : TVDB_TO_TMDB_TTL_UNRESOLVED,
    );
    return tmdbId;
  } catch (err) {
    // Don't swallow: a TMDB 429/401/outage here silently drops every
    // tvdbId-only series from wanted/available/arrPending with no evidence.
    console.warn("[arr] tvdb-to-tmdb TMDB lookup failed for tvdbId %s:", sanitizeForLog(tvdbId), sanitizeForLog(err instanceof Error ? err.message : err));
    return LOOKUP_FAILED;
  }
}

// `hadErrors` is true when a lookup could not be completed this run (TMDB auth missing,
// or a TMDB request threw / returned non-2xx / sent an unusable answer). It lets callers
// that replace a cache from the result distinguish "series genuinely has no tmdb mapping"
// (safe to omit) from "we couldn't resolve it right now" (omitting it would wrongly evict
// a known series).
export async function resolveTvdbToTmdb(
  tvdbIds: number[],
): Promise<{ map: Map<number, number>; hadErrors: boolean }> {
  const map = new Map<number, number>();
  if (tvdbIds.length === 0) return { map, hadErrors: false };
  const uncached = await readCachedTvdbMappings(tvdbIds, map);
  if (uncached.length === 0) return { map, hadErrors: false };
  const stillUnknown = await resolveFromRequests(uncached, map);
  if (stillUnknown.length === 0) return { map, hadErrors: false };

  const auth = tmdbAuth();
  // Can't resolve any of the still-unknown series this run — report it so the
  // caller doesn't treat their absence as authoritative.
  if (!auth) return { map, hadErrors: true };

  // Bounded, not batched: a batch waited for its slowest lookup (10s each)
  // before the next one started.
  const outcomes = await mapLimit(stillUnknown, TMDB_FIND_CONCURRENCY, (tvdbId) => findTmdbIdForTvdb(tvdbId, auth));
  let hadErrors = false;
  for (let i = 0; i < stillUnknown.length; i++) {
    const outcome = outcomes[i];
    if (outcome === LOOKUP_FAILED) hadErrors = true;
    else if (outcome !== null) map.set(stillUnknown[i], outcome);
  }
  return { map, hadErrors };
}

/**
 * Resolves a single tvdbId to its tmdbId (cache → MediaRequest → TMDB). Returns null
 * when it can't be resolved. Used by the Sonarr webhook to evict the tmdbId-keyed
 * wanted-cache row when a Download event carries only a tvdbId and no MediaRequest
 * maps it.
 */
export async function resolveSingleTvdbToTmdb(tvdbId: number): Promise<number | null> {
  if (!Number.isInteger(tvdbId) || tvdbId <= 0) return null;
  const { map } = await resolveTvdbToTmdb([tvdbId]);
  return map.get(tvdbId) ?? null;
}

/**
 * TMDB's own TVDB id for a show (`/tv/{id}/external_ids` → `tvdb_id`), cached.
 * The fallback identity for a series Sonarr can't find by tmdb id: Sonarr's
 * metadata service (SkyHook) evidently answers id lookups from an index that
 * lags its series records by days for a new show. Observed live on
 * TMDB 304842, a week after its premiere: `term=tmdb:304842` answered [] while
 * TVDB 478738 already carried tmdbId 304842, so every approve failed with
 * "no series found" although a `tvdb:` lookup would have added it.
 *
 * Never throws — null means "no cross-reference available right now", and the
 * caller reports its original not-found. Only a definitive TMDB answer (a 200,
 * or a 404 for an id TMDB doesn't have) is cached; transient failures re-try.
 */
export async function resolveTmdbToTvdb(tmdbId: number): Promise<number | null> {
  if (!Number.isInteger(tmdbId) || tmdbId <= 0) return null;
  const key = `tmdb-to-tvdb:${tmdbId}`;
  try {
    const cached = await getCache<unknown>(key);
    const row = cached === null ? null : check(TmdbToTvdbCache, cached);
    if (row?.ok) return row.value.tvdbId;
    const auth = tmdbAuth();
    if (!auth) return null;
    const url = new URL(`https://api.themoviedb.org/3/tv/${tmdbId}/external_ids`);
    const res = await safeFetchTrusted(url.toString(), {
      allowedHosts: ["api.themoviedb.org"],
      headers: auth.headers,
      timeoutMs: 10_000,
    });
    if (!res.ok && res.status !== 404) {
      console.warn("[arr] tmdb-to-tvdb TMDB lookup returned %s for tmdbId %s", sanitizeForLog(res.status), sanitizeForLog(tmdbId));
      return null;
    }
    let tvdbId: number | null = null;
    if (res.ok) {
      const answer = check(TmdbExternalIds, await res.json());
      if (!answer.ok) {
        console.warn("[arr] tmdb-to-tvdb TMDB lookup sent an unusable answer for tmdbId %s", sanitizeForLog(tmdbId));
        return null;
      }
      tvdbId = posInt(answer.value.tvdb_id);
    }
    await rememberLookup(key, { tvdbId } satisfies TmdbToTvdbCache, tvdbId !== null ? TMDB_TO_TVDB_TTL_RESOLVED : TMDB_TO_TVDB_TTL_UNRESOLVED);
    return tvdbId;
  } catch (err) {
    console.warn("[arr] tmdb-to-tvdb lookup failed for tmdbId %s:", sanitizeForLog(tmdbId), sanitizeForLog(err instanceof Error ? err.message : err));
    return null;
  }
}

/**
 * Resolve a Sonarr `/series/lookup?term=tmdb:<id>` result to the RIGHT series.
 *
 * Sonarr degrades an unrecognized tmdb id into a fuzzy SkyHook title search, so a
 * non-empty response can be entirely unrelated shows — `results[0]` is then a
 * different series than the caller asked about. The add path has guarded this
 * since the wrong-series incident; the read paths' mistakes are quieter: a wrong
 * tvdbId reaches queue/library membership checks, gates the webhook's AVAILABLE
 * transition, and (via resolveTvdbIdFromTmdbId) is PERSISTED onto Issue.tvdbId,
 * where every later "Search"/"Grab release" acts on the wrong show and nothing
 * ever re-resolves it.
 *
 * Prefer the row whose tmdbId matches; accept index 0 only when the lookup
 * returned exactly one candidate, which is what a recognized id lookup yields.
 * Returns null rather than an unverified guess.
 */
export function pickSeriesByTmdbId<T extends { tmdbId?: unknown }>(results: readonly T[], tmdbId: number): T | null {
  const exact = results.find((r) => r.tmdbId === tmdbId);
  if (exact) return exact;
  if (results.length !== 1) return null;
  const lone = results[0]!;
  // A lone row is trusted only when Sonarr did not SAY which title it is (SkyHook
  // rows may omit tmdbId). One carrying a DIFFERENT positive tmdbId is a different
  // show, however many rows came back — observed live: `term=tmdb:84503` answered
  // with a single row whose tvdbId was 84503, a degraded id/text search that
  // matched the wrong series, and the webhook's ids-disagree guard then refused
  // a genuine Download event on the strength of it.
  const claimed = lone.tmdbId;
  const claimsAnotherTitle = typeof claimed === "number" && Number.isInteger(claimed) && claimed > 0;
  return claimsAnotherTitle ? null : lone;
}

/**
 * Pick the series a `/series/lookup?term=tvdb:<id>` answered for the TVDB id TMDB
 * gave us. Sonarr resolves a `tvdb:` term to exactly that series (its library row,
 * else SkyHook's record), so the row must carry the requested tvdbId. It is refused
 * when TVDB's own record names a DIFFERENT TMDB title: the two databases then
 * disagree about which show this is, and adding either would be a guess. A row with
 * no TMDB id of its own (Sonarr v3 never sends one) trusts TMDB's cross-reference.
 */
export function pickSeriesByTvdbCrossRef<T extends { tmdbId?: unknown; tvdbId?: unknown }>(
  results: readonly T[],
  tvdbId: number,
  tmdbId: number,
): T | null {
  const row = results.find((r) => r.tvdbId === tvdbId);
  if (!row) return null;
  const claimed = row.tmdbId;
  const claimsAnotherTitle = typeof claimed === "number" && Number.isInteger(claimed) && claimed > 0 && claimed !== tmdbId;
  return claimsAnotherTitle ? null : row;
}

// A lookup answer as rows. Not a list of objects is an unusable answer: it
// throws, as reading it as a list always did.
function lookupRows(raw: unknown): ArrRecord[] {
  const rows = strictRecordList(raw);
  if (!rows) throw unusableAnswer("Sonarr", "series lookup");
  return rows;
}

// The fallback half of every tmdb-keyed Sonarr series resolution: TMDB's TVDB
// cross-reference, then a `tvdb:` lookup verified by pickSeriesByTvdbCrossRef.
// `tvdbId` is what TMDB reported (null: nothing to try), whether or not it matched.
async function lookupSeriesByTvdbCrossRef(cfg: ArrCfg, tmdbId: number): Promise<{ series: ArrRecord | null; tvdbId: number | null }> {
  const tvdbId = await resolveTmdbToTvdb(tmdbId);
  if (tvdbId === null) return { series: null, tvdbId };
  const rows = lookupRows(await arrFetch<unknown>(cfg, `/api/v3/series/lookup?term=tvdb:${tvdbId}`));
  return { series: pickSeriesByTvdbCrossRef(rows, tvdbId, tmdbId), tvdbId };
}

/** How a tmdb id resolved to a Sonarr series, for a caller that explains a miss (the add). */
export interface SonarrSeriesResolution {
  /** The verified lookup row, or null. */
  series: ArrRecord | null;
  /** How many rows the `tmdb:` lookup answered with. */
  candidates: number;
  /** The TVDB id TMDB's cross-reference offered, when the fallback ran and had one. */
  crossRefTvdbId: number | null;
}

/**
 * The ONE `series/lookup?term=tmdb:` call: Sonarr by tmdb id through the
 * wrong-series guard, then — unless `tvdbCrossRef: false` keeps the resolution
 * Sonarr-sourced (the webhook's download verify, the one caller that must not
 * let TMDB data decide) — TMDB's TVDB cross-reference (resolveTmdbToTvdb).
 */
export async function resolveSonarrSeries(
  cfg: ArrCfg,
  tmdbId: number,
  opts: { tvdbCrossRef?: boolean } = {},
): Promise<SonarrSeriesResolution> {
  const rows = lookupRows(await arrFetch<unknown>(cfg, `/api/v3/series/lookup?term=tmdb:${tmdbId}`));
  const direct = pickSeriesByTmdbId(rows, tmdbId);
  if (direct || opts.tvdbCrossRef === false) return { series: direct, candidates: rows.length, crossRefTvdbId: null };
  const crossRef = await lookupSeriesByTvdbCrossRef(cfg, tmdbId);
  return { series: crossRef.series, candidates: rows.length, crossRefTvdbId: crossRef.tvdbId };
}

// The row's fields are Sonarr's: read them defensively (posInt, titleSlugOf).
export async function lookupSeriesByTmdbId(
  cfg: ArrCfg,
  tmdbId: number,
  opts: { tvdbCrossRef?: boolean } = {},
): Promise<ArrRecord | null> {
  return (await resolveSonarrSeries(cfg, tmdbId, opts)).series;
}

// ── the lookup's ids, cached ─────────────────────────────────────────────────
// `series/lookup` makes Sonarr query its internet metadata service, so it is
// slow and, when that service stalls, times out. The download check, the
// library scan's retries and the issue form ask it the same question about the
// same show again and again; a verified answer is reused for a while. Only a
// FOUND series is kept: a miss is usually a brand-new show the lookup will find
// soon. The webhook's verify and the arr-state diagnostic never read this.

const SERIES_LOOKUP_TTL_MS = 30 * 60 * 1000;
const SERIES_LOOKUP_CACHE_MAX = 2_000;

export interface LookedUpSeries {
  tvdbId: number;
  firstAired: string | null;
}

const seriesLookupCache = processSingleton(
  "arr-id-map:seriesLookupCache",
  () => new Map<string, { value: LookedUpSeries; expiresAt: number }>(),
);

/**
 * The series' tvdbId (and first-aired date) for a tmdb id, through the lookup
 * and its TMDB cross-reference fallback, or null when it doesn't resolve to a
 * series with a usable tvdbId. Throws when Sonarr can't be read.
 */
export async function lookupSeriesIdsCached(cfg: ArrCfg, tmdbId: number): Promise<LookedUpSeries | null> {
  const key = `${cfg.url}\u0000${tmdbId}`;
  const now = Date.now();
  const hit = seriesLookupCache.get(key);
  if (hit && hit.expiresAt > now) return hit.value;
  if (hit) seriesLookupCache.delete(key);

  const { series } = await resolveSonarrSeries(cfg, tmdbId);
  // A lookup row is never schema-checked by Sonarr's contract alone: a tvdbId
  // that isn't a positive integer can't name a series anywhere below.
  const tvdbId = posInt(series?.tvdbId);
  if (!series || tvdbId === null) return null;
  const value: LookedUpSeries = { tvdbId, firstAired: typeof series.firstAired === "string" && series.firstAired ? series.firstAired : null };
  if (seriesLookupCache.size >= SERIES_LOOKUP_CACHE_MAX) {
    // Oldest first (a Map iterates in insertion order).
    const oldest = seriesLookupCache.keys().next();
    if (!oldest.done) seriesLookupCache.delete(oldest.value);
  }
  seriesLookupCache.set(key, { value, expiresAt: now + SERIES_LOOKUP_TTL_MS });
  return value;
}

/** Test seam: forget every cached lookup, so one case's answer can't serve the next. */
export function _resetSeriesLookupCacheForTests(): void {
  seriesLookupCache.clear();
}
