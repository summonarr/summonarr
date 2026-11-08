import { defineCronRoute } from "@/lib/cron-route";
import { PLEX_WATCHLIST_LOCK_ID } from "@/lib/advisory-lock";
import { syncPlexWatchlists, plexWatchlistRunProblems } from "@/lib/plex-watchlist";

// Watchlist auto-request, Plex half: read every opted-in, permitted user's
// plex.tv watchlist and file new titles as requests (src/lib/plex-watchlist.ts,
// src/lib/auto-request.ts). Users without their own token are read through the
// Plex server owner's token when plexWatchlistServerSource is on
// (src/lib/plex-friends-watchlist.ts). A no-op while
// feature.behavior.watchlistAutoRequest is off. Scheduled by
// docker-entrypoint.sh every PLEX_WATCHLIST_SYNC_INTERVAL.
export const POST = defineCronRoute({
  target: "plex-watchlist",
  lockId: PLEX_WATCHLIST_LOCK_ID,
  async run({ signal, actor, elapsedMs }) {
    // Observes the lock's AbortSignal at every user and title boundary and
    // returns early on abort (guardrail 41).
    const result = await syncPlexWatchlists({ signal });
    // A rejected Plex admin token on the server-token path degrades the run
    // too — it never deletes anyone's own token (guardrail 34b) — as does a
    // user none of whose watchlist titles could be resolved because their
    // metadata lookups failed (counted in `errors`; `server.lookupFailures`
    // carries the raw count, partial failures included).
    const problems = plexWatchlistRunProblems(result);
    return {
      body: { ...result, durationMs: elapsedMs(), trigger: actor.trigger },
      problems,
      error: `${problems} Plex watchlist source(s) could not be synced`,
    };
  },
});
