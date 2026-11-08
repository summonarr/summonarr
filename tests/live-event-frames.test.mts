// parseLiveEvent (src/lib/live-event-frames.ts): every /api/events frame is
// checked before a subscriber sees it. A known frame passes with only its
// declared fields; an unknown type, a renamed field, a non-array session list
// or the client-only "disconnected" are dropped, never dispatched.
import { test } from "node:test";
import assert from "node:assert/strict";

const { parseLiveEvent } = await import("../src/lib/live-event-frames.ts");

test("known frames pass, with the fields consumers read", () => {
  assert.deepEqual(parseLiveEvent('{"type":"connected"}'), { type: "connected" });
  assert.deepEqual(
    parseLiveEvent('{"type":"request:updated","requestId":"r1","status":"APPROVED","own":true,"extra":1}'),
    { type: "request:updated", requestId: "r1", status: "APPROVED", own: true },
  );
  assert.deepEqual(
    parseLiveEvent('{"type":"plex:reachability","reachable":false,"instance":""}'),
    { type: "plex:reachability", reachable: false, instance: "" },
  );
  const sessions = parseLiveEvent('{"type":"activity:sessions","sessions":[{"id":"s1","title":"Film"}]}');
  assert.deepEqual(sessions, { type: "activity:sessions", sessions: [{ id: "s1", title: "Film" }] });
});

test("malformed or unknown frames are dropped", () => {
  assert.equal(parseLiveEvent("not json"), null);
  assert.equal(parseLiveEvent("null"), null);
  assert.equal(parseLiveEvent('{"type":"request:frobnicated","requestId":"r1"}'), null, "unknown type");
  assert.equal(parseLiveEvent('{"type":"request:new","reqId":"r1"}'), null, "renamed field");
  assert.equal(parseLiveEvent('{"type":"issue:updated","issueId":"i1","status":3}'), null, "wrong field type");
  assert.equal(parseLiveEvent('{"type":"activity:sessions","sessions":{}}'), null, "sessions not a list");
  assert.equal(parseLiveEvent('{"type":"disconnected"}'), null, "client-only, never from the server");
  assert.equal(parseLiveEvent('{"type":"toString"}'), null, "an inherited key is not a frame type");
});

test("a new issue message's frame keeps the message id it names, and a frame without one still passes", () => {
  assert.deepEqual(
    parseLiveEvent('{"type":"issuemessage:created","issueId":"i1","messageId":"m1","own":false}'),
    { type: "issuemessage:created", issueId: "i1", messageId: "m1", own: false },
  );
  assert.deepEqual(parseLiveEvent('{"type":"issuemessage:created","issueId":"i1"}'), { type: "issuemessage:created", issueId: "i1" });
});
