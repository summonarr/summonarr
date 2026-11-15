import "server-only";
import { after } from "next/server";
import { getCacheStale, getCacheStaleMany } from "@/lib/tmdb-cache";
import type { TmdbMedia } from "@/lib/tmdb-types";
import type { OmdbRatings } from "@/lib/omdb";
import { getOmdbRatingsForTmdb, omdbCacheKey, revalidateOmdbForTmdb } from "@/lib/omdb";
import type { MdblistCallOptions, MdblistRatings, MdblistResult } from "@/lib/mdblist";
import {
  getMdblistRatingsForTmdb, fetchMdblistBatch, isMdblistKeyConfigured, isMdblistKeyRejected, isMdblistQuotaLocked,
  mdblistCacheKey,
} from "@/lib/mdblist";
import { mapLimit } from "@/lib/concurrency";
import { processSingleton } from "@/lib/process-singleton";

// Cap concurrent OMDB fallback chains. Each chain does a TMDB external_ids lookup
// + an OMDB fetch + cache reads/writes; an unbounded Promise.all over the miss set
// would saturate the Prisma pool and burst OMDB (free tier is 1k/day). 6 keeps it
// gentle while still parallelizing.
const OMDB_FALLBACK_CONCURRENCY = 6;

// Cap the COUNT of OMDB chains awaited in the request path (blocking mode only).
// Concurrency alone doesn't bound the spend: the miss set is as long as the caller's
// item list, and callers like /top pass the whole pooled catalogue (~hundreds of
// titles) rather than one page — enough to exhaust the free tier's 1k/day on a
// single cold load and trip the quota lockout site-wide. The overflow is deferred to
// after(), so the cache still fills and the next load serves those titles warm.
const MAX_BLOCKING_OMDB_MISSES = 200;

// MDBList provides richer data than OMDB; this is the canonical merge function for list-based flows.
function applyMdblist(item: TmdbMedia, d: MdblistRatings): TmdbMedia {
  return {
    ...item,
    imdbId:           d.imdbId,
    imdbRating:       d.imdbRating,
    imdbVotes:        d.imdbVotes,
    rottenTomatoes:   d.rottenTomatoes,
    rtAudienceScore:  d.rtAudienceScore,
    metacritic:       d.metacritic,
    traktRating:      d.traktRating,
    letterboxdRating: d.letterboxdRating,
    mdblistScore:     d.mdblistScore,
    malRating:        d.malRating,
    rogerEbertRating: d.rogerEbertRating,
    releasedDigital:  d.releasedDigital,

    // Prefer an already-resolved YouTube trailerKey over the MDBList trailer URL to avoid
    // overwriting a direct key with a potentially different or lower-quality source.
    ...(item.trailerKey ? {} : { trailerUrl: d.trailerUrl }),
  };
}

function applyOmdb(item: TmdbMedia, d: OmdbRatings): TmdbMedia {
  return {
    ...item,
    imdbId:         d.imdbId,
    imdbRating:     d.imdbRating,
    imdbVotes:      d.imdbVotes,
    rottenTomatoes: d.rottenTomatoes,
    metacritic:     d.metacritic,
  };
}

// An MDBList row with nothing in it — what an OMDB-only answer is overlaid onto.
const EMPTY_MDBLIST_RATINGS: MdblistRatings = {
  imdbId: null,
  imdbRating: null,
  imdbVotes: null,
  rottenTomatoes: null,
  rtAudienceScore: null,
  metacritic: null,
  traktRating: null,
  letterboxdRating: null,
  mdblistScore: null,
  malRating: null,
  rogerEbertRating: null,
  releasedDigital: null,
  trailerUrl: null,
};

// Unified single-item ratings result. `data` always follows the MdblistRatings
// shape regardless of which source served it — an OMDB hit maps into it with
// null for the fields OMDB lacks.
export type UnifiedRatingsResult = {
  found: boolean;
  keyConfigured: boolean;
  transient?: boolean;
  quotaExhausted?: boolean;
  data?: MdblistRatings;
};

