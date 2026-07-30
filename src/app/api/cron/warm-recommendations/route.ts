import { NextRequest, NextResponse } from "next/server";
import { warmRecommendationsCache } from "@/lib/recommendations";
import { logAudit } from "@/lib/audit";
import { withAdvisoryLock, WARM_RECOMMENDATIONS_LOCK_ID } from "@/lib/advisory-lock";
import { isCronAuthorized, recordCronRun } from "@/lib/cron-auth";
import { readActiveSummonarrSessionFromRequest } from "@/lib/session-server";

async function getAuthContext(request: NextRequest): Promise<{ userId: string; userName: string; trigger: "admin" | "cron" } | null> {
  if (!(await isCronAuthorized(request))) return null;

  // DB-checked attribution: bearer-first then cookie, with revocation/cutoff/role
  // honored — so a stale or revoked admin JWT can't mis-attribute the audit row.
  // verifyAndRefreshSession (inside the helper) already rejects expired tokens.
  const claims = await readActiveSummonarrSessionFromRequest(request);
  if (claims?.role === "ADMIN") {
    return { userId: claims.id, userName: claims.name ?? "admin", trigger: "admin" };
  }
  return { userId: "system", userName: "cron", trigger: "cron" };
}

export async function POST(request: NextRequest) {
  const authCtx = await getAuthContext(request);
  if (!authCtx) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  return withAdvisoryLock(
    WARM_RECOMMENDATIONS_LOCK_ID,
    async () => {
      const startTime = Date.now();
      const result = await warmRecommendationsCache();
      const durationMs = Date.now() - startTime;

      // `lastRunAt` observability — see warm-activity for rationale.
      await recordCronRun("recommendations", durationMs);

      if (authCtx.trigger !== "cron") {
        await logAudit({
          userId: authCtx.userId,
          userName: authCtx.userName,
          action: "CACHE_WARM",
          target: "recommendations",
          details: { ...result, durationMs, trigger: authCtx.trigger },
        });
      }

      return NextResponse.json({
        ok: true,
        ...result,
        timestamp: new Date().toISOString(),
      });
    },
    () => NextResponse.json({ skipped: true, reason: "already running" }),
  );
}
