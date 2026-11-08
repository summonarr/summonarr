// What a stored pending-search row must look like when a button reads it back.
// The row is this server's own write, but it sits in a table for minutes (and
// survives an upgrade that may change the shape), so a row that doesn't match is
// treated as expired rather than trusted.
import { VALID_ISSUE_TYPES } from "@/lib/issue-create";
import { v } from "@/lib/validate";

const TMDB_RESULT = v.object({
  id: v.int(),
  title: v.string(),
  mediaType: v.literal("movie", "tv"),
  releaseYear: v.string(),
  posterPath: v.nullable(v.string()),
  overview: v.string(),
  voteAverage: v.number(),
  plexAvailable: v.optional(v.boolean()),
  jellyfinAvailable: v.optional(v.boolean()),
  arrPending: v.optional(v.boolean()),
  requested: v.optional(v.boolean()),
});

export const PENDING_SEARCH = v.object({
  results: v.array(TMDB_RESULT),
  discordUserId: v.string(),
  discordUsername: v.optional(v.string()),
});

export const PENDING_WATCHLIST_ADD = v.object({ results: v.array(TMDB_RESULT) });

export const PENDING_ISSUE = v.object({
  results: v.array(TMDB_RESULT),
  issueType: v.literal(...VALID_ISSUE_TYPES),
  note: v.nullable(v.string()),
  season: v.nullable(v.int()),
  episode: v.nullable(v.int()),
});
