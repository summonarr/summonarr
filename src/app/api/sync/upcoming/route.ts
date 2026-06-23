import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { getUpcomingMovies, getUpcomingTV } from "@/lib/tmdb";
import { isCronAuthorized, BATCH_TX_TIMEOUT, batchCreateMany, withCronRunRecording } from "@/lib/cron-auth";
import { logAudit } from "@/lib/audit";
import { withAdvisoryLock } from "@/lib/advisory-lock";

export async function POST(request: NextRequest) {
  if (!(await isCronAuthorized(request))) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  return withCronRunRecording("upcoming-cache", () => withAdvisoryLock(
    2007,
    async () => {
      const startTime = Date.now();

      const [movies, tv] = await Promise.allSettled([getUpcomingMovies(), getUpcomingTV()]);
      const movieItems = movies.status === "fulfilled" ? movies.value : [];
      const tvItems = tv.status === "fulfilled" ? tv.value : [];

      if (movies.status === "rejected") console.error("[sync/upcoming] Movie fetch failed:", movies.reason);
      if (tv.status === "rejected") console.error("[sync/upcoming] TV fetch failed:", tv.reason);

      const movieRows = movieItems.map((m) => ({
        tmdbId: m.id,
        mediaType: "MOVIE" as const,
        title: m.title,
        overview: m.overview,
        posterPath: m.posterPath,
        backdropPath: m.backdropPath,
        releaseDate: m.releaseDate,
        releaseYear: m.releaseYear ?? "",
        voteAverage: m.voteAverage,
        cachedAt: new Date(),
      }));
      const tvRows = tvItems.map((t) => ({
        tmdbId: t.id,
        mediaType: "TV" as const,
        title: t.title,
        overview: t.overview,
        posterPath: t.posterPath,
        backdropPath: t.backdropPath,
        releaseDate: t.releaseDate,
        releaseYear: t.releaseYear ?? "",
        voteAverage: t.voteAverage,
        cachedAt: new Date(),
      }));
      const rows = [...movieRows, ...tvRows];

      // Per-source replace: only delete+repopulate a media type whose fetch SUCCEEDED.
      // A blanket deleteMany() would wipe the sibling type when only one source failed
      // (e.g. movies OK, TV rejected → TV cache erased). Concurrency is already
      // serialized by the outer withAdvisoryLock(2007); the tx still gives atomicity.
      // NOTE: a fulfilled-but-empty fetch (0 rows) intentionally clears that media
      // type's cache — for the upcoming list an empty TMDB result is a valid "nothing
      // upcoming" state, and the cache re-warms on the next run. This deliberately
      // differs from the library-sync "skip delete on 0" anti-wipe guard (guardrails
      // 13/28), where 0 rows usually means a degraded fetch, not an empty library.
      await prisma.$transaction(async (tx) => {
        if (movies.status === "fulfilled") {
          await tx.upcomingCacheItem.deleteMany({ where: { mediaType: "MOVIE" } });
          if (movieRows.length > 0) await batchCreateMany(tx.upcomingCacheItem, movieRows);
        }
        if (tv.status === "fulfilled") {
          await tx.upcomingCacheItem.deleteMany({ where: { mediaType: "TV" } });
          if (tvRows.length > 0) await batchCreateMany(tx.upcomingCacheItem, tvRows);
        }
      }, { timeout: BATCH_TX_TIMEOUT });

      const durationMs = Date.now() - startTime;
      const errors = [movies, tv].filter((r) => r.status === "rejected").length;

      await logAudit({
        userId: "system",
        userName: "cron",
        action: "LIBRARY_SYNC",
        target: "upcoming-cache",
        details: { movies: movieItems.length, tv: tvItems.length, total: rows.length, errors, durationMs },
      }).catch(() => {});

      // Both TMDB fetches failed and nothing was cached → 502 so the cron
      // dashboard doesn't show green on a total failure. A partial failure (one
      // source) that still wrote rows stays 200.
      const failed = errors > 0 && rows.length === 0;
      return NextResponse.json({
        movies: movieItems.length,
        tv: tvItems.length,
        total: rows.length,
        errors,
        durationMs,
      }, failed ? { status: 502 } : {});
    },
    () => NextResponse.json({ skipped: true, reason: "already running" }),
  ));
}
