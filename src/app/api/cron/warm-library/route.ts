import { NextRequest, NextResponse } from "next/server";
import { prewarmLibraryCache } from "@/lib/tmdb-prewarm";
import { logAudit } from "@/lib/audit";
import { withAdvisoryLock, WARM_LIBRARY_LOCK_ID } from "@/lib/advisory-lock";
import { isCronAuthorized, recordCronRun } from "@/lib/cron-auth";
import { readActiveSummonarrSessionFromRequest } from "@/lib/session-server";
import { tmdbAuth } from "@/lib/tmdb-auth";

// Recurring counterpart to the boot-time prewarm (instrumentation.ts) and the
// admin "Warm library cache" button. The prewarm's outputs carry 3-30 day
// age-aware TTLs and the sync purge reaps them (after the :details grace), so
// a long-uptime server used to decay to a cold library cache between
// restarts — nothing re-ran the warm. The 25%-remaining triage inside
// prewarmLibraryCache makes this recurring run a cheap incremental top-up
// (fresh rows skip; only the aging tail re-fetches), not a daily full walk.

async function getAuthContext(request: NextRequest): Promise<{ userId: string; userName: string; trigger: "admin" | "cron" } | null> {
  if (!(await isCronAuthorized(request))) return null;

  // DB-checked attribution: bearer-first then cookie, with revocation/cutoff/role
  // honored — so a stale or revoked admin JWT can't mis-attribute the audit row.
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

  if (!tmdbAuth()) {
    return NextResponse.json({ skipped: true, reason: "no TMDB credentials configured" });
  }

  return withAdvisoryLock(
    WARM_LIBRARY_LOCK_ID,
    async () => {
      const startTime = Date.now();
      let result;
      try {
        result = await prewarmLibraryCache();
      } catch (err) {
        // A throw used to skip the ledger write altogether, so the row kept the
        // last SUCCESSFUL run — the dashboard stayed green and only the ageing
        // "Last Run" timestamp hinted anything was wrong.
        await recordCronRun("library", Date.now() - startTime, false);
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
      await recordCronRun("library", durationMs, result.failed === 0);

      if (authCtx.trigger !== "cron") {
        await logAudit({
          userId: authCtx.userId,
          userName: authCtx.userName,
          action: "CACHE_WARM",
          target: "library",
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
