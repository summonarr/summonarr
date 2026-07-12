import "server-only";
import { after } from "next/server";
import { getCacheStaleMany } from "@/lib/tmdb-cache";
import type { TmdbMedia } from "@/lib/tmdb-types";
import type { OmdbRatings } from "@/lib/omdb";
import { getOmdbRatingsForTmdb } from "@/lib/omdb";
import type { MdblistRatings, MdblistResult } from "@/lib/mdblist";
import { getMdblistRatingsForTmdb, fetchMdblistBatch, isMdblistQuotaLocked } from "@/lib/mdblist";
import { mapLimit } from "@/lib/concurrency";

// Cap concurrent OMDB fallback chains. Each chain does a TMDB external_ids lookup
// + an OMDB fetch + cache reads/writes; an unbounded Promise.all over up to
// MAX_BATCH (200) misses would saturate the Prisma pool and burst OMDB (free tier
// is 1k/day). 6 keeps it gentle while still parallelizing.
const OMDB_FALLBACK_CONCURRENCY = 6;

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
// leave the title with no ratings at all.
export async function fetchUnifiedRatings(
  tmdbId: number,
  mediaType: "movie" | "tv",
  releaseDate?: string | null,
): Promise<UnifiedRatingsResult> {
  const mdb = await getMdblistRatingsForTmdb(tmdbId, mediaType, releaseDate).catch(
    (): MdblistResult => ({ found: false, keyConfigured: true, transient: true }),
  );
  // Require an actual score before letting MDBList win — a `found` row with every
  // field null must not shadow OMDB, which may carry the rating. Fall through to
  // OMDB when MDBList has no usable data.
  if (mdb.found && hasAnyMdblistRating(mdb.data)) {
    return { found: true, keyConfigured: true, data: mdb.data };
  }

  const omdb = await getOmdbRatingsForTmdb(tmdbId, mediaType, releaseDate).catch(
    () => ({ found: false, keyConfigured: true, transient: true } as const),
  );
  if (omdb.found) {
    return {
      found: true,
      keyConfigured: true,
      data: {
        imdbId: omdb.data.imdbId,
        imdbRating: omdb.data.imdbRating,
        imdbVotes: omdb.data.imdbVotes,
        rottenTomatoes: omdb.data.rottenTomatoes,
        rtAudienceScore: null,
        metacritic: omdb.data.metacritic,
        traktRating: null,
        letterboxdRating: null,
        mdblistScore: null,
        malRating: null,
        rogerEbertRating: null,
        releasedDigital: null,
        trailerUrl: null,
      },
    };
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

// Batch ratings merge with serve-stale semantics: a warm-cache entry — fresh OR
// expired — is always served from the table (mergeWarm); expired entries are
// revalidated after the response in BOTH modes, never in the request path. Only
// items with no cached row at all are misses (blocking mode fetches those inline;
// non-blocking mode defers them to after()). Matches the single-item getters'
// stale-while-revalidate behaviour.
export async function attachRatingsUnified(
  items: TmdbMedia[],
  opts: { blocking?: boolean } = {},
): Promise<TmdbMedia[]> {
  if (items.length === 0) return items;
  const blocking = opts.blocking ?? false;

  const warm = await readCachedRatings(items);

  // Stale routing (both modes): an item whose MDBList entry is stale revalidates via
  // the MDBList batch — the primary source — even when its OMDB entry is stale too.
  // The OMDB path is only for items whose warm data came from OMDB, i.e. with no
  // MDBList *value* at all (a fresh MDBList _notFound sentinel doesn't block it —
  // such an item's ratings are the OMDB row's).
  const staleMdblist = items.filter((item) => warm.staleKeys.has(mdblistKey(item)));
  const staleOmdb = items.filter((item) =>
    warm.staleKeys.has(omdbKey(item))
    && !warm.staleKeys.has(mdblistKey(item))
    && !warm.byMdblist.has(mdblistKey(item)));

  if (!blocking) {
    const uncached = items.filter((item) =>
      !warm.byMdblist.has(mdblistKey(item)) && !warm.byOmdb.has(omdbKey(item))
      && !warm.negativeKeys.has(mdblistKey(item)) && !warm.negativeKeys.has(omdbKey(item)));
    if (uncached.length > 0 || staleMdblist.length > 0 || staleOmdb.length > 0) {
      // Non-blocking path: fire background fetches after the response is sent so the user isn't
      // held waiting; the next page load will hit the warm cache. Stale-served entries
      // revalidate here too — never before the response.
      after(async () => {
        if (!isMdblistQuotaLocked()) {
          // Stale MDBList revalidations ride the same batch POSTs as the genuine
          // misses — one request per 200 ids instead of N singles.
          const toBatch = [...uncached, ...staleMdblist];
          const movieBatch = toBatch.filter((m) => m.mediaType === "movie");
          const tvBatch    = toBatch.filter((m) => m.mediaType === "tv");
          const [movieRatings, tvRatings] = await Promise.all([
            movieBatch.length > 0 ? fetchMdblistBatch(movieBatch, "movie") : Promise.resolve(new Map<number, MdblistRatings>()),
            tvBatch.length    > 0 ? fetchMdblistBatch(tvBatch,    "tv")    : Promise.resolve(new Map<number, MdblistRatings>()),
          ]);
          const found = new Set([...movieRatings.keys(), ...tvRatings.keys()]);

          // Only genuinely-uncached items feed the OMDB fallback probe. A stale item
          // absent from a full batch response just had its _notFound sentinel refreshed
          // by fetchMdblistBatch — chasing it through OMDB would burn quota for nothing.
          const stillMissing = uncached.filter((m) => !found.has(m.id));
          if (stillMissing.length > 0) {
            // Fall back to OMDB whenever MDBList can't serve the item (no key, genuine miss,
            // or mid-batch quota trip), not only when the MDBList key is absent.
            const probe = await getMdblistRatingsForTmdb(stillMissing[0].id, stillMissing[0].mediaType, stillMissing[0].releaseDate).catch(() => null);
            if (!probe || !probe.found) {
              await mapLimit(stillMissing, OMDB_FALLBACK_CONCURRENCY, (item) =>
                getOmdbRatingsForTmdb(item.id, item.mediaType, item.releaseDate).catch(() => {}));
            }
          }
        } else if (uncached.length > 0) {
          // Quota-locked: genuine misses have nothing to show, so OMDB is worth the spend.
          // Stale MDBList entries are NOT rerouted to OMDB — their data is stale-but-present,
          // and burning OMDB quota to refresh it is a bad trade; they revalidate once the
          // MDBList lock lifts.
          await mapLimit(uncached, OMDB_FALLBACK_CONCURRENCY, (item) =>
            getOmdbRatingsForTmdb(item.id, item.mediaType, item.releaseDate).catch(() => {}));
        }
        if (staleOmdb.length > 0) {
          // Items whose warm data came from an expired OMDB row: the single-item getter
          // serves the stale row and runs its own deduplicated background revalidation.
          await mapLimit(staleOmdb, OMDB_FALLBACK_CONCURRENCY, (item) =>
            getOmdbRatingsForTmdb(item.id, item.mediaType, item.releaseDate).catch(() => {}));
        }
      });
    }
    return items.map((item) => mergeWarm(item, warm));
  }

  const misses: TmdbMedia[] = [];
  // Keyed by `${mediaType}:${id}`, NOT bare tmdbId — a movie and a TV show can
  // share a TMDB id (independent id spaces), so a bare-id map would cross-
  // contaminate their ratings within a single batch.
  const fetched = new Map<string, { source: "mdblist"; data: MdblistRatings } | { source: "omdb"; data: OmdbRatings }>();
  for (const item of items) {
    // A _notFound sentinel (negativeKeys — fresh or stale) is an authoritative "no ratings" —
    // re-fetching it every call would burn MDBList/OMDB quota on titles known to be absent.
    // Stale value rows likewise serve from the warm maps rather than re-entering the miss
    // fan-out; they revalidate post-response below. Mirrors the non-blocking path's exclusion.
    if (
      !warm.byMdblist.has(mdblistKey(item)) && !warm.byOmdb.has(omdbKey(item)) &&
      !warm.negativeKeys.has(mdblistKey(item)) && !warm.negativeKeys.has(omdbKey(item))
    ) misses.push(item);
  }

  if (misses.length > 0) {
    if (!isMdblistQuotaLocked()) {
      // Batch by media type — MDBList's bulk endpoint is type-specific
      const movieMisses = misses.filter((m) => m.mediaType === "movie");
      const tvMisses    = misses.filter((m) => m.mediaType === "tv");

      const [movieRatings, tvRatings] = await Promise.all([
        movieMisses.length > 0 ? fetchMdblistBatch(movieMisses, "movie") : Promise.resolve(new Map<number, MdblistRatings>()),
        tvMisses.length    > 0 ? fetchMdblistBatch(tvMisses,    "tv")    : Promise.resolve(new Map<number, MdblistRatings>()),
      ]);

      // Only count an MDBList batch row as a hit when it carries a rating. Rows for
      // indexed-but-unscored titles (every score null) would otherwise be excluded
      // from mdbMisses below and skip the OMDB fallback, leaving a title OMDB *could*
      // rate showing none. (mergeWarm gates the warm-cache path the same way.)
      for (const [id, data] of movieRatings) if (hasAnyMdblistRating(data)) fetched.set(`movie:${id}`, { source: "mdblist", data });
      for (const [id, data] of tvRatings)    if (hasAnyMdblistRating(data)) fetched.set(`tv:${id}`,    { source: "mdblist", data });

      const mdbMisses = misses.filter((m) => !fetched.has(fetchedKey(m)));
      if (mdbMisses.length > 0) {
        // Probe a single item to see whether MDBList can serve these. Fall back to OMDB
        // whenever MDBList can't supply the item — no key, a genuine miss, or a mid-batch
        // quota trip — not only when the key is absent. A single source being unavailable
        // must not leave the title with no ratings.
        const probe = await getMdblistRatingsForTmdb(mdbMisses[0].id, mdbMisses[0].mediaType, mdbMisses[0].releaseDate).catch(() => null);
        const useFallback = !probe || !probe.found;
        if (useFallback) {
          await mapLimit(mdbMisses, OMDB_FALLBACK_CONCURRENCY, async (item) => {
            const omdb = await getOmdbRatingsForTmdb(item.id, item.mediaType, item.releaseDate).catch(() => null);
            if (omdb && omdb.found) fetched.set(fetchedKey(item), { source: "omdb", data: omdb.data });
          });
        }
      }
    } else {
      await mapLimit(misses, OMDB_FALLBACK_CONCURRENCY, async (item) => {
        const omdb = await getOmdbRatingsForTmdb(item.id, item.mediaType, item.releaseDate).catch(() => null);
        if (omdb && omdb.found) fetched.set(fetchedKey(item), { source: "omdb", data: omdb.data });
      });
    }
  }

  // Stale revalidation never blocks the response — only genuine misses are fetched
  // inline above; entries served stale refresh after the response, same as the
  // non-blocking path.
  if (staleMdblist.length > 0 || staleOmdb.length > 0) {
    after(async () => {
      if (staleMdblist.length > 0 && !isMdblistQuotaLocked()) {
        // Same quota-efficient shape as the non-blocking path: one batch POST per media
        // type. An item absent from a full response gets its _notFound sentinel refreshed
        // by fetchMdblistBatch — no OMDB chase for stale entries. When quota-locked these
        // items are NOT rerouted to OMDB: their data is stale-but-present, and burning
        // OMDB quota to refresh it is a bad trade; they revalidate once the lock lifts.
        const movieStale = staleMdblist.filter((m) => m.mediaType === "movie");
        const tvStale    = staleMdblist.filter((m) => m.mediaType === "tv");
        await Promise.all([
          movieStale.length > 0 ? fetchMdblistBatch(movieStale, "movie") : Promise.resolve(new Map<number, MdblistRatings>()),
          tvStale.length    > 0 ? fetchMdblistBatch(tvStale,    "tv")    : Promise.resolve(new Map<number, MdblistRatings>()),
        ]);
      }
      if (staleOmdb.length > 0) {
        // Items whose warm data came from an expired OMDB row: the single-item getter
        // serves the stale row and runs its own deduplicated background revalidation.
        await mapLimit(staleOmdb, OMDB_FALLBACK_CONCURRENCY, (item) =>
          getOmdbRatingsForTmdb(item.id, item.mediaType, item.releaseDate).catch(() => {}));
      }
    });
  }

  return items.map((item) => {
    const fresh = fetched.get(fetchedKey(item));
    if (fresh) return fresh.source === "mdblist" ? applyMdblist(item, fresh.data) : applyOmdb(item, fresh.data);
    return mergeWarm(item, warm);
  });
}

function mdblistKey(item: TmdbMedia): string { return `mdblist:tmdb:${item.mediaType}:${item.id}`; }
function omdbKey(item: TmdbMedia): string    { return `omdb:tmdb:${item.mediaType}:${item.id}`; }
function fetchedKey(item: TmdbMedia): string { return `${item.mediaType}:${item.id}`; }

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
    // Valid-JSON non-object rows (e.g. a literal null) are misses, same as the
    // old JSON.parse try/catch here treated them.
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
export function hasAnyMdblistRating(d: MdblistRatings): boolean {
  return Boolean(
    d.imdbRating || d.rottenTomatoes || d.rtAudienceScore || d.metacritic ||
    d.traktRating || d.letterboxdRating || d.mdblistScore || d.malRating || d.rogerEbertRating,
  );
}

function mergeWarm(item: TmdbMedia, warm: WarmCache): TmdbMedia {
  const mdb  = warm.byMdblist.get(mdblistKey(item));
  const omdb = warm.byOmdb.get(omdbKey(item));
  if (mdb && (hasAnyMdblistRating(mdb) || !omdb)) return applyMdblist(item, mdb);
  if (omdb) return applyOmdb(item, omdb);
  if (mdb)  return applyMdblist(item, mdb);
  return item;
}
