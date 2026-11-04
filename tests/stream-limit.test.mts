// Concurrent-stream alert: the pure transition rules (src/lib/stream-limit.ts)
// and one evaluation over stubbed ActiveSession rows (stream-limit-data.ts).
process.env.TOKEN_ENCRYPTION_KEY = "ab".repeat(32);
process.env.NEXTAUTH_SECRET = "stream-limit-test-secret-0123456789abcdef";
process.env.TRUST_PROXY = "true";

import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";

const m = await import("../src/lib/stream-limit.ts");
const { countStreamsByOwner, evaluateStreams, parseStreamLimit, streamAlertText, STREAM_ALERT_COOLDOWN_MS } = m;

const NOW = new Date("2026-10-31T12:00:00Z");
// The poll tick began a few seconds before the evaluation; every session a
// server reported this tick was stamped at or after it. HOLD is the start of the
// hold window: the absence grace (60s) back from the tick's start.
const TICK = new Date(NOW.getTime() - 3_000);
const GRACE_MS = 60_000;
const HOLD = new Date(TICK.getTime() - GRACE_MS);
const sess = (id: string, over: Record<string, unknown> = {}) => ({
  id, mediaServerUserId: `msu-${id}`, userId: null as string | null, username: "kid", isServerAdmin: false,
  lastSeenAt: NOW, title: `Title ${id}`, seasonNumber: null, episodeNumber: null, ...over,
});
const empty = () => ({ over: new Set<string>(), alertedAt: new Map<string, number>() });

test("parseStreamLimit: whole numbers 1..50 only; blank, 0, junk, out-of-range are OFF", () => {
  assert.equal(parseStreamLimit("3"), 3);
  assert.equal(parseStreamLimit(" 50 "), 50);
  for (const off of [undefined, null, "", "0", "-1", "51", "abc", "2.5", "1e1"]) assert.equal(parseStreamLimit(off as string), 0, String(off));
});

test("a person is ONE owner across Plex and Jellyfin when both identities are linked to one account", () => {
  const counts = countStreamsByOwner([
    sess("1", { userId: "alice", mediaServerUserId: "plex-alice" }),
    sess("2", { userId: "alice", mediaServerUserId: "jf-alice" }),
    sess("3", { mediaServerUserId: "plex-bob" }),
  ], TICK, HOLD);
  assert.equal(counts.get("u:alice")?.count, 2);
  assert.equal(counts.get("m:plex-bob")?.count, 1);
});

test("server-admin accounts never count; a session not seen this tick only HOLDS, and one older than the hold window is gone", () => {
  const counts = countStreamsByOwner([
    sess("1", { isServerAdmin: true }),
    sess("2", { isServerAdmin: true, mediaServerUserId: "msu-1" }),
    sess("3", { mediaServerUserId: "x", lastSeenAt: new Date(TICK.getTime() - 1) }),
    sess("4", { mediaServerUserId: "y", lastSeenAt: new Date(HOLD.getTime() - 1) }),
  ], TICK, HOLD);
  assert.deepEqual([...counts.keys()], ["m:x"]);
  assert.equal(counts.get("m:x")?.count, 0, "not seen this tick: never a stream that can put anyone over");
  assert.equal(counts.get("m:x")?.heldCount, 1, "but inside the hold window");
});

test("the hold window in the evaluation is the play-history absence grace", async () => {
  const { SESSION_ABSENCE_GRACE_MS } = await import("../src/lib/play-history.ts");
  assert.equal(GRACE_MS, SESSION_ABSENCE_GRACE_MS, "the fixtures here model the real grace");
});

