import { NextResponse } from "next/server";
import { withAdmin } from "@/lib/api-auth";
import { withAdvisoryLock, WARM_ACTIVITY_LOCK_ID } from "@/lib/advisory-lock";
import { prisma } from "@/lib/prisma";
import { warmActivityCache } from "@/lib/play-history";
import { logAudit, auditContext } from "@/lib/audit";
import { translatorForRequest } from "@/lib/i18n/server-locale";
import type { Translator } from "@/lib/i18n/translate";

const COOLDOWN_MS = 2 * 60 * 1000;
const COOLDOWN_KEY = "lastActivityWarmAt";

function busyResponse(t: Translator) {
  return NextResponse.json(
    { ok: false, error: t("apiAdmin.warm.activityRunning"), retryAfter: 30 },
    { status: 409, headers: { "Retry-After": "30" } },
  );
}

export const POST = withAdmin(async (req, _ctx, session) => {
  const t = translatorForRequest(req);
  // Same advisory lock as /api/cron/warm-activity — an admin click while the
  // hourly cron is mid-walk must not run the five stats aggregates, the calendar
  // and the rewatch queries a second time against the 5-connection pool
  // (guardrail 41; the library/mdblist/omdb warms already do this). The cooldown
  // CAS lives INSIDE the lock so a lock-busy 409 can't burn the 2-minute
  // cooldown for a warm that never ran.
  return withAdvisoryLock(
    WARM_ACTIVITY_LOCK_ID,
    async () => {
      const now = Date.now();

      // One atomic SQL statement claims the cooldown slot: it writes the new
      // timestamp only if the old one is at least COOLDOWN_MS old (or unreadable).
      // Two admins clicking at once can't both win, because Postgres serializes
      // the write. `claimed` is the number of rows written (0 = still cooling down).
      const claimed = await prisma.$executeRaw`
        INSERT INTO "Setting" (key, value, "updatedAt")
        VALUES (${COOLDOWN_KEY}, ${String(now)}, NOW())
        ON CONFLICT (key) DO UPDATE
          SET value = EXCLUDED.value, "updatedAt" = NOW()
        WHERE "Setting".value !~ '^[0-9]+$'
           OR CAST("Setting".value AS BIGINT) + ${COOLDOWN_MS}::bigint <= ${now}::bigint
      `;
      if (claimed === 0) {
        const row = await prisma.setting.findUnique({ where: { key: COOLDOWN_KEY } });
        const lastMs = row ? parseInt(row.value, 10) || 0 : 0;
        const remaining = COOLDOWN_MS - (now - lastMs);
        return NextResponse.json(
          {
            error: t("apiAdmin.warm.activityCooldown", { seconds: Math.ceil(remaining / 1000) }),
            retryAfter: Math.ceil(remaining / 1000),
          },
          { status: 429 }
        );
      }

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
        lastWarmAt: new Date(now).toISOString(),
      });
    },
    () => busyResponse(t),
  );
});
