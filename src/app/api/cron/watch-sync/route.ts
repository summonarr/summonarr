import { defineCronRoute } from "@/lib/cron-route";
import { WATCH_SYNC_LOCK_ID } from "@/lib/advisory-lock";
import { isFeatureEnabled } from "@/lib/features";
import { WATCH_SYNC_FEATURE_KEY, runWatchSync, watchSyncProblems } from "@/lib/watch-sync-data";

// Watch sync, Plex ⇄ Jellyfin (src/lib/watch-sync-data.ts): for every enabled
// admin-made pair, marks in each account what the other server counted as
// watched, per the pair's direction. Add-only; never unmarks. A no-op while the
// feature is off. Scheduled by docker-entrypoint.sh every WATCH_SYNC_INTERVAL.
export const POST = defineCronRoute({
  target: "watch-sync",
  lockId: WATCH_SYNC_LOCK_ID,
  // No run, no lock, no ledger row while the feature is off.
  skipReason: async () => ((await isFeatureEnabled(WATCH_SYNC_FEATURE_KEY)) ? null : "feature disabled"),
  async run({ signal, actor, elapsedMs }) {
    // Observes the lock's AbortSignal between servers, pairs and items, and
    // returns early on abort (guardrail 41).
    const result = await runWatchSync({ signal });
    const durationMs = elapsedMs();
    // The entrypoint runs this job quietly (no line for a 200), so a run that
    // stopped on its budget would otherwise leave no trace in the log. One
    // line per such run — an event, not a repeated condition (7b).
    if (result.aborted) {
      console.warn(`[watch-sync] run stopped at its time limit after ${Math.round(durationMs / 1000)}s; finished work is saved and the rest continues on the next run`);
    }
    const problems = watchSyncProblems(result);
    return {
      body: { ...result, durationMs, trigger: actor.trigger },
      problems,
      error: `${problems} watch sync pair(s) had problems`,
    };
  },
});
