// Unit tests for the shared notification link helper
// (src/lib/notification-links.ts). Pure leaf — single source of the routing rules
// used by both the header bell and the /notifications list.
import { test } from "node:test";
import assert from "node:assert/strict";
import { notificationHref } from "../src/lib/notification-links.ts";

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

// tmdbId is checked for truthiness (`n.tmdbId &&`), so 0 — a value the type
// permits — is treated as "no resolvable title" and falls back to /requests.
// A refactor to `n.tmdbId !== null` would start routing to /movie/0.
test("notificationHref treats tmdbId 0 as unresolvable and falls back to /requests", () => {
  assert.equal(notificationHref({ type: "REQUEST_APPROVED", tmdbId: 0, mediaType: "MOVIE" }), "/requests");
  assert.equal(notificationHref({ type: "REQUEST_AVAILABLE", tmdbId: 0, mediaType: "TV" }), "/requests");
});
