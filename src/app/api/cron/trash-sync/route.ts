import { NextRequest, NextResponse } from "next/server";
import { getCronActor, withCronRunRecording, cronSkippedResponse } from "@/lib/cron-auth";
import { logAudit } from "@/lib/audit";
import { withAdvisoryLock, TRASH_SYNC_LOCK_ID } from "@/lib/advisory-lock";
import { runTrashSync } from "@/lib/trash";
import { isFeatureEnabled } from "@/lib/features";

export async function POST(request: NextRequest) {
  const authCtx = await getCronActor(request);
  if (!authCtx) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  return withCronRunRecording("trash-sync", () => withAdvisoryLock(
    TRASH_SYNC_LOCK_ID,
    async (signal) => {
      // TRaSH Guides is OFF by default. runTrashSync answers that with an
      // `errors: ["trashGuidesEnabled is off"]` result, which this route used to
      // turn into a 500 + an audit row: the entrypoint fast-retries any non-2xx
      // at CRON_RETRY_INTERVAL (300s), so a stock deployment ran the DAILY job
      // 288×/day, wrote 288 SETTINGS_CHANGE rows/day and kept the Run-now badge
      // red. A disabled feature is a skip (200, no audit, no ledger failure),
      // the same shape warm-mdblist/warm-omdb use for missing credentials.
      if (!(await isFeatureEnabled("trashGuidesEnabled"))) {
        return NextResponse.json({ skipped: true, reason: "TRaSH Guides disabled" });
      }

      const startTime = Date.now();
      const result = await runTrashSync({ signal });
      const durationMs = Date.now() - startTime;

      const recreated = result.applied.filter((r) => r.recreated).length;
      const didWork = result.refreshed.length + result.applied.length > 0;
      // Audit an admin-driven run always; a scheduled run only when it changed
      // something — a cron tick that refreshed and applied nothing is not a
      // settings change, and auditing it daily is noise in the admin's trail.
      if (authCtx.trigger !== "cron" || didWork) await logAudit({
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

      // Status stays 200 on a partial failure (the entrypoint fast-retries any
      // non-2xx — a persistently failing spec would re-apply EVERY spec to every
      // arr instance every 300s instead of once a day); X-Cron-Degraded is what
      // marks the run failed in the ledger (withCronRunRecording).
      const ok = result.errors.length === 0;
      return NextResponse.json({
        ok,
        ...result,
        // `error` (singular) is the field the admin Run-now badge surfaces.
        ...(ok ? {} : { error: `${result.errors.length} TRaSH sync error(s)` }),
        durationMs,
        timestamp: new Date().toISOString(),
      }, ok ? undefined : { headers: { "X-Cron-Degraded": String(result.errors.length) } });
    },
    () => cronSkippedResponse(),
  ));
}
