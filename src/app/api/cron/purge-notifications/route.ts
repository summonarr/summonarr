import { NextRequest, NextResponse } from "next/server";
import { cronSkippedResponse, isCronAuthorized, withCronRunRecording } from "@/lib/cron-auth";
import { logAudit } from "@/lib/audit";
import { withAdvisoryLock, PURGE_NOTIFICATIONS_LOCK_ID } from "@/lib/advisory-lock";
import { purgeOldNotifications } from "@/lib/notification-retention";

export async function POST(request: NextRequest) {
  if (!(await isCronAuthorized(request))) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  return withCronRunRecording("notifications:purge", () => withAdvisoryLock(
    PURGE_NOTIFICATIONS_LOCK_ID,
    async (signal: AbortSignal) => {
      try {
        const result = await purgeOldNotifications({ signal });
        // An aborted run returns what it got through; the next tick continues.
        if (result.deleted > 0) {
          await logAudit({
            userId: "system",
            userName: "cron",
            action: "SETTINGS_CHANGE",
            target: "notifications:purge",
            details: {
              deleted: result.deleted,
              readRetentionDays: result.readDays,
              maxRetentionDays: result.maxDays,
              aborted: result.aborted,
            },
          });
        }
        return NextResponse.json({
          ok: true,
          deleted: result.deleted,
          aborted: result.aborted,
          timestamp: new Date().toISOString(),
        });
      } catch (err) {
        console.error("[cron/purge-notifications] purge failed:", err instanceof Error ? err.message : err);
        // Non-2xx so withCronRunRecording marks the run failed.
        return NextResponse.json({ ok: false, error: "purge failed" }, { status: 500 });
      }
    },
    () => cronSkippedResponse(),
  ));
}
