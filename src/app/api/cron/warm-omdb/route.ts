import { NextRequest, NextResponse } from "next/server";
import { prewarmOmdbCache } from "@/lib/omdb-prewarm";
import { logAudit } from "@/lib/audit";
import { withAdvisoryLock, WARM_OMDB_LOCK_ID } from "@/lib/advisory-lock";
import { cronSkippedResponse, getCronActor, withCronRunRecording } from "@/lib/cron-auth";
import { prisma } from "@/lib/prisma";

export async function POST(request: NextRequest) {
  const authCtx = await getCronActor(request);
  if (!authCtx) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const apiKey = await prisma.setting.findUnique({ where: { key: "omdbApiKey" } });
  // Not configured: no run happened, so it is answered as a skip
  // (X-Cron-Skipped) and kept out of the run history, decided before the lock.
  if (!apiKey?.value.trim()) {
    return cronSkippedResponse("no OMDB API key configured");
  }

  // withCronRunRecording saves every run to the cron history (Admin ->
  // Settings -> System) — a throw, a lock connection that fails or a lock
  // timeout as a failed run, and a run with failures (X-Cron-Degraded below)
  // as an error instead of a green tick — and leaves a busy-lock skip
  // unrecorded. It is kept in the Setting table, not AuditLog, so scheduled
  // runs don't flood the audit log.
  return withCronRunRecording("omdb", () => withAdvisoryLock(
    WARM_OMDB_LOCK_ID,
    async (signal) => {
      const startTime = Date.now();
      const result = await prewarmOmdbCache({ signal });
      const durationMs = Date.now() - startTime;
      const failed = result.failed;

      if (authCtx.trigger !== "cron") {
        await logAudit({
          userId: authCtx.userId,
          userName: authCtx.userName,
          action: "CACHE_WARM",
          target: "omdb",
          details: { ...result, durationMs, trigger: authCtx.trigger },
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
        ...(failed > 0 ? { error: `${failed} of ${result.total} OMDB items failed to warm` } : {}),
        timestamp: new Date().toISOString(),
      }, failed > 0 ? { headers: { "X-Cron-Degraded": String(failed) } } : undefined);
    },
    () => cronSkippedResponse(),
  ));
}
