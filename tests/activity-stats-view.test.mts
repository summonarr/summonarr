// The Statistics tab's header percentages and weekday / hour buckets. The
// stream-method shares divide by every session the bars draw — the "Other"
// segment included — and the hour caption names a peak only when there is one.
import { test } from "node:test";
import assert from "node:assert/strict";
import { foldStreamMethods } from "../src/lib/activity-stream-mix.ts";
import {
  hourCounts,
  peakBucket,
  sharePct,
  streamShares,
  weekdayCounts,
} from "../src/lib/activity-stats-view.ts";
import { OTHER_REASONS, UNKNOWN_REASON } from "../src/lib/transcode-reasons.ts";

test("direct play and transcode shares divide by the all-sessions total, Other included", () => {
  const mix = foldStreamMethods([
    { method: "DirectPlay", count: 20 },
    { method: "Transcode", count: 10 },
    { method: "Unknown", count: 70 },
  ]);
  const shares = streamShares(mix, [
    { reason: "Video codec not supported", count: 6 },
    { reason: OTHER_REASONS, count: 4 },
  ]);
  assert.equal(shares.directPct, 20, "20 of 100 sessions, not 20 of the 30 with a named method");
  assert.equal(shares.transcodePct, 10);
  assert.equal(shares.transcodeTotal, 10, "the reason list's rolled-up tail counts toward the total");
});

test("the top reason skips the Other reasons bundle, and its share is of the transcodes", () => {
  const mix = foldStreamMethods([{ method: "Transcode", count: 10 }]);
  const shares = streamShares(mix, [
    { reason: OTHER_REASONS, count: 7 },
    { reason: UNKNOWN_REASON, count: 3 },
  ]);
  assert.deepEqual(shares.topReason, { reason: UNKNOWN_REASON, count: 3 });
  assert.equal(shares.topReasonPct, 30);
  assert.equal(streamShares(mix, [{ reason: OTHER_REASONS, count: 10 }]).topReason, undefined);
});

test("no sessions reads 0%, never NaN", () => {
  const shares = streamShares(foldStreamMethods([]), []);
  assert.equal(shares.directPct, 0);
  assert.equal(shares.transcodePct, 0);
  assert.equal(shares.topReasonPct, 0);
  assert.equal(sharePct(5, 0), 0);
});

test("weekdays run Monday first from Postgres's Sunday-zero numbering", () => {
  assert.deepEqual(
    weekdayCounts([{ dow: 0, count: 7 }, { dow: 1, count: 1 }, { dow: 6, count: 6 }]),
    [1, 0, 0, 0, 0, 6, 7],
  );
});

test("hours fill 0..23 and the peak is named only when some hour has a play", () => {
  const hours = hourCounts([{ hour: 3, count: 2 }, { hour: 20, count: 5 }]);
  assert.equal(hours.length, 24);
  assert.equal(hours[20], 5);
  assert.deepEqual(peakBucket(hours), { index: 20, count: 5 });
  assert.equal(peakBucket(hourCounts([])), null, "an empty window has no peak hour — not 0:00");
});
