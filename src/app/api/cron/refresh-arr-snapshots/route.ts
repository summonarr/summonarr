import { NextRequest, NextResponse } from "next/server";
import { cronSkippedResponse, getCronActor, withCronRunRecording } from "@/lib/cron-auth";
import { withAdvisoryLock, ARR_SNAPSHOT_LOCK_ID } from "@/lib/advisory-lock";
import { dueSnapshots, refreshArrSnapshots } from "@/lib/arr-snapshot";

// Keeps the admin Radarr/Sonarr pages' last answers fresh in the background
// (src/lib/arr-snapshot.ts, guardrail 5h): every view an admin opened in the
// last day is re-read on its page's priority — the queue and health every 5
// minutes, Missing / history / calendar / the title manager every 10, Arr
// System every 15 — so the page paints recent data the moment it opens.
// Scheduled by docker-entrypoint.sh every ARR_SNAPSHOT_INTERVAL (default 300 s).

// Under the 5-minute interval, so a run held up by a dark instance stops
// starting re-reads before the next tick; far under the lock's 30-minute default.
const ARR_SNAPSHOT_WORK_TIMEOUT_MS = 4 * 60_000;

export async function POST(request: NextRequest) {
  const authCtx = await getCronActor(request);
  if (!authCtx) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  // Nothing due (no admin opened an arr page lately, or everything is fresh):
  // no run, no lock, no upstream traffic, no ledger row.
  if (dueSnapshots().length === 0) return cronSkippedResponse("no arr page view is due");

  return withCronRunRecording("arr-snapshots", () => withAdvisoryLock(
    ARR_SNAPSHOT_LOCK_ID,
    async (signal: AbortSignal) => {
      const startTime = Date.now();
      // Observes the lock's AbortSignal before every re-read (guardrail 41).
      const result = await refreshArrSnapshots({ signal });
      const durationMs = Date.now() - startTime;
      // 200 on a partial failure (the entrypoint fast-retries any non-2xx);
      // X-Cron-Degraded marks the run failed in the ledger. A failed re-read
      // keeps that view's last good answer.
      const problems = result.failed + (result.aborted ? 1 : 0);
      const ok = problems === 0;
      return NextResponse.json(
        {
          ok,
          ...result,
          ...(ok ? {} : { error: result.aborted ? "the run was stopped before it finished" : `${result.failed} re-read(s) failed` }),
          durationMs,
          trigger: authCtx.trigger,
          timestamp: new Date().toISOString(),
        },
        ok ? undefined : { headers: { "X-Cron-Degraded": String(problems) } },
      );
    },
    // A lock-busy skip is not a run (guardrail 7b).
    () => cronSkippedResponse(),
    { timeoutMs: ARR_SNAPSHOT_WORK_TIMEOUT_MS },
  ));
}
