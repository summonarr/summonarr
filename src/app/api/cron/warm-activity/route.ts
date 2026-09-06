import { NextRequest, NextResponse } from "next/server";
import { clearActivityCache, warmActivityCache } from "@/lib/play-history";
import { logAudit } from "@/lib/audit";
import { withAdvisoryLock } from "@/lib/advisory-lock";
import { getCronActor, recordCronRun } from "@/lib/cron-auth";

export async function POST(request: NextRequest) {
  const authCtx = await getCronActor(request);
  if (!authCtx) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  return withAdvisoryLock(
    2003,
    async () => {
      clearActivityCache();
      const startTime = Date.now();
      let warmed: number;
      try {
        ({ warmed } = await warmActivityCache());
      } catch (err) {
        // A throw used to skip the ledger write altogether, so the row kept the
        // last SUCCESSFUL run — the dashboard stayed green and only the ageing
        // "Last Run" timestamp hinted anything was wrong.
        await recordCronRun("activity", Date.now() - startTime, false);
        throw err;
      }

      const durationMs = Date.now() - startTime;

      // `lastRunAt` observability — written for both admin and cron triggers
      // (cf. /settings?tab=system). Stored in Setting, not AuditLog, so cron
      // runs don't flood the audit table.
            // `ok` is derived, not assumed. Two ways a warm used to write green:
      // a throw skipped this line entirely and left the PREVIOUS success
      // standing, and a run that completed while reporting failures wrote an
      // affirmative success anyway. The cron table reads `ok === false` to show
      // Error, and the container reschedules a failing job every
      // CRON_RETRY_INTERVAL (300s) — so a job broken for a week showed a green
      // tick while being retried 12x an hour.
      await recordCronRun("activity", durationMs);

      // Skip audit log for automated cron runs to avoid flooding the audit table
      if (authCtx.trigger !== "cron") {
        await logAudit({
          userId: authCtx.userId,
          userName: authCtx.userName,
          action: "CACHE_WARM",
          target: "activity",
          details: { warmed, durationMs, trigger: authCtx.trigger },
        });
      }

      return NextResponse.json({
        ok: true,
        warmed,
        timestamp: new Date().toISOString(),
      });
    },
    () => NextResponse.json({ skipped: true, reason: "already running" }),
  );
}
