import { NextRequest, NextResponse } from "next/server";
import { getCronActor, withCronRunRecording } from "@/lib/cron-auth";
import { logAudit } from "@/lib/audit";
import { withAdvisoryLock, TRASH_SYNC_LOCK_ID } from "@/lib/advisory-lock";
import { runTrashSync } from "@/lib/trash";

export async function POST(request: NextRequest) {
  const authCtx = await getCronActor(request);
  if (!authCtx) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  return withCronRunRecording("trash-sync", () => withAdvisoryLock(
    TRASH_SYNC_LOCK_ID,
    async () => {
      const startTime = Date.now();
      const result = await runTrashSync();
      const durationMs = Date.now() - startTime;

      const recreated = result.applied.filter((r) => r.recreated).length;
      await logAudit({
        userId: authCtx.userId,
        userName: authCtx.userName,
        action: "SETTINGS_CHANGE",
        target: "trash-sync",
        details: {
          refreshed: result.refreshed,
          applied: {
            count: result.applied.length,
            failures: result.applied.filter((r) => !r.ok).length,
            ...(recreated > 0 ? { recreated } : {}),
          },
          errors: result.errors,
          durationMs,
          trigger: authCtx.trigger,
        },
      });

      // Non-2xx on errors so withCronRunRecording marks ok=false.
      const status = result.errors.length > 0 ? 500 : 200;
      return NextResponse.json({
        ok: result.errors.length === 0,
        ...result,
        // `error` (singular) is the field the admin Run-now badge surfaces.
        ...(result.errors.length > 0 ? { error: `${result.errors.length} TRaSH sync error(s)` } : {}),
        durationMs,
        timestamp: new Date().toISOString(),
      }, { status });
    },
    () => NextResponse.json({ skipped: true, reason: "already running" }),
  ));
}