test("device switch: the old row, stamped BEFORE this tick (1s, deep inside its absence grace), does not count — no alert", () => {
  // Stopped on the TV moments ago: its row lingers for the 60s absence grace but
  // no server reported it this tick, so it was not re-stamped. Now on the phone.
  // One person, one stream — however short the switch.
  const counts = countStreamsByOwner([
    sess("tv", { mediaServerUserId: "same", lastSeenAt: new Date(TICK.getTime() - 1_000) }),
    sess("phone", { mediaServerUserId: "same", lastSeenAt: new Date(TICK.getTime() + 200) }),
  ], TICK, HOLD);
  assert.equal(counts.get("m:same")?.count, 1);
  assert.equal(counts.get("m:same")?.heldCount, 2, "the TV row is still held — which must never be what ENTERS the over state");
  assert.equal(evaluateStreams(counts, 1, empty(), NOW.getTime()).alert.length, 0, "limit 1: no false accusation");
  // Two sessions both reported this tick are two streams; a stamp exactly at the
  // tick's start is this tick's.
  const live = countStreamsByOwner([
    sess("a", { mediaServerUserId: "two", lastSeenAt: TICK }),
    sess("b", { mediaServerUserId: "two", lastSeenAt: new Date(TICK.getTime() + 200) }),
  ], TICK, HOLD);
  assert.equal(live.get("m:two")?.count, 2);
});

test("alerts on the transition over the limit only — not while staying over, not at the limit", () => {
  const over = (n: number) => countStreamsByOwner(Array.from({ length: n }, (_, i) => sess(String(i), { mediaServerUserId: "same" })), TICK, HOLD);
  assert.equal(evaluateStreams(over(2), 2, empty(), NOW.getTime()).alert.length, 0, "at the limit is fine");
  const first = evaluateStreams(over(3), 2, empty(), NOW.getTime());
  assert.equal(first.alert.length, 1);
  const again = evaluateStreams(over(4), 2, first.state, NOW.getTime() + 5000);
  assert.equal(again.alert.length, 0, "still over: no repeat");
});

test("flapping across the limit re-alerts only after the cooldown", () => {
  const over = (n: number) => countStreamsByOwner(Array.from({ length: n }, (_, i) => sess(String(i), { mediaServerUserId: "same" })), TICK, HOLD);
  let t = NOW.getTime();
  let r = evaluateStreams(over(3), 2, empty(), t);
  assert.equal(r.alert.length, 1);
  r = evaluateStreams(over(1), 2, r.state, (t += 5000)); // dropped back
  r = evaluateStreams(over(3), 2, r.state, (t += 5000)); // climbed again, inside the cooldown
  assert.equal(r.alert.length, 0);
  r = evaluateStreams(over(1), 2, r.state, (t += 5000));
  r = evaluateStreams(over(3), 2, r.state, t + STREAM_ALERT_COOLDOWN_MS);
  assert.equal(r.alert.length, 1, "after the cooldown it alerts again");
});

// Hysteresis: a one-tick gap (a server fetch failing, a Jellyfin client briefly
// clearing NowPlayingItem) must not read as "back under the limit", or a
// continuous over-limit stretch re-alerts after every cooldown.
test("a continuous over-limit stretch with one-tick gaps alerts ONCE (3 streams, limit 2, 3 hours, a blip every 35 minutes)", () => {
  let state = empty();
  const t0 = NOW.getTime();
  let alerts = 0;
  for (let t = t0; t <= t0 + 3 * 3600_000; t += 5_000) {
    const tick = new Date(t);
    const stamped = new Date(t + 300);
    const blip = t > t0 && (t - t0) % (35 * 60_000) === 0; // this tick, stream c was not reported
    const rows = [
      sess("a", { mediaServerUserId: "blip", lastSeenAt: stamped }),
      sess("b", { mediaServerUserId: "blip", lastSeenAt: stamped }),
      sess("c", { mediaServerUserId: "blip", lastSeenAt: blip ? new Date(t - 4_700) : stamped }),
    ];
    const r = evaluateStreams(countStreamsByOwner(rows, tick, new Date(t - GRACE_MS)), 2, state, t + 500);
    alerts += r.alert.length;
    state = r.state;
  }
  assert.equal(alerts, 1);
});

