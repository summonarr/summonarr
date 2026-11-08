// planPlexContinuation (src/lib/session-poll-plex.ts): what the poller does with
// a Plex session that already has a row (guardrail 20). The route suite drives
// the same rules end to end; these pin each rule alone.
import { test } from "node:test";
import assert from "node:assert/strict";

process.env.TOKEN_ENCRYPTION_KEY ??= "ab".repeat(32);
process.env.DATABASE_URL ??= "postgresql://unit:unit@127.0.0.1:9/never_connects";

const { planPlexContinuation, plexSessionAddress } = await import("../src/lib/session-poll-plex.ts");
const { PLEX_STALL_THRESHOLD_MS } = await import("../src/lib/plex-events.ts");

const NOW = 1_800_000_000_000;
const row = (over: Partial<{ sourceItemId: string | null; progressMs: bigint; state: string; progressUpdatedAt: Date }> = {}) => ({
  sourceItemId: "rk-1",
  progressMs: 100_000n,
  state: "playing",
  progressUpdatedAt: new Date(NOW - PLEX_STALL_THRESHOLD_MS - 1),
  ...over,
});
const snap = (viewOffset: number, over: Partial<{ ratingKey: string; state: "playing" | "paused" | "buffering" }> = {}) =>
  ({ ratingKey: "rk-1", viewOffset, state: "playing" as const, ...over });

test("another ratingKey under the same sessionKey is the next item", () => {
  assert.deepEqual(planPlexContinuation(row(), snap(100_000, { ratingKey: "rk-2" }), NOW), { kind: "item-changed" });
});

test("a frozen playhead past the threshold while playing is a stall; inside it, an update without an anchor refresh", () => {
  assert.deepEqual(planPlexContinuation(row(), snap(100_000), NOW), { kind: "stalled" });
  const fresh = row({ progressUpdatedAt: new Date(NOW - 1_000) });
  assert.deepEqual(planPlexContinuation(fresh, snap(100_000), NOW), { kind: "update", nextProgressMs: 100_000, refreshAnchor: false });
});

test("movement either way refreshes the anchor; a sub-tolerance backstep is clamped and is NOT movement", () => {
  assert.deepEqual(planPlexContinuation(row(), snap(110_000), NOW), { kind: "update", nextProgressMs: 110_000, refreshAnchor: true });
  assert.deepEqual(planPlexContinuation(row(), snap(20_000), NOW), { kind: "update", nextProgressMs: 20_000, refreshAnchor: true }, "a real seek-back");
  assert.deepEqual(planPlexContinuation(row(), snap(95_000), NOW), { kind: "stalled" }, "a clamped jitter step leaves the anchor old");
});

test("a resume from pause skips the stall check and refreshes the anchor", () => {
  assert.deepEqual(planPlexContinuation(row({ state: "paused" }), snap(100_000), NOW), { kind: "update", nextProgressMs: 100_000, refreshAnchor: true });
});

test("the recorded address prefers the server-observed public one off-LAN, never a relay's loopback", () => {
  assert.equal(plexSessionAddress({ location: "wan", remotePublicAddress: "203.0.113.5", address: "192.168.1.2" }), "203.0.113.5");
  assert.equal(plexSessionAddress({ location: "relay", remotePublicAddress: "127.0.0.1", address: "192.168.1.2" }), "192.168.1.2");
  assert.equal(plexSessionAddress({ location: "lan", remotePublicAddress: "203.0.113.5", address: "192.168.1.2" }), "192.168.1.2");
  assert.equal(plexSessionAddress({ location: "wan" }), null);
});
