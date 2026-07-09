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
