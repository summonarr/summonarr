import "server-only";
import { prisma } from "./prisma";
import { setCache, getCacheStale, libraryDetailsTtl, tmdbDetailsKey } from "./tmdb-cache";
import { upsertTmdbMediaCore, upsertTmdbMediaCoreMany, type CoreMediaInput } from "./tmdb-core-sync";
import { check, v } from "./validate";
import { safeFetchTrusted, SafeFetchError } from "./safe-fetch";
import { iterateLibrary, LIBRARY_PAGE_SIZE } from "./library-iterator";
import type { LibraryItem } from "./library-iterator";
import { tmdbAuth } from "./tmdb-auth";
import type { TmdbMedia } from "./tmdb-types";
import { buildDetailsMedia, type TmdbDetailsBody } from "./tmdb";

const CONCURRENCY = 5;
const BATCH_DELAY_MS = 250;

const MAX_PREWARM_ITEMS = 200_000;
const TMDB_FETCH_TIMEOUT_MS = 15_000;

// Negative cache for TMDB 404s — a dead library match (bad id, delisted title)
// otherwise re-fetches on every prewarm run, forever. 14 days: long enough to
// stop the churn, short enough that a fix-match or a TMDB reinstatement heals
// within two weeks. The purge reaps expired tombstones immediately (the
// :details serve-stale grace deliberately excludes the :missing suffix).
const MISSING_TOMBSTONE_TTL = 14 * 24 * 60 * 60;

const TMDB_BASE = "https://api.themoviedb.org/3";

// The unified-ratings fields assignUnifiedRatings (tmdb.ts) stores into the
// :details blob from MDBList/OMDB. They are NOT TMDB data, so this file's
// rewrite cannot re-derive them and must carry them forward from the previous
// row — dropping them blanked the admin dashboard's ratings after every
// boot-time warm and forced a per-title ratings refetch + full blob rewrite on
// the next detail view (the same drop-on-rewrite class as the cert/trailerKey
// fixes below). `imdbId` is deliberately NOT in this list (the fresh TMDB
// response is authoritative for it), and `trailerUrl` is handled separately
// under assignUnifiedRatings' never-displace-a-trailerKey guard. A carried
// value persists until the row's own TTL expiry re-runs the full
// details+ratings fetch — mildly stale ratings beat blank ones.
const UNIFIED_RATINGS_FIELDS = [
  "imdbRating", "imdbVotes", "rottenTomatoes", "metacritic", "rtAudienceScore",
  "traktRating", "letterboxdRating", "mdblistScore", "malRating",
  "rogerEbertRating", "releasedDigital",
] as const;

type PrewarmStats = { fetched: number; missing: number; backfilled: number; skipped: number; failed: number };

// What one title's fetch came to: details stored, a 404 tombstoned (the title
// isn't on TMDB — a definitive answer, but not a refresh), or no answer
// (SafeFetchError, non-404 non-2xx such as 429/401/5xx, unparseable body).
// Those already warned here and must reach the caller's `failed` counter, or a
// TMDB outage reports as a successful warm. Never throws for those misses, so
// the page loop keeps going.
type FetchOutcome = "fetched" | "missing" | "failed";

function prewarmUrl(tmdbId: number, mediaType: "MOVIE" | "TV"): string {
  const type = mediaType === "MOVIE" ? "movie" : "tv";
  const url = new URL(`${TMDB_BASE}/${type}/${tmdbId}`);
  // release_dates/content_ratings included so the prewarm rewrite of the shared
  // :details blob (and the TmdbMediaCore upsert) carries the US certification —
  // omitting them made every prewarm refresh silently drop a previously-stored
  // cert badge from both the grid and the detail page. `videos` rides along for
  // the same reason: without it the rewrite dropped the trailerKey that
  // getMovieDetails/getTVDetails had stored, and the trailer button vanished
  // for library titles (same failure class as the cert drop).
  url.searchParams.set(
    "append_to_response",
    mediaType === "TV"
      ? "seasons,keywords,watch/providers,external_ids,content_ratings,videos"
      : "keywords,watch/providers,external_ids,release_dates,videos",
  );
  return url.toString();
}

