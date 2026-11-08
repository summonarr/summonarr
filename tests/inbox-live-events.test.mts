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

test("a frame about ANOTHER user (a manager's bypass delivers everyone's) does not reload the inbox; the viewer's own does", () => {
  // Admins and request/issue managers receive every request:* / issue:* frame,
  // but an inbox row is only ever written for the event's own user.
  for (const event of [
    { type: "request:updated" as const, requestId: "r1", status: "APPROVED" },
    { type: "request:comment" as const, requestId: "r1" },
    { type: "issue:updated" as const, issueId: "i1", status: "RESOLVED" },
    { type: "issuemessage:created" as const, issueId: "i1" },
  ]) {
    assert.equal(reloadsInbox({ ...event, own: false }), false, `${event.type} own:false`);
    assert.equal(reloadsInbox({ ...event, own: true }), true, `${event.type} own:true`);
  }
});

test("the events route marks exactly the inbox event types `own`, from the same list", () => {
  // The frame is built by sseClientFrame (src/lib/sse-delivery.ts), which the
  // route sends every delivered event through.
  const route = readFileSync(new URL("../src/app/api/events/route.ts", import.meta.url), "utf-8");
  assert.match(route, /from "@\/lib\/sse-delivery"/);
  assert.match(route, /const frame = sseClientFrame\(event as SSEEvent & \{ userId\?: string \}, userId\);/);
  const delivery = readFileSync(new URL("../src/lib/sse-delivery.ts", import.meta.url), "utf-8");
  assert.match(delivery, /from "\.\/inbox-live-event-types"/);
  assert.match(delivery, /isInboxLiveEventType\(event\.type\) \? \{ \.\.\.clientEvent, own: evtUserId === viewerId \}/);
  const client = readFileSync(new URL("../src/components/notifications/inbox-live-events.ts", import.meta.url), "utf-8");
  assert.match(client, /from "@\/lib\/inbox-live-event-types"/, "the client list and the route's must be one list");
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
