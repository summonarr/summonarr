import { NextRequest, NextResponse } from "next/server";
import { warmRecommendationsCache } from "@/lib/recommendations";
import { logAudit } from "@/lib/audit";
import { withAdvisoryLock, WARM_RECOMMENDATIONS_LOCK_ID } from "@/lib/advisory-lock";
import { getCronActor, recordCronRun } from "@/lib/cron-auth";

export async function POST(request: NextRequest) {
  const authCtx = await getCronActor(request);
  if (!authCtx) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  return withAdvisoryLock(
    WARM_RECOMMENDATIONS_LOCK_ID,
    async () => {
      const startTime = Date.now();
      let result;
      try {
        result = await warmRecommendationsCache();
      } catch (err) {
        // A throw used to skip the ledger write altogether, so the row kept the
        // last SUCCESSFUL run — the dashboard stayed green and only the ageing
        // "Last Run" timestamp hinted anything was wrong.
        await recordCronRun("recommendations", Date.now() - startTime, false);
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
      const failed = result.usersFailed;
      await recordCronRun("recommendations", durationMs, failed === 0);

      if (authCtx.trigger !== "cron") {
        await logAudit({
          userId: authCtx.userId,
          userName: authCtx.userName,
          action: "CACHE_WARM",
          target: "recommendations",
          details: { ...result, durationMs, trigger: authCtx.trigger },
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
        ...(failed > 0 ? { error: `${failed} user(s) failed to warm` } : {}),
        timestamp: new Date().toISOString(),
      }, failed > 0 ? { headers: { "X-Cron-Degraded": String(failed) } } : undefined);
    },
    () => NextResponse.json({ skipped: true, reason: "already running" }),
  );
}
