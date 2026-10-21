import { NextRequest, NextResponse } from "next/server";
import { cronSkippedResponse, getCronActor, withCronRunRecording } from "@/lib/cron-auth";
import { withAdvisoryLock, ARR_WATCH_LOCK_ID } from "@/lib/advisory-lock";
import { hasWatchableArrInstance, runArrWatch } from "@/lib/arr-watch-data";

// The Radarr/Sonarr monitor (src/lib/arr-watch.ts + arr-watch-data.ts): per
// configured, enabled instance, a disk that crossed the low-space line, every
// newly failed download, and every download that newly needs attention, sent
// to the outbound notification channels as arr.disk_low / arr.disk_ok /
// arr.download_failed / arr.queue_attention. Also writes the counts the admin
// nav's Download Queue badge reads. Scheduled by docker-entrypoint.sh every
// ARR_WATCH_INTERVAL (default 900 s).

// Well under the default interval, so a run that hangs on a dark instance is
// given up on before the next tick, and far under the lock's 30-minute default.
const ARR_WATCH_WORK_TIMEOUT_MS = 10 * 60_000;

export async function POST(request: NextRequest) {
  const authCtx = await getCronActor(request);
  if (!authCtx) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  // Neither integration on, or nothing configured: no run, no lock, no
  // upstream traffic — and no ledger row (X-Cron-Skipped), since no run happened.
  if (!(await hasWatchableArrInstance())) return cronSkippedResponse("no Radarr/Sonarr instance configured");

  return withCronRunRecording("arr-watch", () => withAdvisoryLock(
    ARR_WATCH_LOCK_ID,
    async (signal: AbortSignal) => {
      const startTime = Date.now();
      // Observes the lock's AbortSignal at every instance boundary and writes
      // nothing once it fires (guardrail 41).
      const result = await runArrWatch({ signal });
      const durationMs = Date.now() - startTime;

      // 200 on a partial failure (the entrypoint fast-retries any non-2xx);
      // X-Cron-Degraded is what marks the run failed in the ledger. A failed
      // read keeps that part's previous state.
      const problems = result.errors.length + (result.aborted ? 1 : 0);
      const ok = problems === 0;
      return NextResponse.json(
        {
          ok,
          ...result,
          ...(ok
            ? {}
            : { error: result.aborted ? "the run was stopped before it finished" : `${result.errors.length} Radarr/Sonarr read(s) failed` }),
          durationMs,
          trigger: authCtx.trigger,
          timestamp: new Date().toISOString(),
        },
        ok ? undefined : { headers: { "X-Cron-Degraded": String(problems) } },
      );
    },
    // A lock-busy skip is not a run (guardrail 7b).
    () => cronSkippedResponse(),
    { timeoutMs: ARR_WATCH_WORK_TIMEOUT_MS },
  ));
}
