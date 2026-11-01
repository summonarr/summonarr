// Concurrent-stream alert: the pure transition rules (src/lib/stream-limit.ts)
// and one evaluation over stubbed ActiveSession rows (stream-limit-data.ts).
process.env.TOKEN_ENCRYPTION_KEY = "ab".repeat(32);
process.env.NEXTAUTH_SECRET = "stream-limit-test-secret-0123456789abcdef";
process.env.TRUST_PROXY = "true";

import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";

const m = await import("../src/lib/stream-limit.ts");
const { countStreamsByOwner, evaluateStreams, parseStreamLimit, streamAlertText, STREAM_FRESH_MS, STREAM_ALERT_COOLDOWN_MS } = m;

const NOW = new Date("2026-10-31T12:00:00Z");
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
  ], NOW);
  assert.equal(counts.get("u:alice")?.count, 2);
  assert.equal(counts.get("m:plex-bob")?.count, 1);
});

test("server-admin accounts and stale sessions never count", () => {
  const counts = countStreamsByOwner([
    sess("1", { isServerAdmin: true }),
    sess("2", { isServerAdmin: true, mediaServerUserId: "msu-1" }),
    sess("3", { mediaServerUserId: "x", lastSeenAt: new Date(NOW.getTime() - STREAM_FRESH_MS - 1000) }),
  ], NOW);
  assert.equal(counts.size, 0);
});

test("alerts on the transition over the limit only — not while staying over, not at the limit", () => {
  const over = (n: number) => countStreamsByOwner(Array.from({ length: n }, (_, i) => sess(String(i), { mediaServerUserId: "same" })), NOW);
  assert.equal(evaluateStreams(over(2), 2, empty(), NOW.getTime()).alert.length, 0, "at the limit is fine");
  const first = evaluateStreams(over(3), 2, empty(), NOW.getTime());
  assert.equal(first.alert.length, 1);
  const again = evaluateStreams(over(4), 2, first.state, NOW.getTime() + 5000);
  assert.equal(again.alert.length, 0, "still over: no repeat");
});

test("flapping across the limit re-alerts only after the cooldown", () => {
  const over = (n: number) => countStreamsByOwner(Array.from({ length: n }, (_, i) => sess(String(i), { mediaServerUserId: "same" })), NOW);
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

test("limit 0 clears all state (feature off)", () => {
  const counts = countStreamsByOwner([sess("1"), sess("2"), sess("3")], NOW);
  const on = evaluateStreams(counts, 1, empty(), NOW.getTime());
  const off = evaluateStreams(counts, 0, on.state, NOW.getTime());
  assert.deepEqual([off.alert.length, off.state.over.size, off.state.alertedAt.size], [0, 0, 0]);
});

test("alert text names the count, the limit and the titles", () => {
  const counts = countStreamsByOwner([sess("1", { title: "Dune", mediaServerUserId: "a" }), sess("2", { title: "Show", seasonNumber: 2, episodeNumber: 3, mediaServerUserId: "a" })], NOW);
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

function row(id: string, userId: string | null, over: Record<string, unknown> = {}) {
  return {
    id, mediaServerUserId: `msu-${userId ?? id}`, serverUsername: "kid", lastSeenAt: new Date(), title: `T${id}`, seasonNumber: null, episodeNumber: null,
    mediaServerUser: { userId, isServerAdmin: false, username: "kid", ...over },
  };
}
beforeEach(() => { settings.clear(); rows = []; inbox.length = 0; });

test("evaluation: off by default; over the limit inbox-alerts each admin once, then stays quiet", async () => {
  rows = [row("1", "u1"), row("2", "u1"), row("3", "u1")];
  assert.equal(await evaluateConcurrentStreams(new Date()), 0, "no limit configured ⇒ nothing");
  settings.set("concurrentStreamLimit", "2");
  assert.equal(await evaluateConcurrentStreams(new Date()), 1);
  assert.equal(inbox.length, 1);
  assert.equal(inbox[0].userId, "admin-1");
  assert.equal(inbox[0].type, "STREAM_LIMIT");
  assert.equal(await evaluateConcurrentStreams(new Date()), 0, "still over: no repeat");
  assert.equal(inbox.length, 1);
});

test("evaluation never throws when the read fails", async () => {
  settings.set("concurrentStreamLimit", "2");
  shadowPrismaModel(prisma, "activeSession", { findMany: async () => { throw new Error("db down"); } });
  const origErr = console.error; console.error = () => {};
  try { assert.equal(await evaluateConcurrentStreams(new Date()), 0); } finally { console.error = origErr; }
});
