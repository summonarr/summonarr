// The watch grade modal checks GET /api/admin/users/[id]/watch-grade
// (src/components/admin/watch-grade-schema.ts) before it renders the breakdown.
// The schema must take every shape the route sends (WatchGradeDetail, typed by
// `satisfies` below), so a valid grade never reads as a load failure.
import { test } from "node:test";
import assert from "node:assert/strict";
import { check } from "../src/lib/validate.ts";
import { WatchGradeDetailSchema } from "../src/components/admin/watch-grade-schema.ts";
import { WATCH_GRADE_DEFAULTS, emptyWatchGradeSummary, type WatchGradeDetail } from "../src/lib/watch-grade.ts";

const verdict = {
  requestId: "r1", tmdbId: 1, mediaType: "TV", title: "Show", releaseYear: null, posterPath: null,
  requestedAt: "2026-01-01T00:00:00.000Z", fulfilledAt: "2026-01-05T00:00:00.000Z", duplicates: 1,
  watch: "partial", otherViewers: 2, watchedByOthers: false, credit: 0.5, scoring: "scored", graceDaysLeft: null,
  episodes: { season: 1, watched: 3, started: 1, library: 10, required: 5 },
} as const;

test("the route's answers pass, unchanged", () => {
  const enabled = {
    enabled: true, reason: null,
    settings: { ...WATCH_GRADE_DEFAULTS, watchedThresholdPercent: 80 },
    grade: { ...emptyWatchGradeSummary("graded"), letter: "B", score: 64, graded: 5 },
    requests: [verdict, { ...verdict, requestId: "r2", mediaType: "MOVIE", watch: null, scoring: "untracked", episodes: null, otherViewers: null }],
    truncated: false,
  } satisfies WatchGradeDetail;
  const off = { enabled: false, reason: "feature-off", settings: null, grade: null, requests: [], truncated: false } satisfies WatchGradeDetail;
  for (const body of [enabled, off]) {
    const parsed = check(WatchGradeDetailSchema, body);
    assert.ok(parsed.ok, parsed.ok ? "" : parsed.error);
    assert.deepEqual(parsed.value, body);
  }
});

test("a body that isn't the breakdown is refused", () => {
  assert.equal(check(WatchGradeDetailSchema, { error: "x" }).ok, false);
  assert.equal(check(WatchGradeDetailSchema, { enabled: true, reason: null, settings: null, grade: null, requests: [{ ...verdict, watch: "maybe" }], truncated: false }).ok, false);
});
