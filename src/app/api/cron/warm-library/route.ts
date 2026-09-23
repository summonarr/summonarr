import { NextRequest, NextResponse } from "next/server";
import { prewarmLibraryCache } from "@/lib/tmdb-prewarm";
import { prewarmSuggestionEdges } from "@/lib/recommendation-graph";
import { logAudit } from "@/lib/audit";
import { withAdvisoryLock, WARM_LIBRARY_LOCK_ID } from "@/lib/advisory-lock";
import { getCronActor, recordCronRun } from "@/lib/cron-auth";
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

  if (!tmdbAuth()) {
    return NextResponse.json({ skipped: true, reason: "no TMDB credentials configured" });
  }

  return withAdvisoryLock(
    WARM_LIBRARY_LOCK_ID,
    async (signal) => {
      const startTime = Date.now();
      let result;
      let edges;
      try {
        result = await prewarmLibraryCache({ signal });
        // Same walk, same cadence: while this cron is fetching each library
        // title's metadata it also builds that title's suggestion edges, so the
        // recommendation graph is warm long before the 12h recommendations run
        // asks for it (see prewarmSuggestionEdges). Deliberately NOT wrapped in
        // its own try/catch — a throw here belongs in the same failure bucket as
        // a details-walk throw, and the ledger write below already covers it.
        edges = await prewarmSuggestionEdges({ signal });
      } catch (err) {
        // Record the failed run before re-throwing. Otherwise the cron history
        // would still show the last successful run and look healthy.
        await recordCronRun("library", Date.now() - startTime, false);
        throw err;
      }

      const durationMs = Date.now() - startTime;

      // Save this run to the cron history (Admin -> Settings -> System). It is
      // kept in the Setting table, not AuditLog, so scheduled runs don't flood
      // the audit log. `ok` comes from the real failure count, so a run that
      // finished with failures shows as an error instead of a green tick.
      const failed = result.failed + edges.failed;
      await recordCronRun("library", durationMs, failed === 0);

      if (authCtx.trigger !== "cron") {
        await logAudit({
          userId: authCtx.userId,
          userName: authCtx.userName,
          action: "CACHE_WARM",
          target: "library",
          details: { ...result, edges, durationMs, trigger: authCtx.trigger },
        });
      }

      // The body's `ok` matches what was just recorded. The admin "Run now"
      // badge (cron-job-table.tsx) turns red on `ok: false` or an `error` field.
      // The status stays 200 on purpose: the container retries any non-2xx
      // every CRON_RETRY_INTERVAL (300s) instead of waiting for the job's normal
      // interval. `error` plus the X-Cron-Degraded header mean "finished, but
      // with failures" (the same signal withCronRunRecording reads).
      return NextResponse.json({
        ok: failed === 0,
        ...result,
        edges,
        ...(failed > 0
          ? { error: `${result.failed} of ${result.total} library items and ${edges.failed} of ${edges.sources} suggestion sources failed to warm` }
          : {}),
        timestamp: new Date().toISOString(),
      }, failed > 0 ? { headers: { "X-Cron-Degraded": String(failed) } } : undefined);
    },
    () => NextResponse.json({ skipped: true, reason: "already running" }),
  );
}