test("a REAL drop to the limit — a session unseen past the hold window — leaves the over state, and a later climb alerts again after the cooldown", () => {
  const at = (t: number, ages: number[]) =>
    countStreamsByOwner(
      ages.map((age, i) => sess(String(i), { mediaServerUserId: "drop", lastSeenAt: new Date(t - age) })),
      new Date(t),
      new Date(t - GRACE_MS),
    );
  const t0 = NOW.getTime();
  let r = evaluateStreams(at(t0, [-300, -300, -300]), 2, empty(), t0);
  assert.equal(r.alert.length, 1);
  r = evaluateStreams(at(t0 + 30_000, [-300, -300, 25_000]), 2, r.state, t0 + 30_000);
  assert.ok(r.state.over.has("m:drop"), "unseen for 25s: inside the grace, still over");
  r = evaluateStreams(at(t0 + 70_000, [-300, -300, 65_000]), 2, r.state, t0 + 70_000);
  assert.equal(r.state.over.has("m:drop"), false, "unseen past the grace: back at the limit");
  const later = t0 + STREAM_ALERT_COOLDOWN_MS + 70_000;
  r = evaluateStreams(at(later, [-300, -300, -300]), 2, r.state, later);
  assert.equal(r.alert.length, 1, "a new over-limit stretch after the cooldown alerts again");
});

test("limit 0 clears all state (feature off)", () => {
  const counts = countStreamsByOwner([sess("1"), sess("2"), sess("3")], TICK, HOLD);
  const on = evaluateStreams(counts, 1, empty(), NOW.getTime());
  const off = evaluateStreams(counts, 0, on.state, NOW.getTime());
  assert.deepEqual([off.alert.length, off.state.over.size, off.state.alertedAt.size], [0, 0, 0]);
});

test("alert text names the count, the limit and the titles", () => {
  const counts = countStreamsByOwner([sess("1", { title: "Dune", mediaServerUserId: "a" }), sess("2", { title: "Show", seasonNumber: 2, episodeNumber: 3, mediaServerUserId: "a" })], TICK, HOLD);
  assert.equal(streamAlertText([...counts.values()][0], 1), "2 streams at once (limit 1): Dune, Show S02E03");
});

// ── one evaluation over stubbed rows ─────────────────────────────────────────
const { prisma } = await import("../src/lib/prisma.ts");
const { shadowPrismaModel } = await import("./_helpers.mts");
const { evaluateConcurrentStreams } = await import("../src/lib/stream-limit-data.ts");

const settings = new Map<string, string>();
let rows: Array<Record<string, unknown>> = [];
const inbox: Array<Record<string, unknown>> = [];
shadowPrismaModel(prisma, "setting", {
  findUnique: async (a: { where: { key: string } }) => (settings.has(a.where.key) ? { key: a.where.key, value: settings.get(a.where.key) } : null),
});
shadowPrismaModel(prisma, "activeSession", { findMany: async () => rows });
shadowPrismaModel(prisma, "user", { findMany: async () => [{ id: "admin-1" }] });
shadowPrismaModel(prisma, "notification", { create: async (a: { data: Record<string, unknown> }) => { inbox.push(a.data); return a.data; } });
shadowPrismaModel(prisma, "notificationAgent", { findMany: async () => [] });

// Rows stamped during the tick (just after it started), as the poller writes them.
let tick = new Date();
function row(id: string, userId: string | null, over: Record<string, unknown> = {}, lastSeenAt = new Date(tick.getTime() + 300)) {
  return {
    id, mediaServerUserId: `msu-${userId ?? id}`, serverUsername: "kid", lastSeenAt, title: `T${id}`, seasonNumber: null, episodeNumber: null,
    mediaServerUser: { userId, isServerAdmin: false, username: "kid", ...over },
  };
}
beforeEach(() => { settings.clear(); rows = []; inbox.length = 0; tick = new Date(); });

test("evaluation: off by default; over the limit inbox-alerts each admin once, then stays quiet", async () => {
  rows = [row("1", "u1"), row("2", "u1"), row("3", "u1")];
  assert.equal(await evaluateConcurrentStreams(tick), 0, "no limit configured ⇒ nothing");
  settings.set("concurrentStreamLimit", "2");
  assert.equal(await evaluateConcurrentStreams(tick), 1);
  assert.equal(inbox.length, 1);
  assert.equal(inbox[0].userId, "admin-1");
  assert.equal(inbox[0].type, "STREAM_LIMIT");
  assert.equal(await evaluateConcurrentStreams(tick), 0, "still over: no repeat");
  assert.equal(inbox.length, 1);
});

