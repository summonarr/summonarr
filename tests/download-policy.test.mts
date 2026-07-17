// Unit tests for isSafeToReconcileJellyfinUsers (src/lib/download-policy.ts) —
// the sole guard between a degraded Jellyfin /Users response and a mass
// soft-deactivation of every MediaServerUser absent from it. getJellyfinAllUsers
// only throws on a non-2xx, so a 200 carrying a truncated list (reduced API-key
// elevation, transient server quirk) reaches the reconcile looking legitimate;
// this predicate is what refuses it. A regression here re-creates the incident
// that motivated guardrail 28. Pure function — boundary-tested exhaustively.
import { test } from "node:test";
import assert from "node:assert/strict";
import { isSafeToReconcileJellyfinUsers, PRUNE_MAX_SHRINK } from "../src/lib/download-policy.ts";

test("an empty fetch is never safe — even with no prior active users", () => {
  assert.equal(isSafeToReconcileJellyfinUsers(0, 0), false);
  assert.equal(isSafeToReconcileJellyfinUsers(0, 10), false);
});

test("first sync (no prior active rows) is safe for any non-empty fetch", () => {
  assert.equal(isSafeToReconcileJellyfinUsers(1, 0), true);
  assert.equal(isSafeToReconcileJellyfinUsers(500, 0), true);
});

test("steady state and growth are safe", () => {
  assert.equal(isSafeToReconcileJellyfinUsers(10, 10), true);
  assert.equal(isSafeToReconcileJellyfinUsers(12, 10), true);
});

test("shrink tolerance boundary: exactly PRUNE_MAX_SHRINK departures pass, one more refuses", () => {
  const prior = 10;
  assert.equal(isSafeToReconcileJellyfinUsers(prior - PRUNE_MAX_SHRINK, prior), true);
  assert.equal(isSafeToReconcileJellyfinUsers(prior - PRUNE_MAX_SHRINK - 1, prior), false);
});

test("a truncated response (large shrink) refuses to reconcile", () => {
  assert.equal(isSafeToReconcileJellyfinUsers(3, 50), false);
  assert.equal(isSafeToReconcileJellyfinUsers(1, 4), false);
});

test("small servers: shrink-to-one passes only within tolerance", () => {
  // 3 active → 1 fetched is exactly PRUNE_MAX_SHRINK (2) departures: allowed.
  assert.equal(isSafeToReconcileJellyfinUsers(1, 3), true);
  // 4 active → 1 fetched exceeds it: refused.
  assert.equal(isSafeToReconcileJellyfinUsers(1, 4), false);
});
