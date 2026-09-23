import { NextRequest, NextResponse } from "next/server";
import { logAudit } from "@/lib/audit";
import { withAdvisoryLock } from "@/lib/advisory-lock";
import { getCronActor, recordCronRun } from "@/lib/cron-auth";
import {
  getTrending, getPopularMovies, getPopularTV,
  getUpcomingMovies, getUpcomingTV, getOnTheAirTV,
  getTopRatedMovies, getTopRatedTV,
  getPopularMoviesPage, getPopularTVPage,
  getMovieGenres, getTVGenres, getWatchProviders,
} from "@/lib/tmdb";
import { getTraktPopularMovies, getTraktPopularTV } from "@/lib/trakt";
import { getMdblistTopRated } from "@/lib/mdblist";

// Runs one list fetch and returns how many items came back. There is no
// try/catch on purpose: a failed fetch must reject, so the Promise.allSettled
// below counts it as an error and the run is recorded as not ok.
async function warm<T>(fn: () => Promise<T[]>): Promise<number> {
  const result = await fn();
  return result.length;
}

export async function POST(request: NextRequest) {
  const authCtx = await getCronActor(request);
  if (!authCtx) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  return withAdvisoryLock(
    2006,
    async () => {
      const startTime = Date.now();

    const [
      trending, popMovies, popTV, upMovies, upTV, onAirTV,
      topMovies, topTV,
      popMoviesP1, popTVP1,
      movieGenres, tvGenres, providers,
      traktPopMovies, traktPopTV,
      mdbMovies, mdbTV,
    ] = await Promise.allSettled([

      warm(getTrending),
      warm(getPopularMovies),
      warm(getPopularTV),
      warm(getUpcomingMovies),
      warm(getUpcomingTV),
      warm(getOnTheAirTV),
      warm(getTopRatedMovies),
      warm(getTopRatedTV),

      warm(() => getPopularMoviesPage(1).then((r) => r.items)),
      warm(() => getPopularTVPage(1).then((r) => r.items)),

      warm(getMovieGenres),
      warm(getTVGenres),
      warm(() => getWatchProviders("movie")),

      warm(getTraktPopularMovies),
      warm(getTraktPopularTV),

      warm(() => getMdblistTopRated("movie")),
      warm(() => getMdblistTopRated("tv")),
    ]);

    const extract = (r: PromiseSettledResult<number>) => r.status === "fulfilled" ? r.value : 0;

    const counts = {
      trending: extract(trending),
      popularMovies: extract(popMovies),
      popularTV: extract(popTV),
      upcomingMovies: extract(upMovies),
      upcomingTV: extract(upTV),
      onAirTV: extract(onAirTV),
      topRatedMovies: extract(topMovies),
      topRatedTV: extract(topTV),
      popularMoviesPage1: extract(popMoviesP1),
      popularTVPage1: extract(popTVP1),
      movieGenres: extract(movieGenres),
      tvGenres: extract(tvGenres),
      watchProviders: extract(providers),
      traktPopularMovies: extract(traktPopMovies),
      traktPopularTV: extract(traktPopTV),
      mdblistMovies: extract(mdbMovies),
      mdblistTV: extract(mdbTV),
    };

    const allResults = [
      trending, popMovies, popTV, upMovies, upTV, onAirTV,
      topMovies, topTV, popMoviesP1, popTVP1,
      movieGenres, tvGenres, providers,
      traktPopMovies, traktPopTV,
      mdbMovies, mdbTV,
    ];
    const errorCount = allResults.filter((r) => r.status === "rejected").length;
    if (errorCount > 0) {
      console.error(`[warm-list-cache] ${errorCount} failures out of ${allResults.length} tasks`);
    }

    const durationMs = Date.now() - startTime;
    const totalItems = Object.values(counts).reduce((s, n) => s + n, 0);

    // Save this run to the cron history; any failed fetch marks it not ok.
    await recordCronRun("list-cache", durationMs, errorCount === 0);

    if (authCtx.trigger !== "cron") {
      await logAudit({
        userId: authCtx.userId,
        userName: authCtx.userName,
        action: "CACHE_WARM",
        target: "list-cache",
        details: { ...counts, totalItems, errors: errorCount, durationMs, trigger: authCtx.trigger },
      });
    }

    // The body's `ok` matches what was just recorded. The admin "Run now"
    // badge (cron-job-table.tsx) turns red on `ok: false` or an `error` field.
    // The status stays 200 on purpose: the container retries any non-2xx
    // every CRON_RETRY_INTERVAL (300s) instead of waiting for the job's normal
    // interval. `error` plus the X-Cron-Degraded header mean "finished, but
    // with failures" (the same signal withCronRunRecording reads).
    return NextResponse.json({
        ok: errorCount === 0,
        ...counts,
        totalItems,
        errors: errorCount,
        ...(errorCount > 0 ? { error: `${errorCount} of ${allResults.length} list fetches failed` } : {}),
        durationMs,
        timestamp: new Date().toISOString(),
      }, errorCount > 0 ? { headers: { "X-Cron-Degraded": String(errorCount) } } : undefined);
    },
    () => NextResponse.json({ skipped: true, reason: "already running" }),
  );
}