// Single-item counterpart to attachRatingsUnified — same source-arbitration policy.
// MDBList is tried first because it returns more ratings fields (Trakt, Letterboxd,
// RT Audience, MDBList score, MAL, Roger Ebert). OMDB is consulted as a fallback
// whenever MDBList cannot serve the item — no key configured, the item is genuinely
// absent, or MDBList is quota-locked — so a single source being unavailable doesn't
// leave the title with no ratings at all. `knownImdbId` (optional) spares a cold
// OMDB fallback its TMDB external_ids resolve — the detail fetchers already hold
// the id from their own append_to_response=external_ids.
//
// `background: true` marks a cron caller: MDBList then stops at the reserve the
// plan setting keeps for pages (mdblist-plan.ts).
//
// `admitCold` holds a user to their budget of cold lookups
// (ratings-cold-budget.ts): it is asked once, and only when this call would
// send something upstream for a title with nothing cached. Refused, the title
// is answered from the cache alone — no MDBList, TMDB or OMDb call, not even a
// detached one. A warm or stale title is never asked about.
export async function fetchUnifiedRatings(
  tmdbId: number,
  mediaType: "movie" | "tv",
  releaseDate?: string | null,
  knownImdbId?: string | null,
  opts: { background?: boolean; admitCold?: () => boolean } = {},
): Promise<UnifiedRatingsResult> {
  const mdbOpts = { background: opts.background };
  if (opts.admitCold) {
    const cached = await readCachedUnified(tmdbId, mediaType, mdbOpts);
    if (cached.cold && !opts.admitCold()) return cached.result;
  }
  const mdb = await getMdblistRatingsForTmdb(tmdbId, mediaType, releaseDate, mdbOpts).catch(
    (): MdblistResult => ({ found: false, keyConfigured: true, transient: true }),
  );
  // Require an actual score before letting MDBList win — a `found` row with every
  // field null must not shadow OMDB, which may carry the rating. Fall through to
  // OMDB when MDBList has no usable data.
  if (mdb.found && hasAnyMdblistRating(mdb.data)) {
    // Per-FIELD parity with the warm batch path (overlayOmdb in mergeWarm): an
    // MDBList row carrying only Trakt/Letterboxd-style fields must not blank
    // the IMDb/RT/Metacritic badges a warm OMDB row already holds. Cache-only
    // (serve-stale) — this branch never pays an OMDB fetch for the overlay.
    const d = mdb.data;
    if (d.imdbId == null || d.imdbRating == null || d.imdbVotes == null || d.rottenTomatoes == null || d.metacritic == null) {
      const { value } = await getCacheStale<OmdbRatings | { _notFound: true }>(omdbCacheKey(mediaType, tmdbId));
      if (value && !("_notFound" in value)) {
        return { found: true, keyConfigured: true, data: overlayOmdb(d, value) };
      }
    }
    return { found: true, keyConfigured: true, data: mdb.data };
  }

  const omdb = await getOmdbRatingsForTmdb(tmdbId, mediaType, releaseDate, knownImdbId).catch(
    () => ({ found: false, keyConfigured: true, transient: true } as const),
  );
  if (omdb.found) {
    // A found-but-unscored MDBList row still carries authoritative per-field
    // nulls plus possible trailer/digital-release metadata — overlay OMDB's
    // fields onto it (per-field, the warm path's overlayOmdb) instead of
    // discarding it for a null-filled literal.
    // An OMDB hit alone maps into the MdblistRatings shape with null for the
    // fields OMDB lacks — the same per-field overlay, onto an empty row.
    return { found: true, keyConfigured: true, data: overlayOmdb(mdb.found ? mdb.data : EMPTY_MDBLIST_RATINGS, omdb.data) };
  }
  // If either source failed transiently, the null is not authoritative — callers must
  // not pin it into the long-lived details cache, so the next read retries.
  // mdb can reach here as not-found OR as found-but-unscored. A found result means
  // the key worked and the response was real → keyConfigured, not transient —
  // narrow on mdb.found before touching the not-found-only fields.
  const mdbKeyConfigured = mdb.found ? true : mdb.keyConfigured;
  const mdbTransient = mdb.found ? false : Boolean(mdb.transient);
  const mdbQuotaExhausted = mdb.found ? false : Boolean(mdb.quotaExhausted);
  const transient = Boolean(mdbTransient || omdb.transient);
  return {
    found: false,
    keyConfigured: mdbKeyConfigured || omdb.keyConfigured,
    transient,
    // Surfaced so the ratings-warm cron can stop its remaining batches instead of
    // re-confirming the same exhaustion once per item.
    ...(mdbQuotaExhausted ? { quotaExhausted: true } : {}),
  };
}

