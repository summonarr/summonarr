// The shared notification store (bell + mobile badge) re-fetches the inbox on
// the live events the server sends beside a new in-app notification row. A
// manager's request comment writes a REQUEST_COMMENT row for the requester and
// the comment route emits only `request:comment`, so that event must be in the
// list or the badge lags until the 60s poll.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const { reloadsInbox } = await import("../src/components/notifications/inbox-live-events.ts");

test("request:comment reloads the inbox, beside the other inbox-row events", () => {
  assert.equal(reloadsInbox({ type: "request:comment", requestId: "r1" }), true);
  assert.equal(reloadsInbox({ type: "request:updated", requestId: "r1", status: "APPROVED" }), true);
  assert.equal(reloadsInbox({ type: "issue:updated", issueId: "i1", status: "RESOLVED" }), true);
  assert.equal(reloadsInbox({ type: "issuemessage:created", issueId: "i1" }), true);
});

test("events that write no inbox row for the viewer do not reload it", () => {
  assert.equal(reloadsInbox({ type: "connected" }), false);
  assert.equal(reloadsInbox({ type: "request:new", requestId: "r1" }), false);
  assert.equal(reloadsInbox({ type: "activity:history-updated" }), false);
  assert.equal(reloadsInbox({ type: "activity:sessions", sessions: [] }), false);
});

test("the store decides through reloadsInbox, not an inline list that can drift", () => {
  const src = readFileSync(new URL("../src/components/notifications/notification-store.tsx", import.meta.url), "utf-8");
  assert.match(src, /useLiveEvents\(\(event\) => \{\s*if \(reloadsInbox\(event\)\)/);
  assert.doesNotMatch(src, /event\.type === "/, "the store filters event types inline again");
});

test("the comment route still announces a comment with request:comment (the event the store listens for)", () => {
  const src = readFileSync(new URL("../src/app/api/requests/[id]/comments/route.ts", import.meta.url), "utf-8");
  assert.match(src, /emitSSE\(\{ type: "request:comment"/);
});
