import { defineCronRoute } from "@/lib/cron-route";
import { ARR_SNAPSHOT_LOCK_ID } from "@/lib/advisory-lock";
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

export const POST = defineCronRoute({
  target: "arr-snapshots",
  lockId: ARR_SNAPSHOT_LOCK_ID,
  timeoutMs: ARR_SNAPSHOT_WORK_TIMEOUT_MS,
  // Nothing due (no admin opened an arr page lately, or everything is fresh):
  // no run, no lock, no upstream traffic, no ledger row.
  skipReason: () => (dueSnapshots().length === 0 ? "no arr page view is due" : null),
  async run({ signal, actor, elapsedMs }) {
    // Observes the lock's AbortSignal before every re-read (guardrail 41). A
    // failed re-read keeps that view's last good answer.
    const result = await refreshArrSnapshots({ signal });
    return {
      body: { ...result, durationMs: elapsedMs(), trigger: actor.trigger },
      problems: result.failed + (result.aborted ? 1 : 0),
      error: result.aborted ? "the run was stopped before it finished" : `${result.failed} re-read(s) failed`,
    };
  },
});