// One title's cached rows, and whether answering it live would go upstream for
// a title with nothing cached. `result` is what the cache alone can say: the
// same source arbitration as the live path, and `transient` when it has
// nothing, so a caller never pins that null as an authoritative "no ratings".
async function readCachedUnified(
  tmdbId: number,
  mediaType: "movie" | "tv",
  mdbOpts: MdblistCallOptions,
): Promise<{ cold: boolean; result: UnifiedRatingsResult }> {
  const [mdbRow, omdbRow] = await Promise.all([
    getCacheStale<MdblistRatings | { _notFound: true }>(mdblistCacheKey(mediaType, tmdbId)),
    getCacheStale<OmdbRatings | { _notFound: true }>(omdbCacheKey(mediaType, tmdbId)),
  ]);
  const mdb = mdbRow.value && !("_notFound" in mdbRow.value) ? mdbRow.value : null;
  const omdb = omdbRow.value && !("_notFound" in omdbRow.value) ? omdbRow.value : null;
  const mdbUsable = mdb !== null && hasAnyMdblistRating(mdb);
  // MDBList's cold path runs when it holds no row of any kind; OMDb's when
  // MDBList has nothing to show and OMDb holds no row either.
  const cold =
    (mdbRow.value === null && (await mdblistWouldBeAsked(mdbOpts))) ||
    (!mdbUsable && omdbRow.value === null);
  let result: UnifiedRatingsResult;
  if (mdb && mdbUsable) result = { found: true, keyConfigured: true, data: omdb ? overlayOmdb(mdb, omdb) : mdb };
  else if (omdb) result = { found: true, keyConfigured: true, data: overlayOmdb(mdb ?? EMPTY_MDBLIST_RATINGS, omdb) };
  else result = { found: false, keyConfigured: true, transient: true };
  return { cold, result };
}

// Whether a title with no MDBList row would actually be sent to MDBList now:
// a key is stored, MDBList hasn't refused it, and nothing has paused the calls.
// With no key (an OMDb-only install) every title lacks an MDBList row forever,
// and charging a user's cold budget for each of them on every page would spend
// it on titles that cost nothing upstream.
async function mdblistWouldBeAsked(mdbOpts: MdblistCallOptions): Promise<boolean> {
  if (isMdblistQuotaLocked(mdbOpts) || isMdblistKeyRejected()) return false;
  return isMdblistKeyConfigured();
}

// Batch ratings merge with serve-stale semantics: a warm-cache entry — fresh OR
// expired — is always served from the table (mergeWarm); expired entries are
// revalidated after the response in BOTH modes, never in the request path. Only
// items with no cached row at all are misses (blocking mode fetches those inline;
// non-blocking mode defers them to after()). Matches the single-item getters'
// stale-while-revalidate behaviour.
//
// `deferToAfter: false` runs that post-response work before returning instead.
// It is for callers with no response to protect: a cron batching titles through
// here. Next queues every after() callback of a request and starts them ALL at
// once when the response closes (AfterContext's p-queue has no concurrency
// limit), so a caller that makes one call per batch releases every batch's
// refreshes together. The recommendation verdict pass did exactly that, one
// callback per 200 titles, and the burst came back as a wall of TMDB 429s.
//
// `background: true` marks a cron caller: MDBList then stops at the reserve the
// plan setting keeps for pages, and reads as paused once it does (mdblist-plan.ts).
//
// `maxBlockingMisses` (blocking only) lowers the count of OMDB chains awaited in
// the request; the rest are deferred like the stale refreshes.
//
// `admitMiss` is asked once per genuine miss before anything upstream is sent
// for it — in BOTH modes, so a refused miss is neither fetched in the request
// nor warmed after it — and it is served from the warm cache only this time.
// A miss that would send nothing (an OMDb row is cached and MDBList would not
// be asked) is never charged. It is how a caller holds a user to a budget of
// cold lookups (ratings-cold-budget.ts): the ratings batch route and every
// list attachAllAvailability enriches for a signed-in user.
export interface AttachRatingsOptions {
  blocking?: boolean;
  deferToAfter?: boolean;
  background?: boolean;
  maxBlockingMisses?: number;
  admitMiss?: () => boolean;
}

// What a page's items need, read off the warm cache.
interface RatingsPlan {
  // No MDBList state at all: fetched (inline when blocking, else after the response).
  misses: TmdbMedia[];
  // Served from an expired MDBList row; revalidated after the response.
  staleMdblist: TmdbMedia[];
  // Served from an expired OMDB row with no usable MDBList row; refreshed after the response.
  staleOmdb: TmdbMedia[];
}

