import { NextRequest, NextResponse } from "next/server";
import { cronSkippedResponse, getCronActor, withCronRunRecording } from "@/lib/cron-auth";
import { withAdvisoryLock, UPSTREAM_WATCH_LOCK_ID } from "@/lib/advisory-lock";
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
export async function POST(request: NextRequest) {
  const authCtx = await getCronActor(request);
  if (!authCtx) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const [neverWatched, cleanup] = await Promise.all([
    isFeatureEnabled(NEVER_WATCHED_FEATURE_KEY),
    isFeatureEnabled(CLEANUP_FEATURE_KEY),
  ]);
  // Nothing reads the snapshot: no run, no lock, no upstream traffic — and no
  // ledger row (X-Cron-Skipped), since no run happened.
  if (!neverWatched && !cleanup) return cronSkippedResponse("feature disabled");

  return withCronRunRecording("upstream-watch", () => withAdvisoryLock(
    UPSTREAM_WATCH_LOCK_ID,
    async (signal: AbortSignal) => {
      const startTime = Date.now();
      // Observes the lock's AbortSignal between servers, between Jellyfin users
      // and while paging, and returns early on abort (guardrail 41).
      const result = await refreshUpstreamWatch({ signal });
      // New evidence changes verdicts; the cached report must not outlive it.
      invalidateNeverWatchedReport();
      const durationMs = Date.now() - startTime;

      // 200 on a partial failure (the entrypoint fast-retries any non-2xx);
      // X-Cron-Degraded is what marks the run failed in the ledger. A failed
      // server keeps its previous snapshot.
      const problems = upstreamRefreshProblems(result);
      const ok = problems === 0;
      return NextResponse.json(
        {
          ok,
          ...result,
          ...(ok ? {} : { error: `${problems} media server(s) could not be checked` }),
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
