import { NextRequest, NextResponse } from "next/server";
import { cronSkippedResponse, isCronAuthorized, withCronRunRecording } from "@/lib/cron-auth";
import { getTrending, getPopularMovies, getPopularTV, getTopRatedMovies, getTopRatedTV } from "@/lib/tmdb";
import { fetchUnifiedRatings, hasAnyMdblistRating, type UnifiedRatingsResult } from "@/lib/omdb-availability";
import { fetchMdblistBatch, isMdblistQuotaLocked, mdblistCacheKey, revalidateMdblistForTmdb, type MdblistRatings } from "@/lib/mdblist";
import { omdbCacheKey, revalidateOmdbForTmdb, type OmdbRatings } from "@/lib/omdb";
import { getCacheStaleMany } from "@/lib/tmdb-cache";
import { withAdvisoryLock, RATINGS_SYNC_LOCK_ID } from "@/lib/advisory-lock";
import { prisma } from "@/lib/prisma";
import type { TmdbMedia } from "@/lib/tmdb-types";
import { translatorForRequest } from "@/lib/i18n/server-locale";
import { warnOnChange, forgetWarnOnChange } from "@/lib/log-dedup";

const BATCH = 5;

// A cron: MDBList stops it at the reserve the plan setting keeps for pages.
const BACKGROUND = { background: true } as const;

// The one key builder each ratings cache uses, so this cron reads the rows the
// pages and the batch route write.
const mdblistKeyFor = (m: TmdbMedia) => mdblistCacheKey(m.mediaType, m.id);
const omdbKeyFor = (m: TmdbMedia) => omdbCacheKey(m.mediaType, m.id);

type CachedRatingsRow = { value: MdblistRatings | OmdbRatings | { _notFound: true }; isStale: boolean };

// One item of the per-item pass. The unified helper applies the same MDBList-first /
// OMDB-on-any-miss policy as the detail pages and the batch route, so this cron warms
// whichever cache those paths will read — but its getters serve a STALE row at once
// and DETACH the refresh (guardrail 31a), so `Promise.all` over them bounds only the
// cache reads: every stale row's upstream call starts together, BATCH or not. On an
// OMDB-only instance a pool whose rows expire on one cadence is ~1.7k TMDB
// external_ids lookups at once — the 429 wall. So stale rows are refreshed FIRST,
// through the awaited twins, and only then does the policy helper read them warm.
async function warmItem(item: TmdbMedia, rows: Map<string, CachedRatingsRow>): Promise<UnifiedRatingsResult> {
  const mdbKey = mdblistKeyFor(item);
  const omdbKey = omdbKeyFor(item);
  const mdb = rows.get(mdbKey);
  const omdb = rows.get(omdbKey);
  const revalidated: string[] = [];
  if (mdb?.isStale) {
    await revalidateMdblistForTmdb(item.id, item.mediaType, item.releaseDate, BACKGROUND).catch(() => {});
    revalidated.push(mdbKey);
  }
  // The OMDB row is refreshed only when MDBList holds no USABLE value — the gate
  // attachRatingsUnified's stale-OMDB pass applies. Behind a scored MDBList row the
  // helper reads OMDB cache-only (an overlay, never a refresh), so refreshing it here
  // would be OMDB spend no read path ever makes.
  const mdbUsable = mdb !== undefined && !("_notFound" in mdb.value) && hasAnyMdblistRating(mdb.value as MdblistRatings);
  if (omdb?.isStale && !mdbUsable) {
    await revalidateOmdbForTmdb(item.id, item.mediaType, item.releaseDate).catch(() => {});
    revalidated.push(omdbKey);
  }
  if (revalidated.length > 0) {
    // A refresh that failed (or that another caller already owns) leaves the row
    // stale, and the getters below would answer it by detaching a RETRY — the very
    // fan-out this bounds. Count it skipped; the next run tries again.
    const after = await getCacheStaleMany<CachedRatingsRow["value"]>(revalidated);
    if (revalidated.some((k) => after.get(k)?.isStale)) return { found: false, keyConfigured: true, transient: true };
  }
  return fetchUnifiedRatings(item.id, item.mediaType, item.releaseDate, undefined, BACKGROUND);
}

async function warmBatch(
  items: TmdbMedia[],
  signal: AbortSignal,
): Promise<{ warmed: number; skipped: number; quotaExhausted: boolean }> {
  let warmed = 0;
  let skipped = 0;
  // Once MDBList reports its daily quota is exhausted, every further request just
  // burns a 429 and re-confirms the same exhaustion. Stop the remaining batches
  // rather than hammering the upstream for the rest of the run.
  let quotaExhausted = false;

  for (let i = 0; i < items.length && !quotaExhausted; i += BATCH) {
    // Guardrail 41: once withAdvisoryLock's timeout aborts, lock 2008 is released,
    // so continuing would run lock-free beside the next cron's fresh copy. Stop at
    // the batch boundary and return (never throw — the race has already settled).
    if (signal.aborted) break;
    const batch = items.slice(i, i + BATCH);
    // One findMany for the batch's rows, so warmItem's stale decision costs no
    // point reads; the awaited twins bound the upstream work to BATCH (31a).
    const rows = await getCacheStaleMany<CachedRatingsRow["value"]>(batch.flatMap((m) => [mdblistKeyFor(m), omdbKeyFor(m)]));
    const results = await Promise.all(
      batch.map((item) =>
        warmItem(item, rows)
          .catch((): UnifiedRatingsResult => ({ found: false, keyConfigured: true })),
      ),
    );
    for (const r of results) {
      if (r.found) warmed++;
      else skipped++;
      if (r.quotaExhausted) quotaExhausted = true;
    }
    // The helper's quotaExhausted flag only surfaces when the OMDB fallback ALSO
    // missed (an OMDB hit returns found:true), so also honor the module-level
    // MDBList lockout between batches — continuing would funnel every remaining
    // item into OMDB's much smaller daily quota.
    if (isMdblistQuotaLocked(BACKGROUND)) quotaExhausted = true;
  }

  return { warmed, skipped, quotaExhausted };
}