test("evaluation: a SLOW sibling server does not age a healthy server's rows out — they were seen this tick", async () => {
  // Each server stamps its rows right after ITS OWN fetch; the evaluation runs
  // after the slowest server answers (Plex's fetch timeout is 60s). The healthy
  // server's three streams were stamped 0.3s into the tick and still count.
  settings.set("concurrentStreamLimit", "2");
  rows = [row("1", "u-slow"), row("2", "u-slow"), row("3", "u-slow")];
  assert.equal(await evaluateConcurrentStreams(tick, new Date(tick.getTime() + 60_000)), 1);
  assert.equal(inbox.length, 1);
});

test("evaluation: a session last reported BEFORE this tick (ended, lingering in its grace) is not a stream", async () => {
  settings.set("concurrentStreamLimit", "1");
  rows = [row("tv", "u-switch", {}, new Date(tick.getTime() - 1_000)), row("phone", "u-switch")];
  assert.equal(await evaluateConcurrentStreams(tick, new Date(tick.getTime() + 2_000)), 0);
  assert.equal(inbox.length, 0);
});

test("evaluation: a one-tick gap does not end the over state — no second alert after the cooldown", async () => {
  settings.set("concurrentStreamLimit", "2");
  const t0 = tick.getTime();
  const at = (t: number) => new Date(t + 300);
  rows = [row("1", "u-blip", {}, at(t0)), row("2", "u-blip", {}, at(t0)), row("3", "u-blip", {}, at(t0))];
  assert.equal(await evaluateConcurrentStreams(new Date(t0), new Date(t0 + 500)), 1);
  // Next tick stream 3 was not reported (still inside its grace).
  const t1 = t0 + 5_000;
  rows = [row("1", "u-blip", {}, at(t1)), row("2", "u-blip", {}, at(t1)), row("3", "u-blip", {}, at(t0))];
  assert.equal(await evaluateConcurrentStreams(new Date(t1), new Date(t1 + 500)), 0);
  // Back to three, past the cooldown: still the same over-limit stretch.
  const t2 = t0 + STREAM_ALERT_COOLDOWN_MS + 60_000;
  rows = [row("1", "u-blip", {}, at(t2)), row("2", "u-blip", {}, at(t2)), row("3", "u-blip", {}, at(t2))];
  assert.equal(await evaluateConcurrentStreams(new Date(t2), new Date(t2 + 500)), 0);
  assert.equal(inbox.length, 1);
});

test("evaluation: a stream unseen past the absence grace is a real drop — the next climb after the cooldown alerts again", async () => {
  settings.set("concurrentStreamLimit", "2");
  const t0 = tick.getTime();
  const at = (t: number) => new Date(t + 300);
  rows = [row("1", "u-drop", {}, at(t0)), row("2", "u-drop", {}, at(t0)), row("3", "u-drop", {}, at(t0))];
  assert.equal(await evaluateConcurrentStreams(new Date(t0), new Date(t0 + 500)), 1);
  const t1 = t0 + 70_000; // stream 3 last seen ~70s ago: past the 60s grace
  rows = [row("1", "u-drop", {}, at(t1)), row("2", "u-drop", {}, at(t1)), row("3", "u-drop", {}, at(t0))];
  assert.equal(await evaluateConcurrentStreams(new Date(t1), new Date(t1 + 500)), 0);
  const t2 = t0 + STREAM_ALERT_COOLDOWN_MS + 60_000;
  rows = [row("1", "u-drop", {}, at(t2)), row("2", "u-drop", {}, at(t2)), row("3", "u-drop", {}, at(t2))];
  assert.equal(await evaluateConcurrentStreams(new Date(t2), new Date(t2 + 500)), 1);
  assert.equal(inbox.length, 2);
});

test("evaluation never throws when the read fails", async () => {
  settings.set("concurrentStreamLimit", "2");
  shadowPrismaModel(prisma, "activeSession", { findMany: async () => { throw new Error("db down"); } });
  const origErr = console.error; console.error = () => {};
  try { assert.equal(await evaluateConcurrentStreams(tick), 0); } finally { console.error = origErr; }
});
