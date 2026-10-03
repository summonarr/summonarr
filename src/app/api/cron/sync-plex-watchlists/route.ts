import { NextRequest, NextResponse } from "next/server";
import { getCronActor, withCronRunRecording } from "@/lib/cron-auth";
import { withAdvisoryLock, PLEX_WATCHLIST_LOCK_ID } from "@/lib/advisory-lock";
import { syncPlexWatchlists, plexWatchlistRunProblems } from "@/lib/plex-watchlist";

// Watchlist auto-request, Plex half: read every opted-in, permitted user's
// plex.tv watchlist and file new titles as requests (src/lib/plex-watchlist.ts,
// src/lib/auto-request.ts). Users without their own token are read through the
// Plex server owner's token when plexWatchlistServerSource is on
// (src/lib/plex-friends-watchlist.ts). A no-op while
// feature.behavior.watchlistAutoRequest is off. Scheduled by
// docker-entrypoint.sh every PLEX_WATCHLIST_SYNC_INTERVAL.
export async function POST(request: NextRequest) {
  const authCtx = await getCronActor(request);
  if (!authCtx) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  return withCronRunRecording("plex-watchlist", () => withAdvisoryLock(
    PLEX_WATCHLIST_LOCK_ID,
    async (signal: AbortSignal) => {
      const startTime = Date.now();
      // Observes the lock's AbortSignal at every user and title boundary and
      // returns early on abort (guardrail 41).
      const result = await syncPlexWatchlists({ signal });
      const durationMs = Date.now() - startTime;

      // Status stays 200 on a partial failure (the entrypoint fast-retries any
      // non-2xx); X-Cron-Degraded is what marks the run failed in the ledger.
      // A rejected Plex admin token on the server-token path degrades the run
      // too — it never deletes anyone's own token (guardrail 34b).
      const problems = plexWatchlistRunProblems(result);
      const ok = problems === 0;
      return NextResponse.json(
        {
          ok,
          ...result,
          ...(ok ? {} : { error: `${problems} Plex watchlist source(s) could not be synced` }),
          durationMs,
          trigger: authCtx.trigger,
          timestamp: new Date().toISOString(),
        },
        ok ? undefined : { headers: { "X-Cron-Degraded": String(problems) } },
      );
    },
    () => NextResponse.json({ skipped: true, reason: "already running" }),
  ));
}
