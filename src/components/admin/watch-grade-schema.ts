// The client's check of GET /api/admin/users/[id]/watch-grade (WatchGradeDetail,
// src/lib/watch-grade.ts) before it drives the breakdown modal. Kept apart
// from the .tsx so the unit suite can hold it against the wire type
// (tests/watch-grade-schema.test.mts).
import { v } from "@/lib/validate";

// A proxy page or a changed shape is a load failure, not a crash in the
// middle of the breakdown.
const LetterSchema = v.literal("A", "B", "C", "D", "F");
const SummarySchema = v.object({
  status: v.literal("graded", "insufficient", "unlinked", "untracked"),
  letter: v.nullable(LetterSchema),
  minGradedRequests: v.number(),
  score: v.nullable(v.number()),
  graded: v.number(),
  watched: v.number(),
  byOthers: v.number(),
  partial: v.number(),
  unwatched: v.number(),
  inGrace: v.number(),
  untracked: v.number(),
});
const SettingsSchema = v.object({
  graceDays: v.number(),
  windowDays: v.number(),
  tvEpisodePercent: v.number(),
  otherViewers: v.number(),
  bandA: v.number(),
  bandB: v.number(),
  bandC: v.number(),
  bandD: v.number(),
  minGradedRequests: v.number(),
  watchedThresholdPercent: v.number(),
});
const VerdictSchema = v.object({
  requestId: v.string(),
  tmdbId: v.number(),
  mediaType: v.literal("MOVIE", "TV"),
  title: v.string(),
  releaseYear: v.nullable(v.string()),
  posterPath: v.nullable(v.string()),
  requestedAt: v.string(),
  fulfilledAt: v.string(),
  duplicates: v.number(),
  watch: v.nullable(v.literal("watched", "partial", "unwatched")),
  otherViewers: v.nullable(v.number()),
  watchedByOthers: v.boolean(),
  credit: v.number(),
  scoring: v.literal("scored", "grace", "untracked"),
  graceDaysLeft: v.nullable(v.number()),
  episodes: v.nullable(v.object({
    season: v.nullable(v.number()),
    watched: v.number(),
    started: v.number(),
    library: v.number(),
    required: v.number(),
  })),
});
export const WatchGradeDetailSchema = v.object({
  enabled: v.boolean(),
  reason: v.nullable(v.literal("feature-off", "tracking-off")),
  settings: v.nullable(SettingsSchema),
  grade: v.nullable(SummarySchema),
  requests: v.array(VerdictSchema),
  truncated: v.boolean(),
});

