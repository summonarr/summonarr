// Unit tests for the two duration formatters (src/lib/format-duration.ts). They
// were unified from same-named local helpers with INCOMPATIBLE units (ms vs
// seconds); the distinct names + these pins keep them from re-merging. Pure.
import { test } from "node:test";
import assert from "node:assert/strict";
import { formatDurationMs, formatDurationSeconds } from "../src/lib/format-duration.ts";

test("formatDurationMs: sub-second in ms, above in one-decimal seconds", () => {
  assert.equal(formatDurationMs(0), "0ms");
  assert.equal(formatDurationMs(999), "999ms");
  assert.equal(formatDurationMs(1000), "1.0s");
  assert.equal(formatDurationMs(1500), "1.5s");
  assert.equal(formatDurationMs(65_000), "65.0s");
});

test("formatDurationSeconds: h/m above an hour, m under, em-dash for non-positive", () => {
  assert.equal(formatDurationSeconds(0), "—");
  assert.equal(formatDurationSeconds(-10), "—");
  assert.equal(formatDurationSeconds(59), "0m");
  assert.equal(formatDurationSeconds(60), "1m");
  assert.equal(formatDurationSeconds(3599), "59m");
  assert.equal(formatDurationSeconds(3600), "1h 0m");
  assert.equal(formatDurationSeconds(3660), "1h 1m");
  assert.equal(formatDurationSeconds(7325), "2h 2m");
});

test("the two formatters read the same number differently (units are not interchangeable)", () => {
  // 1500 is "1.5s" as ms, but "25m" as seconds — the exact confusion the split prevents.
  assert.equal(formatDurationMs(1500), "1.5s");
  assert.equal(formatDurationSeconds(1500), "25m");
});
