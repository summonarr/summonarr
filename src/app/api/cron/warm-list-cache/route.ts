import { WARM_LIST_CACHE_LOCK_ID } from "@/lib/advisory-lock";
import { defineCronRoute } from "@/lib/cron-route";
import {
  getTrendingChecked, getPopularMoviesChecked, getPopularTVChecked,
  getUpcomingMoviesChecked, getUpcomingTVChecked, getOnTheAirTVChecked,
  getTopRatedWithStatus,
  getPopularMoviesPage, getPopularTVPage,
  getMovieGenres, getTVGenres, getWatchProviders,
  type PagedList,
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
//
// The paged TMDB lists absorb a failed page and answer with what they got (an
// empty list on an outage, and during the 60 s backoff after one), so they are
// read with their `complete` flag and an incomplete list rejects here. Partial
// counts too: only a complete list is written to the cache, so a list with
// items but a failed page was served, not warmed.
const warmed = (load: () => Promise<PagedList>) => async (): Promise<readonly unknown[]> => {
  const { items, complete } = await load();
  if (!complete) throw new Error(`TMDB did not answer every page (${items.length} item(s), not cached)`);
  return items;
};

const WARM_TASKS: ReadonlyArray<{ name: string; fn: () => Promise<readonly unknown[]> }> = [
  { name: "trending", fn: warmed(getTrendingChecked) },
  { name: "popularMovies", fn: warmed(getPopularMoviesChecked) },
  { name: "popularTV", fn: warmed(getPopularTVChecked) },
  { name: "upcomingMovies", fn: warmed(getUpcomingMoviesChecked) },
  { name: "upcomingTV", fn: warmed(getUpcomingTVChecked) },
  { name: "onAirTV", fn: warmed(getOnTheAirTVChecked) },
  { name: "topRatedMovies", fn: warmed(() => getTopRatedWithStatus("movie")) },
  { name: "topRatedTV", fn: warmed(() => getTopRatedWithStatus("tv")) },
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