// The parts of a details body buildDetailsMedia dereferences without a guard:
// an id, and every nested list it filters or maps must be a list when present.
const results = v.optional(v.object({ results: v.optional(v.array(v.unknown())) }));
const DETAILS_ENVELOPE = v.object({
  id: v.int(),
  seasons: v.optional(v.array(v.unknown())),
  genres: v.optional(v.array(v.unknown())),
  production_companies: v.optional(v.array(v.unknown())),
  production_countries: v.optional(v.array(v.unknown())),
  release_dates: results,
  content_ratings: results,
  videos: results,
});

// TMDB's details body, "missing" for a 404, or null when there was no usable
// answer (already warned).
async function fetchDetailsBody(
  tmdbId: number,
  mediaType: "MOVIE" | "TV",
  headers: Record<string, string>,
): Promise<TmdbDetailsBody | "missing" | null> {
  const label = `${mediaType === "MOVIE" ? "movie" : "tv"}:${tmdbId}`;
  let res: Response;
  try {
    // Use safeFetchTrusted instead of Next.js fetch so the request bypasses the Next cache and
    // never gets deduped or revalidated against a stale store entry.
    res = await safeFetchTrusted(prewarmUrl(tmdbId, mediaType), {
      allowedHosts: ["api.themoviedb.org"],
      headers,
      timeoutMs: TMDB_FETCH_TIMEOUT_MS,
    });
  } catch (err) {
    if (err instanceof SafeFetchError) {
      console.warn(`[prewarm] TMDB ${label} → ${err.reason} (${err.message})`);
      return null;
    }
    throw err;
  }
  if (!res.ok) {
    // Nothing reads a refused answer's body; release the connection.
    await res.body?.cancel().catch(() => {});
    if (res.status === 404) return "missing";
    console.warn(`[prewarm] TMDB ${label} → HTTP ${res.status}`);
    return null;
  }

  // Read as text first so we can log a diagnostic snippet if JSON parsing fails — `await res.json()`
  // throws a SyntaxError whose message renders non-printable leading bytes invisibly ("Unexpected
  // token '', \"\"..."), making the failure mode impossible to diagnose from the log alone.
  const bodyText = await res.text();
  try {
    const body: unknown = JSON.parse(bodyText);
    const parsed = check(DETAILS_ENVELOPE, body);
    if (!parsed.ok) {
      console.warn(`[prewarm] TMDB ${label} answered an unusable body: ${parsed.error}`);
      return null;
    }
    // The checked copy keeps only the envelope's keys; the builder reads the
    // full body, so hand it the original.
    return body as TmdbDetailsBody;
  } catch (err) {
    const head = bodyText.slice(0, 80);
    const hex = Buffer.from(bodyText.slice(0, 16), "utf-8").toString("hex");
    console.warn(
      `[prewarm] TMDB ${label} JSON.parse failed (len=${bodyText.length}, ` +
      `ce=${res.headers.get("content-encoding") ?? "none"}, ` +
      `ct=${res.headers.get("content-type") ?? "none"}, head=${JSON.stringify(head)}, hex=${hex}):`,
      err instanceof Error ? err.message : String(err),
    );
    return null;
  }
}

// The unified-ratings fields (and the never-displace-a-trailerKey trailerUrl)
// carried forward from the previous row, which this rewrite cannot re-derive.
// See UNIFIED_RATINGS_FIELDS.
function carriedForward(prior: Partial<TmdbMedia> | null, media: TmdbMedia): Record<string, unknown> {
  const carried: Record<string, unknown> = {};
  if (!prior) return carried;
  for (const f of UNIFIED_RATINGS_FIELDS) {
    // undefined = never ratings-fetched (keep it undefined so the details
    // lazy-upgrade can still fire); null = authoritative "no rating" — both
    // distinctions must survive the rewrite, so only defined values carry.
    if (prior[f] !== undefined) carried[f] = prior[f];
  }
  // assignUnifiedRatings' guard, preserved across the rewrite: trailerUrl only
  // ever fills in when TMDB itself has no trailer.
  if (!media.trailerKey && prior.trailerUrl !== undefined) carried.trailerUrl = prior.trailerUrl;
  return carried;
}

