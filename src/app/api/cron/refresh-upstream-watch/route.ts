import { defineCronRoute } from "@/lib/cron-route";
import { UPSTREAM_WATCH_LOCK_ID } from "@/lib/advisory-lock";
import { isFeatureEnabled } from "@/lib/features";
import { NEVER_WATCHED_FEATURE_KEY } from "@/lib/never-watched-data";
import { CLEANUP_FEATURE_KEY } from "@/lib/library-cleanup-data";
import { refreshUpstreamWatch, upstreamRefreshProblems } from "@/lib/upstream-watch-data";
import { invalidateNeverWatchedReport } from "@/lib/never-watched-report";

// The media servers' own watch records (src/lib/upstream-watch-data.ts): reads
// Plex's all-account history and each Jellyfin user's played/resumable items and
// replaces every configured server's UpstreamWatchEvidence snapshot — READ-ONLY
// evidence the never-watched report and the cleanup rules use to avoid calling a
// watched title "never watched". A no-op while both of those features are off.
// Scheduled by docker-entrypoint.sh every UPSTREAM_WATCH_SYNC_INTERVAL.
export const POST = defineCronRoute({
  target: "upstream-watch",
  lockId: UPSTREAM_WATCH_LOCK_ID,
  // Nothing reads the snapshot: no run, no lock, no upstream traffic — and no
  // ledger row, since no run happened.
  skipReason: async () => {
    const [neverWatched, cleanup] = await Promise.all([
      isFeatureEnabled(NEVER_WATCHED_FEATURE_KEY),
      isFeatureEnabled(CLEANUP_FEATURE_KEY),
    ]);
    return !neverWatched && !cleanup ? "feature disabled" : null;
  },
  async run({ signal, actor, elapsedMs }) {
    // Observes the lock's AbortSignal between servers, between Jellyfin users
    // and while paging, and returns early on abort (guardrail 41).
    const result = await refreshUpstreamWatch({ signal });
    // New evidence changes verdicts; the cached report must not outlive it.
    invalidateNeverWatchedReport();
    // A failed server keeps its previous snapshot.
    const problems = upstreamRefreshProblems(result);
    return {
      body: { ...result, durationMs: elapsedMs(), trigger: actor.trigger },
      problems,
      error: `${problems} media server(s) could not be checked`,
    };
  },
});