// `admit` is the caller's cold-lookup budget; `mdblistAsked` says whether a
// title with no MDBList row would be sent to MDBList in this call (it only
// matters with `admit`).
function planRatings(items: TmdbMedia[], warm: WarmCache, admit?: () => boolean, mdblistAsked = true): RatingsPlan {
  // Stale routing (both modes): an item whose MDBList entry is stale revalidates via
  // the MDBList batch — the primary source — even when its OMDB entry is stale too.
  // The OMDB path is only for items whose warm data came from OMDB, i.e. with no
  // MDBList *value* at all (a fresh MDBList _notFound sentinel doesn't block it —
  // such an item's ratings are the OMDB row's).
  const staleMdblist = items.filter((item) => warm.staleKeys.has(mdblistKey(item)));
  const staleOmdb = items.filter((item) => {
    if (!warm.staleKeys.has(omdbKey(item))) return false;
    if (warm.staleKeys.has(mdblistKey(item))) return false; // the MDBList batch revalidates it
    // Gate on a USABLE MDBList row, not merely a present one. MDBList can keep
    // returning a fresh "indexed but no scores" row forever. For such a title
    // the ratings shown come from the OMDB row (mergeWarm falls through to it),
    // so that OMDB row must still get refreshed. Every other admission decision
    // in this file gates on hasAnyMdblistRating the same way.
    const mdb = warm.byMdblist.get(mdblistKey(item));
    return !(mdb && hasAnyMdblistRating(mdb));
  });

  // Only MDBLIST state makes a miss: misses feed the MDBList batch — the primary
  // source — so no OMDB row of ANY shape may exclude a title from it. Otherwise
  // an OMDB row written while MDBList was off or quota-locked would keep the
  // title away from MDBList forever, and it could never gain the
  // Trakt/Letterboxd/RT-Audience/MDBList fields OMDB lacks. Re-admitting costs
  // one extra id in a batch POST; mergeWarm keeps serving the OMDB row until
  // the batch lands, and a genuine MDBList miss then writes a "not found"
  // marker that gates via negativeKeys. A _notFound sentinel (negativeKeys —
  // fresh or stale) is an authoritative "no ratings": re-fetching it every call
  // would burn MDBList/OMDB quota on titles known to be absent. Stale value rows
  // likewise serve from the warm maps and revalidate post-response.
  const misses: TmdbMedia[] = [];
  for (const item of items) {
    if (!isMdblistMiss(item, warm)) continue;
    // Charged only when something goes upstream for it: the MDBList batch, or
    // the OMDb chain for a title with no OMDb row.
    if (admit && (mdblistAsked || lacksOmdbRow(item, warm)) && !admit()) continue;
    misses.push(item);
  }
  return { misses, staleMdblist, staleOmdb };
}

export async function attachRatingsUnified(
  items: TmdbMedia[],
  opts: AttachRatingsOptions = {},
): Promise<TmdbMedia[]> {
  if (items.length === 0) return items;
  const mdbOpts = { background: opts.background };
  const runDeferred = async (work: () => Promise<void>): Promise<void> => {
    if (opts.deferToAfter === false) await work();
    else after(work);
  };

  const warm = await readCachedRatings(items);
  // Only a budgeted call with at least one MDBList miss needs to know whether
  // MDBList would be asked (a settings read, memoized in mdblist.ts).
  const budgeted = opts.admitMiss !== undefined && items.some((item) => isMdblistMiss(item, warm));
  const plan = planRatings(items, warm, opts.admitMiss, budgeted ? await mdblistWouldBeAsked(mdbOpts) : true);

  if (!opts.blocking) {
    if (plan.misses.length > 0 || plan.staleMdblist.length > 0 || plan.staleOmdb.length > 0) {
      // Non-blocking path: fire background fetches after the response is sent so the user isn't
      // held waiting; the next page load will hit the warm cache. Stale-served entries
      // revalidate here too — never before the response.
      await runDeferred(() => fetchPlanInBackground(plan, warm, mdbOpts));
    }
    return items.map((item) => mergeWarm(item, warm));
  }

  const inline = await fetchMissesInline(plan.misses, warm, mdbOpts, opts.maxBlockingMisses ?? MAX_BLOCKING_OMDB_MISSES);

  // Stale revalidation never blocks the response — only genuine misses are fetched
  // inline above (capped at maxInline); entries served stale, and the capped-out
  // misses, refresh after the response, same as the non-blocking path.
  if (plan.staleMdblist.length > 0 || plan.staleOmdb.length > 0 || inline.deferredOmdb.length > 0) {
    await runDeferred(() => refreshAfterResponse(plan, inline.deferredOmdb, warm, mdbOpts));
  }

  return items.map((item) => mergeFetched(item, inline.fetched, warm));
}

