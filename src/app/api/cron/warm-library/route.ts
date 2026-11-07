import { NextRequest, NextResponse } from "next/server";
import { prewarmLibraryCache } from "@/lib/tmdb-prewarm";
import { prewarmSuggestionEdges } from "@/lib/recommendation-graph";
import { prewarmTitleTranslations } from "@/lib/tmdb-localize";
import { logAudit } from "@/lib/audit";
import { withAdvisoryLock, WARM_LIBRARY_LOCK_ID } from "@/lib/advisory-lock";
import { cronSkippedResponse, getCronActor, withCronRunRecording } from "@/lib/cron-auth";
import { tmdbAuth } from "@/lib/tmdb-auth";

// Scheduled version of the boot-time prewarm (instrumentation.ts) and the admin
// "Warm library cache" button. The cached TMDB data expires after 3-30 days, so
// without a recurring run a server that stays up a long time slowly ends up
// with a cold cache. prewarmLibraryCache only re-fetches rows with less than
// 25% of their lifetime left, so each run is a cheap top-up, not a full walk.

export async function POST(request: NextRequest) {
  const authCtx = await getCronActor(request);
  if (!authCtx) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  // Not configured: no run happened, so it is answered as a skip
  // (X-Cron-Skipped) and kept out of the run history, decided before the lock.
  if (!tmdbAuth()) {
    return cronSkippedResponse("no TMDB credentials configured");
  }

  // withCronRunRecording saves every run to the cron history (Admin ->
  // Settings -> System) — a throw, a lock connection that fails or a lock
  // timeout as a failed run, and a run with failures (X-Cron-Degraded below)
  // as an error instead of a green tick — and leaves a busy-lock skip
  // unrecorded. It is kept in the Setting table, not AuditLog, so scheduled
  // runs don't flood the audit log.
  return withCronRunRecording("library", () => withAdvisoryLock(
    WARM_LIBRARY_LOCK_ID,
    async (signal) => {
      const startTime = Date.now();
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

      const durationMs = Date.now() - startTime;
      const failed = result.failed + edges.failed + translations.failed;

      if (authCtx.trigger !== "cron") {
        await logAudit({
          userId: authCtx.userId,
          userName: authCtx.userName,
          action: "CACHE_WARM",
          target: "library",
          details: { ...result, edges, translations, durationMs, trigger: authCtx.trigger },
        });
      }

      // The body's `ok` matches what gets recorded. The admin "Run now"
      // badge (cron-job-table.tsx) turns red on `ok: false` or an `error` field.
      // The status stays 200 on purpose: the container retries any non-2xx
      // every CRON_RETRY_INTERVAL (300s) instead of waiting for the job's normal
      // interval. `error` plus the X-Cron-Degraded header mean "finished, but
      // with failures" (the same signal withCronRunRecording reads).
      return NextResponse.json({
        ok: failed === 0,
        ...result,
        edges,
        translations,
        ...(failed > 0
          ? { error: `${result.failed} of ${result.total} library items, ${edges.failed} of ${edges.sources} suggestion sources and ${translations.failed} title translations failed to warm` }
          : {}),
        timestamp: new Date().toISOString(),
      }, failed > 0 ? { headers: { "X-Cron-Degraded": String(failed) } } : undefined);
    },
    () => cronSkippedResponse(),
  ));
}
