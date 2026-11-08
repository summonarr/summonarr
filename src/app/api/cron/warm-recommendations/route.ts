import { warmRecommendationsCache } from "@/lib/recommendations";
import { WARM_RECOMMENDATIONS_LOCK_ID } from "@/lib/advisory-lock";
import { defineCronRoute } from "@/lib/cron-route";

export const POST = defineCronRoute({
  target: "recommendations",
  lockId: WARM_RECOMMENDATIONS_LOCK_ID,
  cacheWarm: true,
  async run({ signal }) {
    const result = await warmRecommendationsCache({ signal });
    // A failed graph refresh also counts as a failure: when it fails, no user
    // is recomputed at all (there is no live fallback, guardrail 40), so the
    // run must not look like a clean run where nobody happened to change.
    return {
      body: { ...result },
      problems: result.usersFailed + (result.graphFailed ? 1 : 0),
      error: result.graphFailed
        ? "the recommendation graph refresh failed — no user was recomputed and every shelf was left as-is"
        : `${result.usersFailed} user(s) failed to warm`,
    };
  },
});
