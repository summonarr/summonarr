import { NextRequest, NextResponse } from "next/server";
import { prewarmLibraryCache } from "@/lib/tmdb-prewarm";
import { prewarmSuggestionEdges } from "@/lib/recommendation-graph";
import { logAudit } from "@/lib/audit";
import { withAdvisoryLock, WARM_LIBRARY_LOCK_ID } from "@/lib/advisory-lock";
import { getCronActor, recordCronRun } from "@/lib/cron-auth";
import { tmdbAuth } from "@/lib/tmdb-auth";

// Recurring counterpart to the boot-time prewarm (instrumentation.ts) and the
// admin "Warm library cache" button. The prewarm's outputs carry 3-30 day
// age-aware TTLs and the sync purge reaps them (after the :details grace), so
// a long-uptime server used to decay to a cold library cache between
// restarts — nothing re-ran the warm. The 25%-remaining triage inside
// prewarmLibraryCache makes this recurring run a cheap incremental top-up
// (fresh rows skip; only the aging tail re-fetches), not a daily full walk.

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
    async () => {
      const startTime = Date.now();
      let result;
      let edges;
      try {
        result = await prewarmLibraryCache();
        // Same walk, same cadence: while this cron is fetching each library
        // title's metadata it also builds that title's suggestion edges, so the
        // recommendation graph is warm long before the 12h recommendations run
        // asks for it (see prewarmSuggestionEdges). Deliberately NOT wrapped in
        // its own try/catch — a throw here belongs in the same failure bucket as
        // a details-walk throw, and the ledger write below already covers it.
        edges = await prewarmSuggestionEdges();
      } catch (err) {
        // A throw used to skip the ledger write altogether, so the row kept the
        // last SUCCESSFUL run — the dashboard stayed green and only the ageing
        // "Last Run" timestamp hinted anything was wrong.
        await recordCronRun("library", Date.now() - startTime, false);
        throw err;
      }

      const durationMs = Date.now() - startTime;

      // `lastRunAt` observability — see warm-activity for rationale.
            // `ok` is derived, not assumed. Two ways a warm used to write green:
      // a throw skipped this line entirely and left the PREVIOUS success
      // standing, and a run that completed while reporting failures wrote an
      // affirmative success anyway. The cron table reads `ok === false` to show
      // Error, and the container reschedules a failing job every
      // CRON_RETRY_INTERVAL (300s) — so a job broken for a week showed a green
      // tick while being retried 12x an hour.
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

      // `ok` in the BODY is the same derived verdict the ledger just recorded —
      // never a literal true. The admin "Run now" badge judges `res.ok && !error`
      // (cron-job-table.tsx), so a run in which every task failed painted green
      // until a reload re-read the ledger's ok:false. Status stays 200 on purpose:
      // the container reschedules any non-2xx every CRON_RETRY_INTERVAL (300s)
      // instead of the job's own interval. `error` + X-Cron-Degraded are the
      // documented degraded-but-completed signal (see withCronRunRecording).
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
