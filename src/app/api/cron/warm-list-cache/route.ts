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

// No try/catch: a failed fetch must REJECT so the Promise.allSettled below counts
// it (errorCount) and recordCronRun reports ok=false. Swallowing the error to 0
// here made every run look green even when upstream fetches failed.
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

    // `lastRunAt` observability — see warm-activity for rationale.
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

    // `ok` in the BODY is the same derived verdict the ledger just recorded —
    // never a literal true. The admin "Run now" badge judges `res.ok && !error`
    // (cron-job-table.tsx), so a run in which every task failed painted green
    // until a reload re-read the ledger's ok:false. Status stays 200 on purpose:
    // the container reschedules any non-2xx every CRON_RETRY_INTERVAL (300s)
    // instead of the job's own interval. `error` + X-Cron-Degraded are the
    // documented degraded-but-completed signal (see withCronRunRecording).
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
