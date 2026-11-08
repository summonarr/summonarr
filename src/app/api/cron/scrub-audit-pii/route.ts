import { logAudit, getAuditPiiRetentionDays } from "@/lib/audit";
import { SCRUB_AUDIT_PII_LOCK_ID } from "@/lib/advisory-lock";
import { scrubAuditPii } from "@/lib/audit-pii-scrub";
import { defineCronRoute } from "@/lib/cron-route";

export const POST = defineCronRoute({
  target: "audit-log:pii-scrub",
  lockId: SCRUB_AUDIT_PII_LOCK_ID,
  // Not signal-aware, and needn't be: every pass is idempotent and bounded by
  // the cutoff, and a run past its lock timeout keeps the lock until it
  // settles (withAdvisoryLock), so a second run never starts beside it.
  async run() {
    const retentionDays = await getAuditPiiRetentionDays();
    const cutoff = new Date(Date.now() - retentionDays * 24 * 60 * 60 * 1000);

    // The same scrub as the admin DELETE /api/admin/audit-log handler
    // (audit-pii-scrub.ts): IP address, user agent and user name on every old
    // row, the details of login/logout events, and the target-user names in
    // admin-action details, once they pass the retention cutoff.
    const { scrubbed, authDetailsCleared, adminDetailsScrubbed } = await scrubAuditPii(cutoff);

    await logAudit({
      userId: "system",
      userName: "cron",
      action: "SETTINGS_CHANGE",
      target: "audit-log:pii-scrub",
      details: {
        scrubbed,
        authDetailsCleared,
        adminDetailsScrubbed,
        cutoff: cutoff.toISOString(),
        retentionDays,
      },
    });

    return {
      body: {
        scrubbed,
        authDetailsCleared,
        adminDetailsScrubbed,
        cutoff: cutoff.toISOString(),
      },
    };
  },
});
