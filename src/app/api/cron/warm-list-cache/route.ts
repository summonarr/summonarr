import { WARM_LIST_CACHE_LOCK_ID } from "@/lib/advisory-lock";
import { defineCronRoute } from "@/lib/cron-route";
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

export const POST = defineCronRoute({
  target: "list-cache",
  lockId: WARM_LIST_CACHE_LOCK_ID,
  cacheWarm: true,
  async run({ elapsedMs }) {
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

    const totalItems = Object.values(counts).reduce((s, n) => s + n, 0);
    return {
      body: { ...counts, totalItems, errors: errorCount, durationMs: elapsedMs() },
      problems: errorCount,
      error: `${errorCount} of ${WARM_TASKS.length} list fetches failed`,
    };
  },
});
