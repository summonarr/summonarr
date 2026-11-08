import { NextResponse } from "next/server";
import { logAudit } from "@/lib/audit";
import { PURGE_NOTIFICATIONS_LOCK_ID } from "@/lib/advisory-lock";
import { defineCronRoute } from "@/lib/cron-route";
import { purgeOldNotifications } from "@/lib/notification-retention";

export const POST = defineCronRoute({
  target: "notifications:purge",
  lockId: PURGE_NOTIFICATIONS_LOCK_ID,
  async run({ signal }) {
    try {
      // Deletes in id batches and returns on abort (guardrail 41) with what it
      // got through; the next run continues.
      const result = await purgeOldNotifications({ signal });
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
      // A stopped run left retention behind: it is degraded, not a clean run.
      return {
        body: { deleted: result.deleted, aborted: result.aborted },
        problems: result.aborted ? 1 : 0,
        error: "the run was stopped before it finished",
      };
    } catch (err) {
      console.error("[cron/purge-notifications] purge failed:", err instanceof Error ? err.message : err);
      // Non-2xx so the run is recorded as failed.
      return NextResponse.json({ ok: false, error: "purge failed" }, { status: 500 });
    }
  },
});
