// The library cleanup's rule and exclusion names — zero imports, so the
// browser-side table filter (library-cleanup-view.ts) reads the same lists as
// the rule engine (library-cleanup.ts re-exports them). Each list is checked
// against its union in both directions, so neither can gain a name alone.

export type CleanupRule = "unwatched" | "neverWatched" | "votes";

export type CleanupExclusion =
  | "recentlyAdded"
  | "activeRequest"
  | "recentlyFulfilled"
  | "watchlisted"
  | "playingNow"
  | "airing"
  | "protected"
  // A holding server's own watch records weren't checked (successfully and
  // recently), so a play Summonarr never saw can't be ruled out.
  | "upstreamUnchecked";

/** Every cleanup rule, in display order. */
export const CLEANUP_RULES = ["unwatched", "neverWatched", "votes"] as const satisfies readonly CleanupRule[];

/** Every exclusion that holds a matched title back, in display order. */
export const CLEANUP_EXCLUSIONS = [
  "recentlyAdded",
  "activeRequest",
  "recentlyFulfilled",
  "watchlisted",
  "playingNow",
  "airing",
  "protected",
  "upstreamUnchecked",
] as const satisfies readonly CleanupExclusion[];

// Compile-time: a union member missing from its list fails here.
type Missing<U, L extends readonly unknown[]> = Exclude<U, L[number]>;
const rulesComplete: [Missing<CleanupRule, typeof CLEANUP_RULES>] extends [never] ? true : false = true;
const exclusionsComplete: [Missing<CleanupExclusion, typeof CLEANUP_EXCLUSIONS>] extends [never] ? true : false = true;
void rulesComplete;
void exclusionsComplete;
