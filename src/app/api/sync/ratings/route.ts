import { NextRequest, NextResponse } from "next/server";
import { isCronAuthorized, withCronRunRecording } from "@/lib/cron-auth";
import { getTrending, getPopularMovies, getPopularTV, getTopRatedMovies, getTopRatedTV } from "@/lib/tmdb";
import { fetchUnifiedRatings, type UnifiedRatingsResult } from "@/lib/omdb-availability";
import { fetchMdblistBatch, isMdblistQuotaLocked } from "@/lib/mdblist";
import { withAdvisoryLock } from "@/lib/advisory-lock";
import { prisma } from "@/lib/prisma";
import type { TmdbMedia } from "@/lib/tmdb-types";

const BATCH = 5;

async function warmBatch(items: TmdbMedia[]): Promise<{ warmed: number; skipped: number; quotaExhausted: boolean }> {
  let warmed = 0;
  let skipped = 0;
  // Once MDBList reports its daily quota is exhausted, every further request just
  // burns a 429 and re-confirms the same exhaustion. Stop the remaining batches
  // rather than hammering the upstream for the rest of the run.
  let quotaExhausted = false;

  for (let i = 0; i < items.length && !quotaExhausted; i += BATCH) {
    const batch = items.slice(i, i + BATCH);
    // The underlying MDBList/OMDB getters warm both ratings caches as a side effect;
    // the unified helper applies the same MDBList-first / OMDB-on-any-miss policy as
    // the detail pages and the batch route, so this cron warms whichever cache those
    // paths will read.
    const results = await Promise.all(
      batch.map((item) =>
        fetchUnifiedRatings(item.id, item.mediaType, item.releaseDate)
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
    if (isMdblistQuotaLocked()) quotaExhausted = true;
  }

  return { warmed, skipped, quotaExhausted };
}

export async function POST(request: NextRequest) {
  if (!(await isCronAuthorized(request))) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
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
    2008,
    async () => {
      const startTime = Date.now();

      const [trending, popularMovies, popularTV, topMovies, topTV] = await Promise.all([
        getTrending().catch(() => [] as TmdbMedia[]),
        getPopularMovies().catch(() => [] as TmdbMedia[]),
        getPopularTV().catch(() => [] as TmdbMedia[]),
        getTopRatedMovies().catch(() => [] as TmdbMedia[]),
        getTopRatedTV().catch(() => [] as TmdbMedia[]),
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

      // MDBList pre-warm: one 200-id batch POST per ~200 stale/missing items
      // instead of a cold single GET per item through the per-item pass below —
      // the batch-first policy attachRatingsUnified and the library prewarm
      // already use; this cron was the one bulk caller still looping singles
      // (a cold or expiry-wave run burned ~1,500 GETs where ~8 POSTs do).
      // Freshness mirrors the prewarms' 25%-remaining-TTL threshold, and a
      // just-batched row is FRESH — so the per-item pass can neither re-fetch
      // it nor fire its per-key stale-SWR background GETs (those escape the
      // BATCH pacing entirely and were the worst quota offender). OMDB stays
      // per-item on purpose: it has no batch endpoint, and the unified pass
      // only consults it for genuine MDBList misses.
      if (mdblistKey?.value) {
        const mdblistKeyFor = (m: TmdbMedia) => `mdblist:tmdb:${m.mediaType}:${m.id}`;
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
          const stale = all
            .filter((m) => m.mediaType === type && !freshMdblist.has(mdblistKeyFor(m)))
            .map((m) => ({ id: m.id, releaseDate: m.releaseDate }));
          // Sequential per type on purpose (pacing); the helper pages at 200,
          // checks the quota lockout itself, and never throws past a page.
          await fetchMdblistBatch(stale, type).catch(() => {});
        }
      }

      const { warmed, skipped, quotaExhausted } = await warmBatch(all);
      const durationMs = Date.now() - startTime;

      return NextResponse.json({ total: all.length, warmed, skipped, quotaExhausted, durationMs });
    },
    () => NextResponse.json({ skipped: true, reason: "already running" }),
  ));
}
