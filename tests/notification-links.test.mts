// Unit tests for the shared notification link/time helpers
// (src/lib/notification-links.ts). Pure leaf — single source of the routing rules
// used by both the header bell and the /notifications list.
import { test } from "node:test";
import assert from "node:assert/strict";
import { notificationHref, timeAgo } from "../src/lib/notification-links.ts";

test("ISSUE_* notifications route to /issues regardless of media fields", () => {
  assert.equal(notificationHref({ type: "ISSUE_REPLY", tmdbId: 27205, mediaType: "MOVIE" }), "/issues");
  assert.equal(notificationHref({ type: "ISSUE_RESOLVED", tmdbId: null, mediaType: null }), "/issues");
});

test("media-typed request notifications route to the title page", () => {
  assert.equal(notificationHref({ type: "REQUEST_APPROVED", tmdbId: 27205, mediaType: "MOVIE" }), "/movie/27205");
  assert.equal(notificationHref({ type: "REQUEST_AVAILABLE", tmdbId: 1399, mediaType: "TV" }), "/tv/1399");
});

test("notifications lacking a resolvable title fall back to /requests", () => {
  assert.equal(notificationHref({ type: "REQUEST_DECLINED", tmdbId: null, mediaType: "MOVIE" }), "/requests");
  assert.equal(notificationHref({ type: "REQUEST_APPROVED", tmdbId: 27205, mediaType: null }), "/requests");
});

test("timeAgo buckets against an injected now", () => {
  const now = Date.parse("2026-07-08T12:00:00Z");
  const at = (ms: number) => new Date(now - ms).toISOString();
  assert.equal(timeAgo(at(10 * 1000), now), "just now");
  assert.equal(timeAgo(at(5 * 60 * 1000), now), "5m ago");
  assert.equal(timeAgo(at(3 * 60 * 60 * 1000), now), "3h ago");
  assert.equal(timeAgo(at(2 * 24 * 60 * 60 * 1000), now), "2d ago");
});

test("timeAgo clamps a future timestamp to 'just now' rather than going negative", () => {
  const now = Date.parse("2026-07-08T12:00:00Z");
  assert.equal(timeAgo(new Date(now + 60_000).toISOString(), now), "just now");
});

// Exact bucket boundaries. The comparisons are strict (`s < 60`, `m < 60`,
// `h < 24`), so exactly 60s/3600s/86400s must roll OVER into the next unit —
// an accidental `<=` would silently widen each bucket by one step.
test("timeAgo bucket boundaries roll over at exactly 60s / 3600s / 86400s", () => {
  const now = Date.parse("2026-07-08T12:00:00Z");
  const at = (ms: number) => new Date(now - ms).toISOString();
  // one below each boundary stays in the smaller unit
  assert.equal(timeAgo(at(59 * 1000), now), "just now");
  assert.equal(timeAgo(at(3599 * 1000), now), "59m ago");
  assert.equal(timeAgo(at(86399 * 1000), now), "23h ago");
  // exactly at each boundary flips to the larger unit
  assert.equal(timeAgo(at(60 * 1000), now), "1m ago");
  assert.equal(timeAgo(at(3600 * 1000), now), "1h ago");
  assert.equal(timeAgo(at(86400 * 1000), now), "1d ago");
});

// tmdbId is checked for truthiness (`n.tmdbId &&`), so 0 — a value the type
// permits — is treated as "no resolvable title" and falls back to /requests.
// A refactor to `n.tmdbId !== null` would start routing to /movie/0.
test("notificationHref treats tmdbId 0 as unresolvable and falls back to /requests", () => {
  assert.equal(notificationHref({ type: "REQUEST_APPROVED", tmdbId: 0, mediaType: "MOVIE" }), "/requests");
  assert.equal(notificationHref({ type: "REQUEST_AVAILABLE", tmdbId: 0, mediaType: "TV" }), "/requests");
});

// Pins current behavior: an unparseable ISO string produces NaN, which fails
// every `<` bucket comparison and falls through to the day formatter as
// "NaNd ago". Not a crash, but callers get a garbage label — documented here
// so a change to this behavior is a deliberate one.
test("timeAgo on an unparseable timestamp currently yields 'NaNd ago'", () => {
  const now = Date.parse("2026-07-08T12:00:00Z");
  assert.equal(timeAgo("not-a-date", now), "NaNd ago");
});