export async function POST(request: NextRequest) {
  const t = translatorForRequest(request);
  if (!(await isCronAuthorized(request))) {
    return NextResponse.json({ error: t("apiAdmin.common.forbidden") }, { status: 403 });
  }

  const [mdblistKey, omdbKey] = await Promise.all([
    prisma.setting.findUnique({ where: { key: "mdblistApiKey" } }),
    prisma.setting.findUnique({ where: { key: "omdbApiKey" } }),
  ]);
  if (!mdblistKey?.value && !omdbKey?.value) {
    // Record the skip so the cron dashboard's last-run timestamp still updates
    // when no ratings key is configured (the sync legitimately did nothing).
    return withCronRunRecording("ratings-sync", async () =>
      NextResponse.json({ skipped: true, reason: "no ratings API key configured" }),
    );
  }

  return withCronRunRecording("ratings-sync", () => withAdvisoryLock(
    RATINGS_SYNC_LOCK_ID,
    async (signal) => {
      const startTime = Date.now();

      // A list that throws still degrades to empty (the warm runs on what
      // answered), but it is recorded: a TMDB outage used to answer 200
      // {total: 0} with no log and a green run. The list helpers also absorb a
      // failed PAGE and return what answered, so an all-empty pool is read as
      // failed too — every one of these lists is non-empty on a healthy TMDB.
      const failedLists: string[] = [];
      const list = (name: string, get: () => Promise<TmdbMedia[]>) =>
        get().catch((err) => {
          failedLists.push(name);
          console.warn(`[sync/ratings] TMDB ${name} list failed:`, err instanceof Error ? err.message : err);
          return [] as TmdbMedia[];
        });
      const [trending, popularMovies, popularTV, topMovies, topTV] = await Promise.all([
        list("trending", getTrending),
        list("popular-movies", getPopularMovies),
        list("popular-tv", getPopularTV),
        list("top-movies", getTopRatedMovies),
        list("top-tv", getTopRatedTV),
      ]);

      const seen = new Set<string>();
      const all: TmdbMedia[] = [];
      for (const item of [...trending, ...popularMovies, ...popularTV, ...topMovies, ...topTV]) {
        const key = `${item.mediaType}:${item.id}`;
        if (!seen.has(key)) {
          seen.add(key);
          all.push(item);
        }
      }

      // MDBList pre-warm: ask MDBList for up to 200 titles per POST instead of one
      // GET per title in the per-item pass below. A cold run used to spend ~1,500
      // GETs where ~8 POSTs do the same job. A row counts as fresh while more than
      // 25% of its cache lifetime is left (the same rule the library prewarms use).
      // Rows fetched here are fresh, so the per-item pass neither re-fetches them
      // nor starts background "stale" refreshes for them (those ignored the BATCH
      // pacing and burned the most quota). OMDB has no batch endpoint, so it stays
      // per-item and is only asked about titles MDBList did not have.
      if (mdblistKey?.value) {
        // One findMany, not chunked: the pool is bounded (~1.7k) by the list
        // helpers' page constants, unlike the library-sized prewarm scans.
        const rows = await prisma.tmdbCache.findMany({
          where: { key: { in: all.map(mdblistKeyFor) } },
          select: { key: true, cachedAt: true, expiresAt: true },
        });
        const freshMdblist = new Set<string>();
        for (const r of rows) {
          const originalTtlMs = r.expiresAt.getTime() - r.cachedAt.getTime();
          if (r.expiresAt.getTime() - Date.now() > originalTtlMs * 0.25) freshMdblist.add(r.key);
        }
        for (const type of ["movie", "tv"] as const) {
          if (signal.aborted) break;
          const stale = all
            .filter((m) => m.mediaType === type && !freshMdblist.has(mdblistKeyFor(m)))
            .map((m) => ({ id: m.id, releaseDate: m.releaseDate }));
          // Sequential per type on purpose (pacing); the helper pages at 200,
          // checks the quota lockout itself, and never throws past a page.
          await fetchMdblistBatch(stale, type, BACKGROUND).catch(() => {});
        }
      }

      const { warmed, skipped, quotaExhausted } = await warmBatch(all, signal);
      const durationMs = Date.now() - startTime;

      // Still 200 (a warm with no deletes; a partial pool is still worth
      // warming), but degraded so withCronRunRecording records the run red.
      const degraded = failedLists.length > 0 ? failedLists.join(",") : all.length === 0 ? "tmdb-lists-empty" : null;
      if (degraded !== null) {
        // The same outage restates itself every run: log it once (guardrail 7b).
        warnOnChange("sync/ratings:tmdb-lists", degraded, `[sync/ratings] warmed a degraded TMDB pool (${degraded}); ${all.length} title(s)`);
      } else {
        forgetWarnOnChange("sync/ratings:tmdb-lists");
      }
      return NextResponse.json(
        { total: all.length, warmed, skipped, quotaExhausted, durationMs },
        degraded !== null ? { headers: { "X-Cron-Degraded": degraded } } : undefined,
      );
    },
    // A busy lock is not a run: X-Cron-Skipped keeps it out of the ledger.
    () => cronSkippedResponse(),
  ));
}
