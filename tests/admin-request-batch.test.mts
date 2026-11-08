// The admin request queue's batch bookkeeping
// (src/components/admin/request-batch.ts): what a run settles, what stays
// selected, what it says when it ends, and the selection's page rules.
import { test } from "node:test";
import assert from "node:assert/strict";
import { check } from "../src/lib/validate.ts";

const b = await import("../src/components/admin/request-batch.ts");

const group = (title: string, ...requesters: [string, string][]) => ({
  title,
  requesters: requesters.map(([requestId, status]) => ({ requestId, status })),
});

test("pending ids come from every group, in order, and only PENDING ones", () => {
  const groups = [group("A", ["a1", "PENDING"], ["a2", "APPROVED"]), group("B", ["b1", "PENDING"])];
  assert.deepEqual(b.pendingIdsFor(groups[0]), ["a1"]);
  assert.deepEqual(b.pendingIdsOf(groups), ["a1", "b1"]);
  assert.deepEqual(b.pendingIdsOf([]), []);
});

test("the selection drops ids this page shows as decided, and keeps ids on other pages", () => {
  const groups = [group("A", ["a1", "PENDING"], ["a2", "APPROVED"])];
  const pruned = b.pruneSelection(new Set(["a1", "a2", "elsewhere"]), groups);
  assert.deepEqual([...pruned].sort(), ["a1", "elsewhere"]);
  const same = new Set(["a1", "elsewhere"]);
  assert.equal(b.pruneSelection(same, groups), same, "nothing to drop: the same set, so the state update is a no-op");
  assert.equal(b.offPageCount(new Set(["a1", "x", "y"]), groups), 2);
});

test("ids go in calls of at most the route's cap", () => {
  const ids = Array.from({ length: 250 }, (_, i) => `r${i}`);
  const chunks = b.idChunks(ids);
  assert.deepEqual(chunks.map((c) => c.length), [100, 100, 50]);
  assert.deepEqual(chunks.flat(), ids, "in order, none lost");
  assert.equal(b.BATCH_ID_CAP, 100);
  assert.deepEqual(b.idChunks([]), []);
});

test("a run settles what the route answered, minus the rows whose push failed", () => {
  let p = b.recordChunk(b.NO_PROGRESS, ["a", "b", "c"], { failed: [{ id: "b" }], arrError: "Radarr: 1 failed" });
  p = b.recordChunk(p, ["d", "e"], {});
  assert.deepEqual(b.settledIds(p), ["a", "c", "d", "e"]);
  assert.deepEqual(p.keep, ["b"]);
  // A chunk that never got an answer was never recorded: its ids aren't settled.
  assert.ok(!b.settledIds(p).includes("f"));
});

test("every chunk's push-failure summary is kept, once each, beside what stopped the run", () => {
  let p = b.recordChunk(b.NO_PROGRESS, ["a"], { failed: [{ id: "a" }], arrError: "first chunk failed" });
  p = b.recordChunk(p, ["b"], { failed: [{ id: "b" }], arrError: "second chunk failed" });
  p = b.recordChunk(p, ["c"], { failed: [{ id: "c" }], arrError: "first chunk failed" });
  assert.equal(b.batchErrorText(p, null), "first chunk failed\nsecond chunk failed");
  assert.equal(b.batchErrorText(p, "No connection"), "first chunk failed\nsecond chunk failed\nNo connection");
  assert.equal(b.batchErrorText(b.NO_PROGRESS, null), null, "a clean run says nothing");
  assert.equal(b.batchErrorText(b.NO_PROGRESS, "Too many requests"), "Too many requests");
});

test("adds that got no answer are collected across chunks", () => {
  let p = b.recordChunk(b.NO_PROGRESS, ["a", "b"], { outcomeUnknown: ["a"] });
  p = b.recordChunk(p, ["c"], { outcomeUnknown: ["c"] });
  assert.deepEqual(p.outcomeUnknown, ["a", "c"]);
  assert.deepEqual(b.settledIds(p), ["a", "b", "c"], "they stay APPROVED, so they leave the selection");
});

test("titles are named once each, and ids the page doesn't show are counted", () => {
  const groups = [group("Dune", ["a", "PENDING"], ["b", "PENDING"]), group("Heat", ["c", "PENDING"])];
  assert.deepEqual(b.titlesFor(["a", "b", "c", "zz"], groups), { titles: ["Dune", "Heat"], unknown: 1 });
});

test("the route's 200 is read through a schema: its three optional fields, extras dropped", () => {
  const ok = check(b.BatchAnswer, {
    ok: true,
    failed: [{ id: "a", title: "Dune", error: "boom" }],
    arrError: "Radarr: boom",
    outcomeUnknown: ["b"],
    extra: 1,
  });
  assert.ok(ok.ok);
  assert.deepEqual(ok.value, { ok: true, failed: [{ id: "a", title: "Dune", error: "boom" }], arrError: "Radarr: boom", outcomeUnknown: ["b"] });
  assert.ok(check(b.BatchAnswer, { ok: true }).ok, "a clean batch");
  assert.ok(!check(b.BatchAnswer, { failed: [{ id: 7 }] }).ok, "a failed row must name its id");
  assert.ok(!check(b.BatchAnswer, { outcomeUnknown: "a" }).ok);
  assert.ok(!check(b.BatchAnswer, null).ok, "an empty 200 is not an answer");
});
