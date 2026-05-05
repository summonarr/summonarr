import { NextRequest, NextResponse } from "next/server";
import { isCronAuthorized, recordCronRun } from "@/lib/cron-auth";
import { getTrending, getPopularMovies, getPopularTV, getTopRatedMovies, getTopRatedTV } from "@/lib/tmdb";
import { getMdblistRatingsForTmdb } from "@/lib/mdblist";
import { getOmdbRatingsForTmdb } from "@/lib/omdb";
import { withAdvisoryLock } from "@/lib/advisory-lock";
import { prisma } from "@/lib/prisma";
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

  const [mdblistKey, omdbKey] = await Promise.all([
    prisma.setting.findUnique({ where: { key: "mdblistApiKey" } }),
    prisma.setting.findUnique({ where: { key: "omdbApiKey" } }),
  ]);
  if (!mdblistKey?.value && !omdbKey?.value) {
    return NextResponse.json({ skipped: true, reason: "no ratings API key configured" });
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

      // `lastRunAt` observability — see /lib/cron-auth.ts:recordCronRun.
      await recordCronRun("ratings-sync", durationMs);

      return NextResponse.json({ total: all.length, warmed, skipped, durationMs });
    },
    () => NextResponse.json({ skipped: true, reason: "already running" }),
  );
}
