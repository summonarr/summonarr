import { defineCronRoute } from "@/lib/cron-route";
import { TRAKT_SYNC_LOCK_ID } from "@/lib/advisory-lock";
import { syncTraktUsers, traktRunProblems } from "@/lib/trakt-user";

// Per-user Trakt (src/lib/trakt-user.ts, guardrail 34c): for every connected
// user, file new titles on their Trakt watchlist as requests (watchlist
// auto-request) and import their Trakt watch history for the For You seeds. A
// no-op until the admin saves both Trakt app credentials and turns on watchlist
// auto-request or For You. Scheduled by docker-entrypoint.sh every
// TRAKT_SYNC_INTERVAL.
export const POST = defineCronRoute({
  target: "trakt",
  lockId: TRAKT_SYNC_LOCK_ID,
  async run({ signal, actor, elapsedMs }) {
    // Observes the lock's AbortSignal at every user and title boundary and
    // returns early on abort (guardrail 41).
    const result = await syncTraktUsers({ signal });
    // A revoked grant is the user's doing, not a run failure, so it does not degrade.
    const problems = traktRunProblems(result);
    return {
      body: { ...result, durationMs: elapsedMs(), trigger: actor.trigger },
      problems,
      error: `${problems} Trakt user sync(s) failed`,
    };
  },
});
