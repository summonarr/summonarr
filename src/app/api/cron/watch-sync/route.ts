import { NextRequest, NextResponse } from "next/server";
import { cronSkippedResponse, getCronActor, withCronRunRecording } from "@/lib/cron-auth";
import { withAdvisoryLock, WATCH_SYNC_LOCK_ID } from "@/lib/advisory-lock";
import { isFeatureEnabled } from "@/lib/features";
import { WATCH_SYNC_FEATURE_KEY, runWatchSync, watchSyncProblems } from "@/lib/watch-sync-data";

// Watch sync, Plex ⇄ Jellyfin (src/lib/watch-sync-data.ts): for every enabled
// admin-made pair, marks in each account what the other server counted as
// watched, per the pair's direction. Add-only; never unmarks. A no-op while the
// feature is off. Scheduled by docker-entrypoint.sh every WATCH_SYNC_INTERVAL.
export async function POST(request: NextRequest) {
  const authCtx = await getCronActor(request);
  if (!authCtx) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  // No run, no lock, no ledger row (X-Cron-Skipped) while the feature is off.
  if (!(await isFeatureEnabled(WATCH_SYNC_FEATURE_KEY))) return cronSkippedResponse("feature disabled");

  return withCronRunRecording("watch-sync", () => withAdvisoryLock(
    WATCH_SYNC_LOCK_ID,
    async (signal: AbortSignal) => {
      const startTime = Date.now();
      // Observes the lock's AbortSignal between servers, pairs and items, and
      // returns early on abort (guardrail 41).
      const result = await runWatchSync({ signal });
      const durationMs = Date.now() - startTime;
      // The entrypoint runs this job quietly (no line for a 200), so a run that
      // stopped on its budget would otherwise leave no trace in the log. One
      // line per such run — an event, not a repeated condition (7b).
      if (result.aborted) {
        console.warn(`[watch-sync] run stopped at its time limit after ${Math.round(durationMs / 1000)}s; finished work is saved and the rest continues on the next run`);
      }
      // 200 on a partial failure (the entrypoint fast-retries any non-2xx);
      // X-Cron-Degraded marks the run failed in the ledger.
      const problems = watchSyncProblems(result);
      const ok = problems === 0;
      return NextResponse.json(
        {
          ok,
          ...result,
          ...(ok ? {} : { error: `${problems} watch sync pair(s) had problems` }),
          durationMs,
          trigger: authCtx.trigger,
          timestamp: new Date().toISOString(),
        },
        ok ? undefined : { headers: { "X-Cron-Degraded": String(problems) } },
      );
    },
    // A lock-busy skip is not a run (guardrail 7b).
    () => cronSkippedResponse(),
  ));
}
