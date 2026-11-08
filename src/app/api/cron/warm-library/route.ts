import { prewarmLibraryCache } from "@/lib/tmdb-prewarm";
import { prewarmSuggestionEdges } from "@/lib/recommendation-graph";
import { prewarmTitleTranslations } from "@/lib/tmdb-localize";
import { WARM_LIBRARY_LOCK_ID } from "@/lib/advisory-lock";
import { defineCronRoute } from "@/lib/cron-route";
import { tmdbAuth } from "@/lib/tmdb-auth";

// Scheduled version of the boot-time prewarm (instrumentation.ts) and the admin
// "Warm library cache" button. The cached TMDB data expires after 3-30 days, so
// without a recurring run a server that stays up a long time slowly ends up
// with a cold cache. prewarmLibraryCache only re-fetches rows with less than
// 25% of their lifetime left, so each run is a cheap top-up, not a full walk.
export const POST = defineCronRoute({
  target: "library",
  lockId: WARM_LIBRARY_LOCK_ID,
  cacheWarm: true,
  // Not configured: no run happened, so it is answered as a skip and kept out
  // of the run history, decided before the lock.
  skipReason: () => (tmdbAuth() ? null : "no TMDB credentials configured"),
  async run({ signal }) {
    const result = await prewarmLibraryCache({ signal });
    // Same walk, same cadence: while this cron is fetching each library
    // title's metadata it also builds that title's suggestion edges, so the
    // recommendation graph is warm long before the 12h recommendations run
    // asks for it (see prewarmSuggestionEdges). Deliberately NOT wrapped in
    // its own try/catch — a throw here belongs in the same failure bucket as
    // a details-walk throw, and the run recording already covers it.
    const edges = await prewarmSuggestionEdges({ signal });
    // Titles, overviews and posters in the languages people on this server
    // read (guardrail 40a) — library, requests and watchlists, so list pages
    // and the iCal feed are localized without a first-view fetch. A no-op
    // unless someone reads a non-English language.
    const translations = await prewarmTitleTranslations({ signal });
    return {
      body: { ...result, edges, translations },
      problems: result.failed + edges.failed + translations.failed,
      error: `${result.failed} of ${result.total} library items, ${edges.failed} of ${edges.sources} suggestion sources and ${translations.failed} title translations failed to warm`,
    };
  },
});
