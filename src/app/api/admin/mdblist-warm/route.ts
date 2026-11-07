import { NextResponse } from "next/server";
import { readJsonCappedOr } from "@/lib/body-size";
import { withAdmin } from "@/lib/api-auth";
import { WARM_MDBLIST_LOCK_ID } from "@/lib/advisory-lock";
import { prewarmMdblistCache } from "@/lib/mdblist-prewarm";
import { logAudit, auditContext } from "@/lib/audit";
import { translatorForRequest } from "@/lib/i18n/server-locale";
import { runAdminWarm } from "@/lib/warm-cooldown";

const COOLDOWN_MS = 5 * 60 * 1000;
const COOLDOWN_KEY = "lastMdblistWarmAt";

export const POST = withAdmin(async (req, _ctx, session) => {
  const t = translatorForRequest(req);
  const body = await readJsonCappedOr<{ force?: boolean }>(req, 8192, {});
  if (body instanceof NextResponse) return body;
  const force = body.force === true;

  // Same advisory lock as /api/cron/warm-mdblist — an admin click (force
  // included) while the cron warm is running must not double-burn API quota.
  // Force skips the cooldown claim but still stamps the slot, so the next
  // non-force click gets a fresh 5-minute window. The claim, its release on
  // failure and the 409/429 answers live in runAdminWarm (warm-cooldown.ts).
  return runAdminWarm({
    lockId: WARM_MDBLIST_LOCK_ID,
    cooldownKey: COOLDOWN_KEY,
    cooldownMs: COOLDOWN_MS,
    force,
    busyMessage: t("apiAdmin.warm.mdblistRunning"),
    cooldownMessage: (seconds) => t("apiAdmin.warm.cooldown", { seconds }),
    failedMessage: t("apiAdmin.warm.failed"),
    scope: "[mdblist-warm]",
    run: async (signal) => {
      const startTime = Date.now();
      const result = await prewarmMdblistCache({ force, signal });
      const durationMs = Date.now() - startTime;

      await logAudit({
        userId: session.user.id,
        userName: session.user.name ?? session.user.email,
        action: "CACHE_WARM",
        target: "mdblist",
        details: { ...result, durationMs, trigger: force ? "admin-force" : "admin" },
        ...auditContext(req, session),
      });

      return NextResponse.json(result);
    },
  });
});
