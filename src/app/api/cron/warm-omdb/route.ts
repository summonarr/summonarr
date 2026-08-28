import { NextRequest, NextResponse } from "next/server";
import { prewarmOmdbCache } from "@/lib/omdb-prewarm";
import { logAudit } from "@/lib/audit";
import { withAdvisoryLock, WARM_OMDB_LOCK_ID } from "@/lib/advisory-lock";
import { isCronAuthorized, recordCronRun } from "@/lib/cron-auth";
import { readActiveSummonarrSessionFromRequest } from "@/lib/session-server";
import { prisma } from "@/lib/prisma";

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

  const apiKey = await prisma.setting.findUnique({ where: { key: "omdbApiKey" } });
  if (!apiKey?.value.trim()) {
    return NextResponse.json({ skipped: true, reason: "no OMDB API key configured" });
  }

  return withAdvisoryLock(
    WARM_OMDB_LOCK_ID,
    async () => {
      const startTime = Date.now();
      let result;
      try {
        result = await prewarmOmdbCache();
      } catch (err) {
        // A throw used to skip the ledger write altogether, so the row kept the
        // last SUCCESSFUL run — the dashboard stayed green and only the ageing
        // "Last Run" timestamp hinted anything was wrong.
        await recordCronRun("omdb", Date.now() - startTime, false);
        throw err;
      }

      const durationMs = Date.now() - startTime;

      // `lastRunAt` observability — see warm-activity for rationale.
            // `ok` is derived, not assumed. Two ways a warm used to write green:
      // a throw skipped this line entirely and left the PREVIOUS success
      // standing, and a run that completed while reporting failures wrote an
      // affirmative success anyway. The cron table reads `ok === false` to show
      // Error, and the container reschedules a failing job every
      // CRON_RETRY_INTERVAL (300s) — so a job broken for a week showed a green
      // tick while being retried 12x an hour.
      await recordCronRun("omdb", durationMs, result.failed === 0);

      if (authCtx.trigger !== "cron") {
        await logAudit({
          userId: authCtx.userId,
          userName: authCtx.userName,
          action: "CACHE_WARM",
          target: "omdb",
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
