// Unit tests for the shared relative-time formatter (src/lib/relative-time.ts).
// Pins the unit boundaries ("just now" / m / h / d) so a refactor can't silently
// shift a threshold — these strings render on every activity/audit table.
import { test } from "node:test";
import assert from "node:assert/strict";
import { formatRelativeTime } from "../src/lib/relative-time.ts";

test("under a minute → \"just now\"", () => {
  const now = Date.now();
  assert.equal(formatRelativeTime(now), "just now");
  assert.equal(formatRelativeTime(now - 59_000), "just now");
});

test("minutes: 1m at 60s, caps at 59m", () => {
  const now = Date.now();
  assert.equal(formatRelativeTime(now - 60_000), "1m ago");
  assert.equal(formatRelativeTime(now - 5 * 60_000), "5m ago");
  assert.equal(formatRelativeTime(now - (59 * 60_000 + 59_000)), "59m ago");
});

test("hours: 1h at 60m, caps at 23h", () => {
  const now = Date.now();
  assert.equal(formatRelativeTime(now - 60 * 60_000), "1h ago");
  assert.equal(formatRelativeTime(now - (23 * 60 * 60_000 + 59 * 60_000)), "23h ago");
});

test("days from 24h up, unbounded", () => {
  const now = Date.now();
  assert.equal(formatRelativeTime(now - 24 * 60 * 60_000), "1d ago");
  assert.equal(formatRelativeTime(now - 400 * 24 * 60 * 60_000), "400d ago");
});

test("accepts Date, ISO string, and epoch number", () => {
  const fiveMinAgo = Date.now() - 5 * 60_000;
  assert.equal(formatRelativeTime(new Date(fiveMinAgo)), "5m ago");
  assert.equal(formatRelativeTime(new Date(fiveMinAgo).toISOString()), "5m ago");
  assert.equal(formatRelativeTime(fiveMinAgo), "5m ago");
});

test("future timestamps degrade to \"just now\" (never negative units)", () => {
  assert.equal(formatRelativeTime(Date.now() + 60 * 60_000), "just now");
});

// Pins CURRENT behavior, not an endorsement: an unparseable timestamp makes
// new Date(...).getTime() return NaN, NaN fails every `<` threshold check, and
// the function falls through to the days branch — rendering "NaNd ago" in the
// activity/audit tables. If a malformed upstream timestamp should render
// something friendlier (e.g. ""), change this test deliberately alongside src.
test("unparseable input currently falls through to \"NaNd ago\"", () => {
  assert.equal(formatRelativeTime("garbage"), "NaNd ago");
  assert.equal(formatRelativeTime(new Date(NaN)), "NaNd ago");
  assert.equal(formatRelativeTime(Number.NaN), "NaNd ago");
});