// ── shared steps ────────────────────────────────────────────────────────────

// A rating found in this call, by `${mediaType}:${id}` (fetchedKey) — NOT bare
// tmdbId: a movie and a TV show can share a TMDB id (independent id spaces), so
// a bare-id map would cross-contaminate their ratings within a single batch.
type FetchedRatings = Map<string, { source: "mdblist"; data: MdblistRatings } | { source: "omdb"; data: OmdbRatings }>;

// The non-blocking path's after-the-response work: misses and stale MDBList rows
// through one MDBList batch, the OMDB fallback for what it could not serve, and
// the stale OMDB rows.
async function fetchPlanInBackground(plan: RatingsPlan, warm: WarmCache, mdbOpts: MdblistCallOptions): Promise<void> {
  if (!isMdblistQuotaLocked(mdbOpts)) {
    // Stale MDBList revalidations ride the same batch POSTs as the genuine
    // misses — one request per 200 ids instead of N singles. Titles another
    // request is already batching are left to it (see fetchMdblistCoalesced).
    const { claimed, ratings } = await fetchMdblistCoalesced([...plan.misses, ...plan.staleMdblist], mdbOpts, false);
    // Only genuinely-uncached items THIS call batched feed the OMDB fallback. A
    // stale item absent from a full batch response just had its _notFound
    // sentinel refreshed by fetchMdblistBatch — chasing it through OMDB would
    // burn quota for nothing — and a miss another request is batching gets its
    // fallback from that request. Every title MDBList could not serve goes to
    // OMDB (no key, a genuine miss, a failed page, or a mid-batch quota trip):
    // the decision is per title, never a sample of one.
    const stillMissing = plan.misses.filter((m) => claimed.has(mdblistKey(m)) && !usableMdblist(ratings, m));
    await omdbColdFallback(stillMissing, warm);
  } else if (plan.misses.length > 0) {
    // Quota-locked: genuine misses have nothing to show, so OMDB is worth the spend.
    // Stale MDBList entries are NOT rerouted to OMDB — their data is stale-but-present,
    // and burning OMDB quota to refresh it is a bad trade; they revalidate once the
    // MDBList lock lifts.
    await omdbColdFallback(plan.misses, warm);
  }
  await refreshStaleOmdb(plan.staleOmdb);
}

// The blocking path's misses, fetched in the request: MDBList first (awaiting
// any batch another request already has in flight for the same titles), then
// OMDB for what MDBList could not serve — the first `maxInline` inline, the
// rest handed back to be warmed after the response.
async function fetchMissesInline(
  misses: TmdbMedia[],
  warm: WarmCache,
  mdbOpts: MdblistCallOptions,
  maxInline: number,
): Promise<{ fetched: FetchedRatings; deferredOmdb: TmdbMedia[] }> {
  const fetched: FetchedRatings = new Map();
  if (misses.length === 0) return { fetched, deferredOmdb: [] };
  if (!isMdblistQuotaLocked(mdbOpts)) {
    const { ratings } = await fetchMdblistCoalesced(misses, mdbOpts, true);
    // Only count an MDBList batch row as a hit when it carries a rating. Rows for
    // indexed-but-unscored titles (every score null) would otherwise skip the
    // OMDB fallback, leaving a title OMDB *could* rate showing none. (mergeWarm
    // gates the warm-cache path the same way.)
    for (const [key, data] of ratings) if (hasAnyMdblistRating(data)) fetched.set(key, { source: "mdblist", data });
  }
  // A single source being unavailable must not leave the title with no ratings.
  const candidates = misses.filter((m) => !fetched.has(fetchedKey(m)) && lacksOmdbRow(m, warm));
  await omdbColdFallback(candidates.slice(0, maxInline), warm, (item, data) => {
    fetched.set(fetchedKey(item), { source: "omdb", data });
  });
  return { fetched, deferredOmdb: candidates.slice(maxInline) };
}

