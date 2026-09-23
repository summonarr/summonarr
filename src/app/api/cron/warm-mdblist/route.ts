import { NextRequest, NextResponse } from "next/server";
import { prewarmMdblistCache } from "@/lib/mdblist-prewarm";
import { logAudit } from "@/lib/audit";
import { withAdvisoryLock, WARM_MDBLIST_LOCK_ID } from "@/lib/advisory-lock";
import { getCronActor, recordCronRun } from "@/lib/cron-auth";
import { prisma } from "@/lib/prisma";

export async function POST(request: NextRequest) {
  const authCtx = await getCronActor(request);
  if (!authCtx) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const apiKey = await prisma.setting.findUnique({ where: { key: "mdblistApiKey" } });
  if (!apiKey?.value.trim()) {
    return NextResponse.json({ skipped: true, reason: "no MDBList API key configured" });
  }

  return withAdvisoryLock(
    WARM_MDBLIST_LOCK_ID,
    async (signal) => {
      const startTime = Date.now();
      let result;
      try {
        result = await prewarmMdblistCache({ signal });
      } catch (err) {
        // Record the failed run before re-throwing. Otherwise the cron history
        // would still show the last successful run and look healthy.
        await recordCronRun("mdblist", Date.now() - startTime, false);
        throw err;
      }

      const durationMs = Date.now() - startTime;

      // Save this run to the cron history (Admin -> Settings -> System). It is
      // kept in the Setting table, not AuditLog, so scheduled runs don't flood
      // the audit log. `ok` comes from the real failure count, so a run that
      // finished with failures shows as an error instead of a green tick.
      const failed = result.failed;
      await recordCronRun("mdblist", durationMs, failed === 0);

      if (authCtx.trigger !== "cron") {
        await logAudit({
          userId: authCtx.userId,
          userName: authCtx.userName,
          action: "CACHE_WARM",
          target: "mdblist",
          details: { ...result, durationMs, trigger: authCtx.trigger },
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
        ...(failed > 0 ? { error: `${failed} of ${result.total} MDBList items failed to warm` } : {}),
        timestamp: new Date().toISOString(),
      }, failed > 0 ? { headers: { "X-Cron-Degraded": String(failed) } } : undefined);
    },
    () => NextResponse.json({ skipped: true, reason: "already running" }),
  );
}
