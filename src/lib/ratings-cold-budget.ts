import { checkRateLimit } from "@/lib/rate-limit";

// What one signed-in user may make Summonarr fetch upstream for titles it has
// never cached ("cold" titles). Every cold title is an MDBList batch slot and,
// when MDBList can't rate it, a TMDB + OMDb chain; OMDb's free tier is 1,000 a
// day and MDBList's daily limit is per account, both shared by the whole site
// (guardrail 31b).
//
// ONE budget per user, whichever surface spends it: the ratings batch route,
// GET /api/ratings, a person's filmography and every list a page renders for
// that user (attachAllAvailability). Separate budgets per surface would just
// multiply what one account can spend. Past the budget a cold title is served
// from the cache only (no rating yet) until the hour rolls on. Warm and stale
// titles are never limited, and callers with no user (crons, warm jobs) never
// come through here.
//
// The key keeps the batch route's original prefix so a deploy doesn't hand
// everyone a second budget. It is deliberately NOT a protected prefix
// (guardrail 6e): losing a bucket to eviction costs a few upstream calls, not
// an account.
export const COLD_LOOKUP_BUDGET = 600;
export const COLD_LOOKUP_WINDOW_MS = 60 * 60 * 1000;

// OMDb chains awaited inside a user's request; the rest of a call's misses are
// warmed after the response.
export const USER_MAX_BLOCKING_MISSES = 40;

function coldLookupKey(userId: string): string {
  return `ratings-batch-cold:${userId}`;
}

// Spends one cold lookup from the user's budget; false once it is spent.
export function admitColdLookup(userId: string): boolean {
  return checkRateLimit(coldLookupKey(userId), COLD_LOOKUP_BUDGET, COLD_LOOKUP_WINDOW_MS);
}

// The `admitMiss` / `admitCold` callback for one user.
export function coldLookupAdmitter(userId: string): () => boolean {
  return () => admitColdLookup(userId);
}