// The blocking path's after-the-response work.
async function refreshAfterResponse(plan: RatingsPlan, overflow: TmdbMedia[], warm: WarmCache, mdbOpts: MdblistCallOptions): Promise<void> {
  if (plan.staleMdblist.length > 0 && !isMdblistQuotaLocked(mdbOpts)) {
    // Same quota-efficient shape as the non-blocking path: one batch POST per media
    // type. An item absent from a full response gets its _notFound sentinel refreshed
    // by fetchMdblistBatch — no OMDB chase for stale entries. When quota-locked these
    // items are NOT rerouted to OMDB: their data is stale-but-present, and burning
    // OMDB quota to refresh it is a bad trade; they revalidate once the lock lifts.
    await fetchMdblistCoalesced(plan.staleMdblist, mdbOpts, false);
  }
  // Misses the inline cap left unfetched: warm them here so they're served from
  // the table on the next load rather than being chased in the request path.
  await omdbColdFallback(overflow, warm);
  await refreshStaleOmdb(plan.staleOmdb);
}

// One item with what this call fetched for it, else with the warm cache.
function mergeFetched(item: TmdbMedia, fetched: FetchedRatings, warm: WarmCache): TmdbMedia {
  const fresh = fetched.get(fetchedKey(item));
  if (!fresh) return mergeWarm(item, warm);
  if (fresh.source === "omdb") return applyOmdb(item, fresh.data);
  // Per-FIELD parity with mergeWarm: a miss is admitted to the MDBList batch
  // even when a warm OMDB row exists, so a fresh MDBList hit carrying only
  // Trakt/Letterboxd-style fields must not blank the IMDb/RT/Metacritic
  // values that OMDB row already holds.
  const warmOmdb = warm.byOmdb.get(omdbKey(item));
  return applyMdblist(item, warmOmdb ? overlayOmdb(fresh.data, warmOmdb) : fresh.data);
}

// One MDBList batch per media type (the bulk endpoint is type-specific), keyed
// `${mediaType}:${id}` (fetchedKey). Never rejects: a batch that throws (its
// key or plan read failing) degrades to "no answer", and the page is served
// from the warm cache and the OMDB fallback like any other miss.
async function fetchMdblistByType(items: TmdbMedia[], mdbOpts: MdblistCallOptions): Promise<Map<string, MdblistRatings>> {
  const movies = items.filter((m) => m.mediaType === "movie");
  const shows = items.filter((m) => m.mediaType === "tv");
  const out = new Map<string, MdblistRatings>();
  try {
    const [movieRatings, tvRatings] = await Promise.all([
      movies.length > 0 ? fetchMdblistBatch(movies, "movie", mdbOpts) : Promise.resolve(new Map<number, MdblistRatings>()),
      shows.length > 0 ? fetchMdblistBatch(shows, "tv", mdbOpts) : Promise.resolve(new Map<number, MdblistRatings>()),
    ]);
    for (const [id, data] of movieRatings) out.set(`movie:${id}`, data);
    for (const [id, data] of tvRatings) out.set(`tv:${id}`, data);
  } catch (err) {
    console.warn("[ratings] MDBList batch failed; serving the cache and the OMDB fallback:", err instanceof Error ? err.message : err);
  }
  return out;
}

// The MDBList titles a batch is sending right now, process-wide (guardrail
// 27a), each with the answer its batch will give. Concurrent renders of one page
// (two viewers, a prefetch and the navigation) each sent the same batch, and
// every one of them POSTed the same ids until the first one's cache writes
// landed: MDBList quota spent for nothing. The cold per-title path coalesces in
// mdblist.ts; this is the batch's counterpart. Keyed by caller class too (as
// mdblist.ts's coldInflightKey is): a page must not wait on a background batch
// that stops at the reserve kept for pages.
const mdblistBatchInflight = processSingleton(
  "omdb-availability:mdblist-batch-answers",
  () => new Map<string, Promise<MdblistRatings | undefined>>(),
);

function inflightKey(item: TmdbMedia, mdbOpts: MdblistCallOptions): string {
  return `${mdblistKey(item)}|${mdbOpts.background ? "bg" : "fg"}`;
}

