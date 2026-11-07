import { NextRequest, NextResponse } from "next/server";
import { clearActivityCache, warmActivityCache } from "@/lib/play-history";
import { logAudit } from "@/lib/audit";
import { withAdvisoryLock, WARM_ACTIVITY_LOCK_ID } from "@/lib/advisory-lock";
import { cronSkippedResponse, getCronActor, withCronRunRecording } from "@/lib/cron-auth";

export async function POST(request: NextRequest) {
  const authCtx = await getCronActor(request);
  if (!authCtx) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  // withCronRunRecording saves every run to the cron history (Admin ->
  // Settings -> System) for both admin and cron triggers — a throw, a lock
  // connection that fails or a lock timeout as a failed run — and leaves a busy-lock skip
  // unrecorded. It is kept in the Setting table, not AuditLog, so scheduled
  // runs don't flood the audit log. This warm has no partial-failure count: it
  // either finishes (ok) or throws.
  return withCronRunRecording("activity", () => withAdvisoryLock(
    WARM_ACTIVITY_LOCK_ID,
    async () => {
      clearActivityCache();
      const startTime = Date.now();
      const { warmed } = await warmActivityCache();
      const durationMs = Date.now() - startTime;

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
    () => cronSkippedResponse(),
  ));
}
