import { NextResponse } from "next/server";
import { withAdmin } from "@/lib/api-auth";
import { WARM_OMDB_LOCK_ID } from "@/lib/advisory-lock";
import { prewarmOmdbCache } from "@/lib/omdb-prewarm";
import { logAudit, auditContext } from "@/lib/audit";
import { translatorForRequest } from "@/lib/i18n/server-locale";
import { runAdminWarm } from "@/lib/warm-cooldown";

const COOLDOWN_MS = 5 * 60 * 1000;
const COOLDOWN_KEY = "lastOmdbWarmAt";

export const POST = withAdmin(async (req, _ctx, session) => {
  const t = translatorForRequest(req);
  // Same advisory lock as /api/cron/warm-omdb — an admin click while the cron
  // warm is running must not double-burn the OMDB free-tier daily quota. The
  // cooldown claim, its release on failure and the 409/429 answers live in
  // runAdminWarm (warm-cooldown.ts).
  return runAdminWarm({
    lockId: WARM_OMDB_LOCK_ID,
    cooldownKey: COOLDOWN_KEY,
    cooldownMs: COOLDOWN_MS,
    busyMessage: t("apiAdmin.warm.omdbRunning"),
    cooldownMessage: (seconds) => t("apiAdmin.warm.cooldown", { seconds }),
    failedMessage: t("apiAdmin.warm.failed"),
    scope: "[omdb-warm]",
    run: async (signal) => {
      const startTime = Date.now();
      const result = await prewarmOmdbCache({ signal });
      const durationMs = Date.now() - startTime;

      await logAudit({
        userId: session.user.id,
        userName: session.user.name ?? session.user.email,
        action: "CACHE_WARM",
        target: "omdb",
        details: { ...result, durationMs, trigger: "admin" },
        ...auditContext(req, session),
      });

      return NextResponse.json(result);
    },
  });
});
