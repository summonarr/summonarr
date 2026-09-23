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
        // Record the failed run before re-throwing. Otherwise the cron history
        // would still show the last successful run and look healthy.
        await recordCronRun("activity", Date.now() - startTime, false);
        throw err;
      }

      const durationMs = Date.now() - startTime;

      // Save this run to the cron history (Admin -> Settings -> System) for
      // both admin and cron triggers. It is kept in the Setting table, not
      // AuditLog, so scheduled runs don't flood the audit log. This warm has no
      // partial-failure count: it either finishes (ok) or throws (handled above).
      await recordCronRun("activity", durationMs);

      // Only manual (admin) runs get an audit row, so scheduled runs don't flood the table.
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
