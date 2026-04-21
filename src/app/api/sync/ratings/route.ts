import { NextRequest, NextResponse } from "next/server";
import { isCronAuthorized } from "@/lib/cron-auth";
import { recordCronRun, resolveCronTrigger } from "@/lib/cron-run";
import { getTrending, getPopularMovies, getPopularTV, getTopRatedMovies, getTopRatedTV } from "@/lib/tmdb";
import { getMdblistRatingsForTmdb } from "@/lib/mdblist";
import { getOmdbRatingsForTmdb } from "@/lib/omdb";
import { withAdvisoryLock } from "@/lib/advisory-lock";
import type { TmdbMedia } from "@/lib/tmdb-types";

const BATCH = 5;

async function warmBatch(items: TmdbMedia[]): Promise<{ warmed: number; skipped: number }> {
  let warmed = 0;
  let skipped = 0;

  for (let i = 0; i < items.length; i += BATCH) {
    const batch = items.slice(i, i + BATCH);
    const results = await Promise.all(
      batch.map(async (item) => {
        const mdb = await getMdblistRatingsForTmdb(item.id, item.mediaType, item.releaseDate).catch(() => ({ found: false as const, keyConfigured: true }));
        if (mdb.found) return true;
        if (!mdb.keyConfigured) {
          const omdb = await getOmdbRatingsForTmdb(item.id, item.mediaType, item.releaseDate).catch(() => ({ found: false as const, keyConfigured: true }));
          return omdb.found;
        }
        return false;
      })
    );
    for (const found of results) {
      if (found) warmed++;
      else skipped++;
    }
  }

  return { warmed, skipped };
}

export async function POST(request: NextRequest) {
  if (!(await isCronAuthorized(request))) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  return withAdvisoryLock(
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

      const { warmed, skipped } = await warmBatch(all);
      const durationMs = Date.now() - startTime;
      const trigger = await resolveCronTrigger();

      await recordCronRun({
        target: "ratings-sync",
        status: "ok",
        durationMs,
        trigger,
        details: { total: all.length, warmed, skipped },
      });

      return NextResponse.json({ total: all.length, warmed, skipped, durationMs });
    },
    () => NextResponse.json({ skipped: true, reason: "already running" }),
  );
}
