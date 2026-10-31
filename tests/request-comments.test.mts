// Pure rules for request comment threads (src/lib/request-comments.ts) plus the
// inbox row's render and link routing. The route (auth, rate limit, fan-out) is
// pinned in tests/request-comments-route.test.mts.
import { test } from "node:test";
import assert from "node:assert/strict";

const rules = await import("../src/lib/request-comments.ts");
const { renderNotification } = await import("../src/lib/notification-render.ts");
const { notificationHref } = await import("../src/lib/notification-links.ts");
const { translatorFor } = await import("../src/lib/i18n/server-locale.ts");

const { canReadThread, canPostComment, commentAudience, parseCommentBody, COMMENT_MAX_CHARS } = rules;

test("a thread is readable by the requester and managers, nobody else", () => {
  assert.equal(canReadThread({ isManager: false, isRequester: true }), true);
  assert.equal(canReadThread({ isManager: true, isRequester: false }), true);
  assert.equal(canReadThread({ isManager: false, isRequester: false }), false);
});

test("a stranger can never post, whatever the request's state", () => {
  assert.deepEqual(canPostComment({ isManager: false, isRequester: false }, { permanentlyDeclined: false }), { ok: false, reason: "forbidden" });
  assert.deepEqual(canPostComment({ isManager: false, isRequester: false }, { permanentlyDeclined: true }), { ok: false, reason: "forbidden" });
});

test("a permanently declined request is closed to its requester but not to managers", () => {
  assert.deepEqual(canPostComment({ isManager: false, isRequester: true }, { permanentlyDeclined: true }), { ok: false, reason: "closed" });
  assert.deepEqual(canPostComment({ isManager: true, isRequester: false }, { permanentlyDeclined: true }), { ok: true });
  assert.deepEqual(canPostComment({ isManager: false, isRequester: true }, { permanentlyDeclined: false }), { ok: true });
});

test("audience: a manager's comment goes to the requester, the requester's to the managers", () => {
  assert.deepEqual(commentAudience({ authorIsManager: true, authorIsRequester: false }), { to: "requester" });
  assert.deepEqual(commentAudience({ authorIsManager: false, authorIsRequester: true }), { to: "managers" });
});

test("audience: a manager commenting on their OWN request tells the managers, never a self-notification to the requester", () => {
  // Manager AND requester: the requester is the author, so the managers hear it.
  assert.deepEqual(commentAudience({ authorIsManager: true, authorIsRequester: true }), { to: "managers" });
  assert.deepEqual(commentAudience({ authorIsManager: false, authorIsRequester: false }), { to: "none" });
});

test("parseCommentBody: non-strings are 'required', never a thrown .trim()", () => {
  for (const bad of [undefined, null, 5, {}, [], true]) {
    assert.deepEqual(parseCommentBody(bad), { ok: false, error: "required" });
  }
  assert.deepEqual(parseCommentBody("   \n "), { ok: false, error: "required" });
});

test("parseCommentBody: trims, and the cap is exactly COMMENT_MAX_CHARS", () => {
  assert.deepEqual(parseCommentBody("  hi  "), { ok: true, text: "hi" });
  assert.equal(COMMENT_MAX_CHARS, 2000, "matches the VarChar(2000) column");
  assert.deepEqual(parseCommentBody("x".repeat(COMMENT_MAX_CHARS)), { ok: true, text: "x".repeat(COMMENT_MAX_CHARS) });
  assert.deepEqual(parseCommentBody("x".repeat(COMMENT_MAX_CHARS + 1)), { ok: false, error: "too-long" });
});

test("a REQUEST_COMMENT inbox row renders in the reader's language from its data", () => {
  const row = { type: "REQUEST_COMMENT", title: "Dune", body: "stored", mediaType: "MOVIE" as const, data: { v: 1, author: "Sam", text: "Need 4K?" } };
  assert.equal(renderNotification(row, translatorFor("en")).body, "Sam commented: Need 4K?");
  assert.equal(renderNotification(row, translatorFor("de")).body, "Sam hat kommentiert: Need 4K?");
});

test("a REQUEST_COMMENT row with a malformed data shape keeps its stored text", () => {
  const row = { type: "REQUEST_COMMENT", title: "Dune", body: "stored text", mediaType: "MOVIE" as const, data: { v: 1, author: 5 } };
  assert.equal(renderNotification(row, translatorFor("en")).body, "stored text");
});

test("a REQUEST_COMMENT row links to /requests, not the title page", () => {
  assert.equal(notificationHref({ type: "REQUEST_COMMENT", tmdbId: 438631, mediaType: "MOVIE" }), "/requests");
  assert.equal(notificationHref({ type: "REQUEST_AVAILABLE", tmdbId: 438631, mediaType: "MOVIE" }), "/movie/438631");
});