// fetchMdblistByType for the titles no other batch is sending. Returns which
// mdblist keys THIS call claimed, so the caller only chases its own. With
// `awaitOthers` (the blocking path, which serves the answer in this response)
// the titles another batch is sending are waited on and their answers merged
// in; without it (after the response) they are simply left to that batch.
async function fetchMdblistCoalesced(
  items: TmdbMedia[],
  mdbOpts: MdblistCallOptions,
  awaitOthers: boolean,
): Promise<{ claimed: Set<string>; ratings: Map<string, MdblistRatings> }> {
  const claimed = new Set<string>();
  const mine: TmdbMedia[] = [];
  const others: { item: TmdbMedia; answer: Promise<MdblistRatings | undefined> }[] = [];
  const seen = new Set<string>();
  for (const item of items) {
    const key = inflightKey(item, mdbOpts);
    if (seen.has(key)) continue;
    seen.add(key);
    const pending = mdblistBatchInflight.get(key);
    if (pending) {
      if (awaitOthers) others.push({ item, answer: pending });
      continue;
    }
    claimed.add(mdblistKey(item));
    mine.push(item);
  }
  // fetchMdblistByType never rejects, so neither do the per-title answers.
  const batch = mine.length > 0 ? fetchMdblistByType(mine, mdbOpts) : Promise.resolve(new Map<string, MdblistRatings>());
  for (const item of mine) mdblistBatchInflight.set(inflightKey(item, mdbOpts), batch.then((m) => m.get(fetchedKey(item))));
  try {
    const ratings = await batch;
    for (const { item, answer } of others) {
      const data = await answer;
      if (data) ratings.set(fetchedKey(item), data);
    }
    return { claimed, ratings };
  } finally {
    for (const item of mine) mdblistBatchInflight.delete(inflightKey(item, mdbOpts));
  }
}

// Whether a batch answer holds a rating for this title: an indexed-but-unscored
// (all-null) row has nothing to display, so it stays a candidate for the OMDB
// fallback.
function usableMdblist(ratings: Map<string, MdblistRatings>, item: TmdbMedia): boolean {
  const data = ratings.get(fetchedKey(item));
  return data !== undefined && hasAnyMdblistRating(data);
}

// The OMDB fallback for titles with no OMDB row at all (lacksOmdbRow: the getter
// stays on its cold path, whose refresh is awaited, so the limit bounds the
// upstream calls — guardrail 31a). `onHit` sees each rating found.
async function omdbColdFallback(
  items: TmdbMedia[],
  warm: WarmCache,
  onHit?: (item: TmdbMedia, data: OmdbRatings) => void,
): Promise<void> {
  const cold = items.filter((item) => lacksOmdbRow(item, warm));
  if (cold.length === 0) return;
  await mapLimit(cold, OMDB_FALLBACK_CONCURRENCY, async (item) => {
    const omdb = await getOmdbRatingsForTmdb(item.id, item.mediaType, item.releaseDate).catch(() => null);
    if (omdb && omdb.found) onHit?.(item, omdb.data);
  });
}

// Items whose warm data came from an expired OMDB row. Awaited refresh, not the
// getter: see revalidateOmdbForTmdb for why the getter's limit is illusory.
async function refreshStaleOmdb(items: TmdbMedia[]): Promise<void> {
  if (items.length === 0) return;
  await mapLimit(items, OMDB_FALLBACK_CONCURRENCY, (item) =>
    revalidateOmdbForTmdb(item.id, item.mediaType, item.releaseDate).catch(() => {}));
}

function mdblistKey(item: TmdbMedia): string { return mdblistCacheKey(item.mediaType, item.id); }
function omdbKey(item: TmdbMedia): string    { return omdbCacheKey(item.mediaType, item.id); }
function fetchedKey(item: TmdbMedia): string { return `${item.mediaType}:${item.id}`; }

// Whether the OMDB fallback should fetch this title at all. A title with ANY OMDB
// row (a value or a not-found sentinel, fresh or stale) gets nothing new from the
// getter: it hands back the row mergeWarm already serves. For a stale row the
// getter would also detach a refresh that no concurrency limit reaches, once per
// title per call on an MDBList-less instance, where every title is a miss. The
// staleOmdb pass refreshes those rows instead, awaited.
function lacksOmdbRow(item: TmdbMedia, warm: WarmCache): boolean {
  const key = omdbKey(item);
  return !warm.byOmdb.has(key) && !warm.negativeKeys.has(key);
}

// No MDBList state at all for this title: neither a row nor a not-found marker.
function isMdblistMiss(item: TmdbMedia, warm: WarmCache): boolean {
  const key = mdblistKey(item);
  return !warm.byMdblist.has(key) && !warm.negativeKeys.has(key);
}

type WarmCache = {
  byMdblist: Map<string, MdblistRatings>;
  byOmdb: Map<string, OmdbRatings>;
  negativeKeys: Set<string>;
  // Keys (either scheme) whose row was served past its expiresAt. Every stale key
  // also appears in byMdblist/byOmdb or negativeKeys — stale entries are served,
  // then revalidated post-response by attachRatingsUnified.
  staleKeys: Set<string>;
};