async function fetchAndStore(tmdbId: number, mediaType: "MOVIE" | "TV"): Promise<FetchOutcome> {
  const auth = tmdbAuth();
  if (!auth) return "failed";
  const type = mediaType === "MOVIE" ? "movie" : "tv";
  const body = await fetchDetailsBody(tmdbId, mediaType, auth.headers);
  if (body === null) return "failed";
  if (body === "missing") {
    // Tombstone the dead id so the triage skips it on later runs. Silent —
    // the title simply isn't on TMDB; noise here would flood every run.
    await setCache(`${tmdbDetailsKey(type, tmdbId)}:missing`, { _notFound: true }, MISSING_TOMBSTONE_TTL);
    return "missing";
  }

  // The same builder getMovieDetails/getTVDetails write this key with, so the
  // stored shape never depends on which writer filled it.
  const media = buildDetailsMedia(body, type);
  const key = tmdbDetailsKey(type, tmdbId);
  // Carry-forward read (stale/expired-in-place rows still serve here; a row the
  // purge already deleted has nothing to carry).
  const prior = (await getCacheStale<Partial<TmdbMedia>>(key)).value;
  const carried = carriedForward(prior, media);
  // TMDB's external_ids answer first; `prior` is the fallback because a ratings
  // hit can supply an id TMDB never had.
  media.imdbId = media.imdbId ?? prior?.imdbId ?? null;

  await setCache(key, { ...carried, ...media }, libraryDetailsTtl(media.releaseDate));
  await upsertTmdbMediaCore(media);
  return "fetched";
}

type PageTriage = { fresh: LibraryItem[]; dead: LibraryItem[]; stale: LibraryItem[] };

const detailsKeyOf = (i: LibraryItem) => tmdbDetailsKey(i.mediaType, i.tmdbId);
const missingKeyOf = (i: LibraryItem) => `${detailsKeyOf(i)}:missing`;

// Sorts a page by its cache rows. "Fresh" means the row still has more than
// 25% of its original TTL remaining — below that threshold it's cheaper to
// re-fetch now than risk a cache miss in production during peak traffic. A
// LIVE `:missing` tombstone (a TMDB 404 on a prior run) marks a known-dead id,
// skipped without a fetch — but a fresh row wins over a tombstone: a later
// fix-match that repopulated the blob serves. The raw rows include expired
// ones, so expiry is checked here.
export function triagePrewarmPage(
  page: readonly LibraryItem[],
  rows: readonly { key: string; cachedAt: Date; expiresAt: Date }[],
  now: number = Date.now(),
): PageTriage {
  const freshKeys = new Set<string>();
  const tombstoned = new Set<string>();
  for (const r of rows) {
    if (r.key.endsWith(":details:missing")) {
      if (r.expiresAt.getTime() > now) tombstoned.add(r.key);
      continue;
    }
    const originalTtlMs = r.expiresAt.getTime() - r.cachedAt.getTime();
    if (r.expiresAt.getTime() - now > originalTtlMs * 0.25) freshKeys.add(r.key);
  }
  const out: PageTriage = { fresh: [], dead: [], stale: [] };
  for (const i of page) {
    if (freshKeys.has(detailsKeyOf(i))) out.fresh.push(i);
    else if (tombstoned.has(missingKeyOf(i))) out.dead.push(i);
    else out.stale.push(i);
  }
  return out;
}

