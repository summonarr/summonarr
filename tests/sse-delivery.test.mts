// The /api/events delivery rules (src/lib/sse-delivery.ts): which frames a
// viewer is sent, keyed on permission BITS (never the role label), and what a
// frame carries (never another user's id). The stream itself is pinned through
// the route in tests/setup-events-openapi-routes.test.mts.
import { test } from "node:test";
import assert from "node:assert/strict";

const { sseClientFrame, sseDeliveryScope, shouldDeliverSseEvent } = await import("../src/lib/sse-delivery.ts");
const { Permission } = await import("../src/lib/permissions.ts");

const ME = "u-me";
const OTHER = "u-other";

test("server-wide activity frames reach system admins only, whoever they are about", () => {
  const admin = sseDeliveryScope(Permission.ADMIN);
  const issueAdmin = sseDeliveryScope(Permission.MANAGE_ISSUES);
  const user = sseDeliveryScope(0n);
  for (const type of ["activity:sessions", "activity:history-updated", "plex:reachability", "nav:badges"]) {
    assert.equal(shouldDeliverSseEvent(admin, ME, type, undefined), true, type);
    assert.equal(shouldDeliverSseEvent(issueAdmin, ME, type, undefined), false, type);
    // Not even when the frame names the viewer.
    assert.equal(shouldDeliverSseEvent(user, ME, type, ME), false, type);
  }
});

test("issue frames bypass the per-user filter for MANAGE_ISSUES, request frames for MANAGE_REQUESTS — and neither widens the other", () => {
  const issues = sseDeliveryScope(Permission.MANAGE_ISSUES);
  const requests = sseDeliveryScope(Permission.MANAGE_REQUESTS);
  assert.equal(shouldDeliverSseEvent(issues, ME, "issue:new", OTHER), true);
  assert.equal(shouldDeliverSseEvent(issues, ME, "issuemessage:created", OTHER), true);
  assert.equal(shouldDeliverSseEvent(issues, ME, "request:new", OTHER), false);
  assert.equal(shouldDeliverSseEvent(requests, ME, "request:updated", OTHER), true);
  assert.equal(shouldDeliverSseEvent(requests, ME, "issue:new", OTHER), false);
  // Everything else is per-user for both: only a system admin sees others'.
  assert.equal(shouldDeliverSseEvent(issues, ME, "votes:updated", OTHER), false);
  assert.equal(shouldDeliverSseEvent(requests, ME, "push:test", OTHER), false);
  assert.equal(shouldDeliverSseEvent(sseDeliveryScope(Permission.ADMIN), ME, "votes:updated", OTHER), true);
});

test("a plain user gets only frames about themselves", () => {
  const user = sseDeliveryScope(0n);
  assert.equal(shouldDeliverSseEvent(user, ME, "request:new", ME), true);
  assert.equal(shouldDeliverSseEvent(user, ME, "request:new", OTHER), false);
  assert.equal(shouldDeliverSseEvent(user, ME, "issue:updated", undefined), false);
});

test("a frame never carries the event's userId; an inbox event says `own` instead", () => {
  const mine = sseClientFrame({ type: "request:updated", requestId: "r1", status: "APPROVED", userId: ME }, ME);
  const theirs = sseClientFrame({ type: "request:updated", requestId: "r2", status: "APPROVED", userId: OTHER }, ME);
  assert.deepEqual(mine, { type: "request:updated", requestId: "r1", status: "APPROVED", own: true });
  assert.deepEqual(theirs, { type: "request:updated", requestId: "r2", status: "APPROVED", own: false });
  // Not an inbox event: stripped, nothing added.
  assert.deepEqual(sseClientFrame({ type: "request:new", requestId: "r3", userId: OTHER }, ME), { type: "request:new", requestId: "r3" });
});
