import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { getUpcomingMovies, getUpcomingTV } from "@/lib/tmdb";
import { isCronAuthorized, BATCH_TX_TIMEOUT } from "@/lib/cron-auth";
import { recordCronRun, resolveCronTrigger } from "@/lib/cron-run";
import { logAudit } from "@/lib/audit";
import { withAdvisoryLock } from "@/lib/advisory-lock";

export async function POST(request: NextRequest) {
  if (!(await isCronAuthorized(request))) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  return withAdvisoryLock(
    2007,
    async () => {
      const startTime = Date.now();

      const [movies, tv] = await Promise.allSettled([getUpcomingMovies(), getUpcomingTV()]);
      const movieItems = movies.status === "fulfilled" ? movies.value : [];
      const tvItems = tv.status === "fulfilled" ? tv.value : [];

      if (movies.status === "rejected") console.error("[sync/upcoming] Movie fetch failed:", movies.reason);
      if (tv.status === "rejected") console.error("[sync/upcoming] TV fetch failed:", tv.reason);

      const rows = [
        ...movieItems.map((m) => ({
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
        })),
        ...tvItems.map((t) => ({
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
        })),
      ];

      if (rows.length > 0) {
        // Advisory lock 1001,3 prevents two concurrent upcoming syncs from producing a partial write
        await prisma.$transaction(async (tx) => {
          await tx.$executeRaw`SELECT pg_advisory_xact_lock(1001, 3)`;
          await tx.upcomingCacheItem.deleteMany();
          await tx.upcomingCacheItem.createMany({ data: rows });
        }, { timeout: BATCH_TX_TIMEOUT });
      }

      const durationMs = Date.now() - startTime;
      const errors = [movies, tv].filter((r) => r.status === "rejected").length;
      const details = { movies: movieItems.length, tv: tvItems.length, total: rows.length, errors, durationMs };
      const trigger = await resolveCronTrigger();

      await logAudit({
        userId: "system",
        userName: "cron",
        action: "LIBRARY_SYNC",
        target: "upcoming-cache",
        details,
      }).catch(() => {});

      await recordCronRun({
        target: "upcoming-cache",
        status: errors > 0 ? "error" : "ok",
        durationMs,
        trigger,
        details,
      });

      return NextResponse.json({
        movies: movieItems.length,
        tv: tvItems.length,
        total: rows.length,
        errors,
        durationMs,
      });
    },
    () => NextResponse.json({ skipped: true, reason: "already running" }),
  );
}