// The fields a TmdbMediaCore row is rebuilt from, read off a cached :details
// blob. A blob that lacks them is not used (and counted failed) rather than
// written half-empty.
const CachedCoreFields = v.object({
  id: v.int(),
  title: v.string(),
  posterPath: v.optional(v.nullable(v.string())),
  releaseYear: v.optional(v.nullable(v.string())),
  releaseDate: v.optional(v.nullable(v.string())),
  voteAverage: v.optional(v.nullable(v.number())),
  certification: v.optional(v.nullable(v.string())),
});

// The core row for one cached blob, or null when the blob is unusable. The
// media type comes from the LIBRARY ITEM (the cache key), never the blob: a
// blob without one used to be filed as TV.
export function coreInputFromCachedDetails(data: string, item: LibraryItem): CoreMediaInput | null {
  let raw: unknown;
  try {
    raw = JSON.parse(data);
  } catch {
    return null;
  }
  const parsed = check(CachedCoreFields, raw);
  if (!parsed.ok || parsed.value.id !== item.tmdbId) return null;
  const c = parsed.value;
  return {
    id: c.id,
    mediaType: item.mediaType === "MOVIE" ? "movie" : "tv",
    title: c.title,
    posterPath: c.posterPath ?? null,
    releaseYear: c.releaseYear ?? null,
    releaseDate: c.releaseDate ?? null,
    voteAverage: c.voteAverage ?? 0,
    certification: c.certification ?? undefined,
  };
}

// Items with a fresh TmdbCache entry but no TmdbMediaCore row missed a previous
// upsert; backfill them from the cached JSON rather than making a live TMDB
// request — in one transaction, falling back to one row at a time so a single
// bad row costs only itself. Returns what it added to the stats.
async function backfillCoreRows(fresh: readonly LibraryItem[]): Promise<Pick<PrewarmStats, "backfilled" | "skipped" | "failed">> {
  const out = { backfilled: 0, skipped: 0, failed: 0 };
  if (fresh.length === 0) return out;
  const coreRows = await prisma.tmdbMediaCore.findMany({
    where: { OR: fresh.map((x) => ({ tmdbId: x.tmdbId, mediaType: x.mediaType })) },
    select: { tmdbId: true, mediaType: true },
  });
  const coreSet = new Set(coreRows.map((r) => `${r.tmdbId}:${r.mediaType}`));
  const toBackfill = fresh.filter((i) => !coreSet.has(`${i.tmdbId}:${i.mediaType}`));
  out.skipped = fresh.length - toBackfill.length;
  if (toBackfill.length === 0) return out;

  const byKey = new Map(toBackfill.map((i) => [detailsKeyOf(i), i]));
  const cachedRows = await prisma.tmdbCache.findMany({
    where: { key: { in: [...byKey.keys()] } },
    select: { key: true, data: true },
  });
  const inputs: CoreMediaInput[] = [];
  for (const row of cachedRows) {
    const item = byKey.get(row.key);
    const input = item ? coreInputFromCachedDetails(row.data, item) : null;
    if (input) inputs.push(input);
    else {
      out.failed++;
      console.warn(`[prewarm] TmdbMediaCore backfill skipped an unusable cached blob: ${row.key}`);
    }
  }
  try {
    await upsertTmdbMediaCoreMany(inputs);
    out.backfilled += inputs.length;
  } catch {
    for (const input of inputs) {
      try {
        await upsertTmdbMediaCore(input);
        out.backfilled++;
      } catch (err) {
        out.failed++;
        console.warn("[prewarm] TmdbMediaCore backfill from cache failed:", err);
      }
    }
  }
  return out;
}

