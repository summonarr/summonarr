// The Radarr/Sonarr monitor as a cron job (src/lib/arr-watch.ts +
// arr-watch-data.ts): per configured, enabled instance, a disk that crossed
// the low-space line, every newly failed download, and every download that
// newly needs attention, sent to the outbound notification channels as
// arr.disk_low / arr.disk_ok / arr.download_failed / arr.queue_attention. Also
// writes the counts the admin nav's Download Queue badge reads.
//
// ONE config, two callers: the /api/cron/arr-watch route (scheduled by
// docker-entrypoint.sh every ARR_WATCH_INTERVAL, default 900 s) and the
// webhook-driven recount (arr-watch-trigger.ts) — so both take the same lock,
// write the same run ledger and observe the same abort signal.
import { ARR_WATCH_LOCK_ID } from "./advisory-lock";
import { hasWatchableArrInstance, runArrWatch } from "./arr-watch-data";
import type { CronRouteConfig } from "./cron-route";

// Well under the default interval, so a run that hangs on a dark instance is
// given up on before the next tick, and far under the lock's 30-minute default.
const ARR_WATCH_WORK_TIMEOUT_MS = 10 * 60_000;

export const ARR_WATCH_CRON: CronRouteConfig = {
  target: "arr-watch",
  lockId: ARR_WATCH_LOCK_ID,
  timeoutMs: ARR_WATCH_WORK_TIMEOUT_MS,
  // Neither integration on, or nothing configured: no run, no lock, no
  // upstream traffic — and no ledger row, since no run happened.
  skipReason: async () => ((await hasWatchableArrInstance()) ? null : "no Radarr/Sonarr instance configured"),
  async run({ signal, actor, elapsedMs }) {
    // Observes the lock's AbortSignal at every instance boundary and writes
    // nothing once it fires (guardrail 41). A failed read keeps that part's
    // previous state.
    const result = await runArrWatch({ signal });
    return {
      body: { ...result, durationMs: elapsedMs(), trigger: actor.trigger },
      problems: result.errors.length + (result.aborted ? 1 : 0),
      error: result.aborted ? "the run was stopped before it finished" : `${result.errors.length} Radarr/Sonarr read(s) failed`,
    };
  },
};
