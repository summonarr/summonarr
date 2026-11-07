import { NextRequest, NextResponse } from "next/server";
import { logAudit } from "@/lib/audit";
import { withAdvisoryLock, WARM_LIST_CACHE_LOCK_ID } from "@/lib/advisory-lock";
import { cronSkippedResponse, getCronActor, withCronRunRecording } from "@/lib/cron-auth";
import {
  getTrending, getPopularMovies, getPopularTV,
  getUpcomingMovies, getUpcomingTV, getOnTheAirTV,
  getTopRatedMovies, getTopRatedTV,
  getPopularMoviesPage, getPopularTVPage,
  getMovieGenres, getTVGenres, getWatchProviders,
} from "@/lib/tmdb";
import { getTraktPopularMovies, getTraktPopularTV } from "@/lib/trakt";
import { getMdblistTopRated } from "@/lib/mdblist";

// A cron's MDBList calls stop at the reserve kept for pages (guardrail 31b).
const BACKGROUND_MDBLIST = { background: true } as const;

// Every list this job warms, once. `name` is the key its item count is reported
// under in the response and the audit row, and what a failure is logged as.
// There is no try/catch on purpose: a failed fetch must reject, so the
// Promise.allSettled below counts it as an error and the run is recorded as
// not ok.
const WARM_TASKS: ReadonlyArray<{ name: string; fn: () => Promise<readonly unknown[]> }> = [
  { name: "trending", fn: getTrending },
  { name: "popularMovies", fn: getPopularMovies },
  { name: "popularTV", fn: getPopularTV },
  { name: "upcomingMovies", fn: getUpcomingMovies },
  { name: "upcomingTV", fn: getUpcomingTV },
  { name: "onAirTV", fn: getOnTheAirTV },
  { name: "topRatedMovies", fn: getTopRatedMovies },
  { name: "topRatedTV", fn: getTopRatedTV },
  { name: "popularMoviesPage1", fn: () => getPopularMoviesPage(1).then((r) => r.items) },
  { name: "popularTVPage1", fn: () => getPopularTVPage(1).then((r) => r.items) },
  { name: "movieGenres", fn: getMovieGenres },
  { name: "tvGenres", fn: getTVGenres },
  { name: "watchProviders", fn: () => getWatchProviders("movie") },
  { name: "traktPopularMovies", fn: getTraktPopularMovies },
  { name: "traktPopularTV", fn: getTraktPopularTV },
  { name: "mdblistMovies", fn: () => getMdblistTopRated("movie", undefined, BACKGROUND_MDBLIST) },
  { name: "mdblistTV", fn: () => getMdblistTopRated("tv", undefined, BACKGROUND_MDBLIST) },
];

export async function POST(request: NextRequest) {
  const authCtx = await getCronActor(request);
  if (!authCtx) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  // withCronRunRecording records every run (a throw, a lock connection that
  // fails, a lock timeout and a degraded 200 included) and leaves a busy-lock
  // skip unrecorded.
  return withCronRunRecording("list-cache", () => withAdvisoryLock(
    WARM_LIST_CACHE_LOCK_ID,
    async () => {
      const startTime = Date.now();

      const results = await Promise.allSettled(WARM_TASKS.map((task) => task.fn().then((items) => items.length)));

      const counts: Record<string, number> = {};
      let errorCount = 0;
      results.forEach((r, i) => {
        const { name } = WARM_TASKS[i];
        if (r.status === "fulfilled") {
          counts[name] = r.value;
          return;
        }
        counts[name] = 0;
        errorCount++;
        console.error(
          `[warm-list-cache] ${name} failed:`,
          r.reason instanceof Error ? r.reason.message : String(r.reason),
        );
      });

      const durationMs = Date.now() - startTime;
      const totalItems = Object.values(counts).reduce((s, n) => s + n, 0);

      if (authCtx.trigger !== "cron") {
        await logAudit({
          userId: authCtx.userId,
          userName: authCtx.userName,
          action: "CACHE_WARM",
          target: "list-cache",
          details: { ...counts, totalItems, errors: errorCount, durationMs, trigger: authCtx.trigger },
        });
      }

      // The admin "Run now" badge (cron-job-table.tsx) turns red on an `error`
      // field. The status stays 200 on purpose: the container retries any
      // non-2xx every CRON_RETRY_INTERVAL (300s) instead of waiting for the
      // job's normal interval. `error` plus the X-Cron-Degraded header mean
      // "finished, but with failures" — the header is what withCronRunRecording
      // reads to record the run as not ok, so `ok` here matches the ledger.
      return NextResponse.json({
          ok: errorCount === 0,
          ...counts,
          totalItems,
          errors: errorCount,
          ...(errorCount > 0 ? { error: `${errorCount} of ${WARM_TASKS.length} list fetches failed` } : {}),
          durationMs,
          timestamp: new Date().toISOString(),
        }, errorCount > 0 ? { headers: { "X-Cron-Degraded": String(errorCount) } } : undefined);
    },
    () => cronSkippedResponse(),
  ));
}
