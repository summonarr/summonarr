import { logAudit } from "@/lib/audit";
import { TRASH_SYNC_LOCK_ID } from "@/lib/advisory-lock";
import { defineCronRoute } from "@/lib/cron-route";
import { runTrashSync } from "@/lib/trash";
import { isFeatureEnabled } from "@/lib/features";
import { TRASH_DISABLED_SKIP_REASON } from "@/lib/trash-sync-text";

export const POST = defineCronRoute({
  target: "trash-sync",
  lockId: TRASH_SYNC_LOCK_ID,
  // TRaSH Guides is OFF by default. runTrashSync answers that with an
  // `errors: ["trashGuidesEnabled is off"]` result, which this route used to
  // turn into a 500 + an audit row: the entrypoint fast-retries any non-2xx
  // at CRON_RETRY_INTERVAL (300s), so a stock deployment ran the DAILY job
  // 288×/day, wrote 288 SETTINGS_CHANGE rows/day and kept the Run-now badge
  // red. A disabled feature is a skip (200, no audit), decided before the lock
  // and the run ledger: no run happened (guardrail 7b).
  // The admin card reads this reason back (trash-sync-text.ts) to tell "off"
  // from "already running".
  skipReason: async () => ((await isFeatureEnabled("trashGuidesEnabled")) ? null : TRASH_DISABLED_SKIP_REASON),
  async run({ signal, actor, elapsedMs }) {
    const result = await runTrashSync({ signal });
    const durationMs = elapsedMs();

    const recreated = result.applied.filter((r) => r.recreated).length;
    const didWork = result.refreshed.length + result.applied.length > 0;
    // Audit an admin-driven run always; a scheduled run only when it changed
    // something — a cron tick that refreshed and applied nothing is not a
    // settings change, and auditing it daily is noise in the admin's trail.
    if (actor.trigger !== "cron" || didWork) await logAudit({
      userId: actor.userId,
      userName: actor.userName,
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
        trigger: actor.trigger,
      },
    });

    // A partial failure stays 200 with X-Cron-Degraded: a non-2xx would make a
    // persistently failing spec re-apply EVERY spec to every arr instance every
    // 300s instead of once a day.
    return {
      body: { ...result, durationMs },
      problems: result.errors.length,
      error: `${result.errors.length} TRaSH sync error(s)`,
    };
  },
});
