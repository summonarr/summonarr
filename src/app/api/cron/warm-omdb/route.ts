import { NextRequest, NextResponse } from "next/server";
import { prewarmOmdbCache } from "@/lib/omdb-prewarm";
import { logAudit } from "@/lib/audit";
import { withAdvisoryLock, WARM_OMDB_LOCK_ID } from "@/lib/advisory-lock";
import { getCronActor, recordCronRun } from "@/lib/cron-auth";
import { prisma } from "@/lib/prisma";

export async function POST(request: NextRequest) {
  const authCtx = await getCronActor(request);
  if (!authCtx) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const apiKey = await prisma.setting.findUnique({ where: { key: "omdbApiKey" } });
  if (!apiKey?.value.trim()) {
    return NextResponse.json({ skipped: true, reason: "no OMDB API key configured" });
  }

  return withAdvisoryLock(
    WARM_OMDB_LOCK_ID,
    async () => {
      const startTime = Date.now();
      let result;
      try {
        result = await prewarmOmdbCache();
      } catch (err) {
        // A throw used to skip the ledger write altogether, so the row kept the
        // last SUCCESSFUL run — the dashboard stayed green and only the ageing
        // "Last Run" timestamp hinted anything was wrong.
        await recordCronRun("omdb", Date.now() - startTime, false);
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
      const failed = result.failed;
      await recordCronRun("omdb", durationMs, failed === 0);

      if (authCtx.trigger !== "cron") {
        await logAudit({
          userId: authCtx.userId,
          userName: authCtx.userName,
          action: "CACHE_WARM",
          target: "omdb",
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
        ...(failed > 0 ? { error: `${failed} of ${result.total} OMDB items failed to warm` } : {}),
        timestamp: new Date().toISOString(),
      }, failed > 0 ? { headers: { "X-Cron-Degraded": String(failed) } } : undefined);
    },
    () => NextResponse.json({ skipped: true, reason: "already running" }),
  );
}
