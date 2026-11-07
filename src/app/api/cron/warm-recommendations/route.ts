import { NextRequest, NextResponse } from "next/server";
import { warmRecommendationsCache } from "@/lib/recommendations";
import { logAudit } from "@/lib/audit";
import { withAdvisoryLock, WARM_RECOMMENDATIONS_LOCK_ID } from "@/lib/advisory-lock";
import { cronSkippedResponse, getCronActor, withCronRunRecording } from "@/lib/cron-auth";

export async function POST(request: NextRequest) {
  const authCtx = await getCronActor(request);
  if (!authCtx) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  // withCronRunRecording saves every run to the cron history (Admin ->
  // Settings -> System) — a throw, a lock connection that fails or a lock
  // timeout as a failed run, and a degraded run (X-Cron-Degraded below) as an
  // error instead of a green tick — and leaves a busy-lock skip unrecorded. It
  // is kept in the Setting table, not AuditLog, so scheduled runs don't flood
  // the audit log.
  return withCronRunRecording("recommendations", () => withAdvisoryLock(
    WARM_RECOMMENDATIONS_LOCK_ID,
    async (signal) => {
      const startTime = Date.now();
      const result = await warmRecommendationsCache({ signal });
      const durationMs = Date.now() - startTime;

      // A failed graph refresh also counts as a failure: when it fails, no user
      // is recomputed at all (there is no live fallback, guardrail 40), so the
      // run must not look like a clean run where nobody happened to change.
      const failed = result.usersFailed;

      if (authCtx.trigger !== "cron") {
        await logAudit({
          userId: authCtx.userId,
          userName: authCtx.userName,
          action: "CACHE_WARM",
          target: "recommendations",
          details: { ...result, durationMs, trigger: authCtx.trigger },
        });
      }

      // The body's `ok` matches what gets recorded. The admin "Run now"
      // badge (cron-job-table.tsx) turns red on `ok: false` or an `error` field.
      // The status stays 200 on purpose: the container retries any non-2xx
      // every CRON_RETRY_INTERVAL (300s) instead of waiting for the job's normal
      // interval. `error` plus the X-Cron-Degraded header mean "finished, but
      // with failures" (the same signal withCronRunRecording reads).
      const degraded = failed > 0 || result.graphFailed;
      const error = result.graphFailed
        ? "the recommendation graph refresh failed — no user was recomputed and every shelf was left as-is"
        : failed > 0
          ? `${failed} user(s) failed to warm`
          : undefined;

      return NextResponse.json({
        ok: !degraded,
        ...result,
        ...(error ? { error } : {}),
        timestamp: new Date().toISOString(),
      }, degraded ? { headers: { "X-Cron-Degraded": String(result.graphFailed ? "graph" : failed) } } : undefined);
    },
    () => cronSkippedResponse(),
  ));
}