// Warm-cache read for a page of items, with serve-stale semantics (matching the
// single-item getters' getCacheStale behaviour): an expired row is still a hit —
// its value is served immediately and its key is reported in staleKeys so the
// caller can revalidate it after the response. Only a truly absent (or
// unparseable) row is a miss. _notFound sentinel rows — fresh OR stale — land in
// negativeKeys: a stale sentinel still reads as "no ratings" for display, and the
// post-response revalidation is what refreshes it, so sentinels never re-enter
// the miss fan-out and burn MDBList/OMDB quota on every page load.
async function readCachedRatings(items: TmdbMedia[]): Promise<WarmCache> {
  const mdblistKeys = items.map(mdblistKey);
  const omdbKeys    = items.map(omdbKey);

  const [mdblistEntries, omdbEntries] = await Promise.all([
    getCacheStaleMany<MdblistRatings | { _notFound: true } | null>(mdblistKeys),
    getCacheStaleMany<OmdbRatings | { _notFound: true } | null>(omdbKeys),
  ]);

  const negativeKeys = new Set<string>();
  const staleKeys = new Set<string>();

  const byMdblist = new Map<string, MdblistRatings>();
  for (const [key, { value, isStale }] of mdblistEntries) {
    // Rows that aren't objects (e.g. a stored literal null) count as misses.
    if (value === null || typeof value !== "object") continue;
    if (isStale) staleKeys.add(key);
    if ("_notFound" in value) negativeKeys.add(key);
    else byMdblist.set(key, value);
  }

  const byOmdb = new Map<string, OmdbRatings>();
  for (const [key, { value, isStale }] of omdbEntries) {
    if (value === null || typeof value !== "object") continue;
    if (isStale) staleKeys.add(key);
    if ("_notFound" in value) negativeKeys.add(key);
    else byOmdb.set(key, value);
  }

  return { byMdblist, byOmdb, negativeKeys, staleKeys };
}

// An MDBList batch row is cached as a real value even when every ratings field is
// null (the item is in MDBList's index but carries no scores). Such a row must not
// shadow a populated OMDB row, so treat it as "no data" when deciding which source wins.
//
// mdblistScore gets a NUMERIC test rather than a truthiness one: MDBList's
// "no score" value is -1 (see aggregateScore in mdblist.ts), and older cached
// rows can still hold "-1". That string is truthy, so a plain truthiness check
// would treat a scoreless row as having a rating.
export function hasAnyMdblistRating(d: MdblistRatings): boolean {
  const score = d.mdblistScore != null ? Number(d.mdblistScore) : NaN;
  return Boolean(
    d.imdbRating || d.rottenTomatoes || d.rtAudienceScore || d.metacritic ||
    d.traktRating || d.letterboxdRating || (Number.isFinite(score) && score > 0) ||
    d.malRating || d.rogerEbertRating,
  );
}

// MDBList wins per FIELD, not per source, when both rows are warm. hasAnyMdblistRating
// passes on any one of nine fields, so a row carrying only mdblistScore/Trakt would
// otherwise be applied wholesale and blank the IMDb/RT/Metacritic badges whose values are
// sitting in the OMDB row read in the very same call.
function overlayOmdb(mdb: MdblistRatings, omdb: OmdbRatings): MdblistRatings {
  return {
    ...mdb,
    imdbId:         mdb.imdbId ?? omdb.imdbId,
    imdbRating:     mdb.imdbRating ?? omdb.imdbRating,
    imdbVotes:      mdb.imdbVotes ?? omdb.imdbVotes,
    rottenTomatoes: mdb.rottenTomatoes ?? omdb.rottenTomatoes,
    metacritic:     mdb.metacritic ?? omdb.metacritic,
  };
}

function mergeWarm(item: TmdbMedia, warm: WarmCache): TmdbMedia {
  const mdb  = warm.byMdblist.get(mdblistKey(item));
  const omdb = warm.byOmdb.get(omdbKey(item));
  if (mdb && (hasAnyMdblistRating(mdb) || !omdb)) return applyMdblist(item, omdb ? overlayOmdb(mdb, omdb) : mdb);
  if (omdb) return applyOmdb(item, omdb);
  if (mdb)  return applyMdblist(item, mdb);
  return item;
}
