// greenlitPeerStatuses (src/lib/request-mirror.ts): which statuses of another
// user's request for the same title + instance a new request may copy.
import { test } from "node:test";
import assert from "node:assert/strict";
import { greenlitPeerStatuses } from "../src/lib/request-mirror.ts";

test("an APPROVED peer is always a greenlight", () => {
  assert.ok(greenlitPeerStatuses(false).includes("APPROVED"));
  assert.ok(greenlitPeerStatuses(true).includes("APPROVED"));
});

test("an AVAILABLE peer is a greenlight ONLY when the instance's *arr holds the title", () => {
  // Without the *arr row the peer was flipped AVAILABLE by a library pass (a
  // restricted server, or the HD copy of a 4K request) — nobody approved it.
  assert.deepEqual(greenlitPeerStatuses(false), ["APPROVED"]);
  assert.deepEqual(greenlitPeerStatuses(true), ["APPROVED", "AVAILABLE"]);
});
