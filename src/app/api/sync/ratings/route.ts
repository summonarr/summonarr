import { NextRequest, NextResponse } from "next/server";
import { isCronAuthorized, withCronRunRecording } from "@/lib/cron-auth";
import { getTrending, getPopularMovies, getPopularTV, getTopRatedMovies, getTopRatedTV } from "@/lib/tmdb";
import { getMdblistRatingsForTmdb } from "@/lib/mdblist";
import { getOmdbRatingsForTmdb } from "@/lib/omdb";
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
    const results = await Promise.all(
      batch.map(async (item) => {
        const mdb = await getMdblistRatingsForTmdb(item.id, item.mediaType, item.releaseDate).catch(() => ({ found: false as const, keyConfigured: true }));
        if (mdb.found) return { found: true, quotaExhausted: false };
        if ("quotaExhausted" in mdb && mdb.quotaExhausted) return { found: false, quotaExhausted: true };
        if (!mdb.keyConfigured) {
          const omdb = await getOmdbRatingsForTmdb(item.id, item.mediaType, item.releaseDate).catch(() => ({ found: false as const, keyConfigured: true }));
          return { found: omdb.found, quotaExhausted: false };
        }
        return { found: false, quotaExhausted: false };
      })
    );
    for (const r of results) {
      if (r.found) warmed++;
      else skipped++;
      if (r.quotaExhausted) quotaExhausted = true;
    }
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

      const { warmed, skipped, quotaExhausted } = await warmBatch(all);
      const durationMs = Date.now() - startTime;

      return NextResponse.json({ total: all.length, warmed, skipped, quotaExhausted, durationMs });
    },
    () => NextResponse.json({ skipped: true, reason: "already running" }),
  ));
}
