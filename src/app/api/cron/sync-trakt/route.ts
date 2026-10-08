import { NextRequest, NextResponse } from "next/server";
import { cronSkippedResponse, getCronActor, withCronRunRecording } from "@/lib/cron-auth";
import { withAdvisoryLock, TRAKT_SYNC_LOCK_ID } from "@/lib/advisory-lock";
import { syncTraktUsers, traktRunProblems } from "@/lib/trakt-user";

// Per-user Trakt (src/lib/trakt-user.ts, guardrail 34c): for every connected
// user, file new titles on their Trakt watchlist as requests (watchlist
// auto-request) and import their Trakt watch history for the For You seeds. A
// no-op until the admin saves both Trakt app credentials and turns on watchlist
// auto-request or For You. Scheduled by docker-entrypoint.sh every
// TRAKT_SYNC_INTERVAL.
export async function POST(request: NextRequest) {
  const authCtx = await getCronActor(request);
  if (!authCtx) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  return withCronRunRecording("trakt", () => withAdvisoryLock(
    TRAKT_SYNC_LOCK_ID,
    async (signal: AbortSignal) => {
      const startTime = Date.now();
      // Observes the lock's AbortSignal at every user and title boundary and
      // returns early on abort (guardrail 41).
      const result = await syncTraktUsers({ signal });
      const durationMs = Date.now() - startTime;

      // 200 on a partial failure (the entrypoint fast-retries any non-2xx);
      // X-Cron-Degraded is what marks the run failed in the ledger. A revoked
      // grant is the user's doing, not a run failure, so it does not degrade.
      const problems = traktRunProblems(result);
      const ok = problems === 0;
      return NextResponse.json(
        {
          ok,
          ...result,
          ...(ok ? {} : { error: `${problems} Trakt user sync(s) failed` }),
          durationMs,
          trigger: authCtx.trigger,
          timestamp: new Date().toISOString(),
        },
        ok ? undefined : { headers: { "X-Cron-Degraded": String(problems) } },
      );
    },
    // A lock-busy skip is not a run (guardrail 7b).
    () => cronSkippedResponse(),
  ));
}