async function processPrewarmPage(page: LibraryItem[], stats: PrewarmStats, signal?: AbortSignal): Promise<void> {
  const cacheRows = await prisma.tmdbCache.findMany({
    where: { key: { in: [...page.map(detailsKeyOf), ...page.map(missingKeyOf)] } },
    select: { key: true, cachedAt: true, expiresAt: true },
  });
  const { fresh, dead, stale } = triagePrewarmPage(page, cacheRows);
  stats.skipped += dead.length;
  const backfill = await backfillCoreRows(fresh);
  stats.backfilled += backfill.backfilled;
  stats.skipped += backfill.skipped;
  stats.failed += backfill.failed;

  for (let i = 0; i < stale.length; i += CONCURRENCY) {
    // Guardrail 41: stop at the batch boundary once the advisory lock has
    // timed out — a page holds up to LIBRARY_PAGE_SIZE stale items, i.e.
    // minutes of lock-free TMDB fetching if the walk ignored the abort here.
    if (signal?.aborted) return;
    const batch = stale.slice(i, i + CONCURRENCY);
    const results = await Promise.allSettled(batch.map((item) => fetchAndStore(item.tmdbId, item.mediaType)));
    for (const r of results) {
      // A fulfilled "failed" already warned inside fetchAndStore — count it
      // without a second log line.
      if (r.status === "fulfilled") stats[r.value]++;
      else { stats.failed++; console.warn("[prewarm] item failed:", r.reason); }
    }
    if (i + CONCURRENCY < stale.length) {
      await new Promise((resolve) => setTimeout(resolve, BATCH_DELAY_MS));
    }
  }
}

// Every distinct library title, Plex first then Jellyfin, movies then TV, in
// pages of LIBRARY_PAGE_SIZE, stopping at MAX_PREWARM_ITEMS. The abort is
// checked per ITEM rather than per page: a page only fills every
// LIBRARY_PAGE_SIZE items, so a per-page check could keep fetching for
// hundreds of items past it (see the note in omdb-prewarm). An aborted walk
// yields no partial page: flushing it would issue up to LIBRARY_PAGE_SIZE - 1
// more fetches after the lock was released.
// `walk.total` counts every distinct title seen, a partial page dropped by an
// abort included.
async function* libraryPages(signal: AbortSignal | undefined, walk: { total: number }): AsyncGenerator<LibraryItem[]> {
  const seen = new Set<string>();
  let page: LibraryItem[] = [];
  for (const source of ["plex", "jellyfin"] as const) {
    for (const mediaType of ["MOVIE", "TV"] as const) {
      for await (const item of iterateLibrary(source, mediaType)) {
        if (signal?.aborted) {
          console.warn(`[prewarm] aborted after ${walk.total} items — the advisory lock timed out`);
          return;
        }
        const k = `${item.tmdbId}:${item.mediaType}`;
        if (seen.has(k)) continue;
        seen.add(k);
        walk.total = seen.size;
        page.push(item);
        if (page.length >= LIBRARY_PAGE_SIZE) {
          yield page;
          page = [];
        }
        if (seen.size >= MAX_PREWARM_ITEMS) {
          console.warn(`[prewarm] Reached MAX_PREWARM_ITEMS (${MAX_PREWARM_ITEMS}) — library scan truncated`);
          if (page.length > 0 && !signal?.aborted) yield page;
          return;
        }
      }
    }
  }
  if (page.length > 0 && !signal?.aborted) yield page;
}

// Walk the Plex + Jellyfin libraries (deduped), fetching each title's full TMDB
// detail page into the cache so browse/detail views hit warm rows; fresh entries
// are skipped and cache-only rows are backfilled into TmdbMediaCore without a live fetch.
// `missing` counts titles TMDB answered 404 for (tombstoned, not refreshed).
export async function prewarmLibraryCache(opts: { signal?: AbortSignal } = {}): Promise<{ total: number; fetched: number; missing: number; backfilled: number; skipped: number; failed: number }> {
  const stats: PrewarmStats = { fetched: 0, missing: 0, backfilled: 0, skipped: 0, failed: 0 };
  if (!tmdbAuth()) return { total: 0, ...stats };
  const walk = { total: 0 };
  for await (const page of libraryPages(opts.signal, walk)) {
    await processPrewarmPage(page, stats, opts.signal);
  }
  return { total: walk.total, ...stats };
}
