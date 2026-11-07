import { NextResponse } from "next/server";
import { withAdmin } from "@/lib/api-auth";
import { WARM_ACTIVITY_LOCK_ID } from "@/lib/advisory-lock";
import { warmActivityCache } from "@/lib/play-history";
import { logAudit, auditContext } from "@/lib/audit";
import { translatorForRequest } from "@/lib/i18n/server-locale";
import { runAdminWarm } from "@/lib/warm-cooldown";

const COOLDOWN_MS = 2 * 60 * 1000;
const COOLDOWN_KEY = "lastActivityWarmAt";

export const POST = withAdmin(async (req, _ctx, session) => {
  const t = translatorForRequest(req);
  // Same advisory lock as /api/cron/warm-activity — an admin click while the
  // hourly cron is mid-walk must not run the five stats aggregates, the calendar
  // and the rewatch queries a second time against the 5-connection pool
  // (guardrail 41). The cooldown claim, its release on failure and the 409/429
  // answers live in runAdminWarm (warm-cooldown.ts).
  return runAdminWarm({
    lockId: WARM_ACTIVITY_LOCK_ID,
    cooldownKey: COOLDOWN_KEY,
    cooldownMs: COOLDOWN_MS,
    busyMessage: t("apiAdmin.warm.activityRunning"),
    cooldownMessage: (seconds) => t("apiAdmin.warm.activityCooldown", { seconds }),
    failedMessage: t("apiAdmin.warm.failed"),
    scope: "[activity-warm]",
    run: async (_signal, claimedAt) => {
      const startTime = Date.now();
      const { warmed } = await warmActivityCache();
      const durationMs = Date.now() - startTime;

      await logAudit({
        userId: session.user.id,
        userName: session.user.name ?? session.user.email,
        action: "CACHE_WARM",
        target: "activity",
        details: { warmed, durationMs, trigger: "admin" },
        ...auditContext(req, session),
      });

      return NextResponse.json({
        ok: true,
        warmed,
        lastWarmAt: new Date(claimedAt).toISOString(),
      });
    },
  });
});
