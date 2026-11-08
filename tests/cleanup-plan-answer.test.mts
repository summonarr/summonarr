// What the shared cleanup delete flow reads from POST /api/admin/cleanup/delete
// (src/lib/cleanup-plan-answer.ts): ONE parser for the dry run's plan and a
// 409's fresh plan, and the execute's results. The confirm panel confirms
// "N deletions, X GB" against whichever plan is on screen, so a plan that isn't
// one is never installed, and a 409's size is the route's (or, from an older
// server that sends none, the sum of its targets) — never a second copy of the
// route's plan maths left to drift.
import { test } from "node:test";
import assert from "node:assert/strict";
import { planFromAnswer, readExecuteAnswer } from "../src/lib/cleanup-plan-answer.ts";

const ITEMS = [
  { tmdbId: 1, mediaType: "MOVIE", title: "A", matched: true, targets: [{ service: "radarr", instance: "", arrId: 3, title: "A", sizeOnDisk: 4 }] },
  { tmdbId: 2, mediaType: "TV", title: "B", targets: [{ service: "sonarr", instance: "4k", arrId: 4, title: "B", sizeOnDisk: 5 }] },
];

test("a dry-run plan is read whole, with only the fields the panel uses", () => {
  const plan = planFromAnswer({ dryRun: true, targetCount: 2, targetsFingerprint: "x", reclaimableBytes: 9, blacklist: true, items: ITEMS, skipped: [], hint: "…" });
  assert.deepEqual(plan, {
    targetCount: 2,
    targetsFingerprint: "x",
    reclaimableBytes: 9,
    items: [
      { tmdbId: 1, mediaType: "MOVIE", title: "A", targets: [{ service: "radarr", instance: "", title: "A", sizeOnDisk: 4 }] },
      { tmdbId: 2, mediaType: "TV", title: "B", targets: [{ service: "sonarr", instance: "4k", title: "B", sizeOnDisk: 5 }] },
    ],
    skipped: [],
  });
});

test("a 409 uses the route's size; an older server's 409 (no size, no skipped) sums its targets", () => {
  assert.equal(planFromAnswer({ error: "changed", targetCount: 2, reclaimableBytes: 100, items: ITEMS, skipped: [] })?.reclaimableBytes, 100);
  const old = planFromAnswer({ error: "changed", targetCount: 2, items: ITEMS });
  assert.equal(old?.reclaimableBytes, 9);
  assert.deepEqual(old?.skipped, []);
  assert.equal(old && "targetsFingerprint" in old, false, "no fingerprint invented");
});

test("a body that isn't a plan is no plan", () => {
  for (const body of [null, "html", {}, { targetCount: 1 }, { targetCount: 1, items: [{ ...ITEMS[0], mediaType: "movie" }] }, { targetCount: "2", items: ITEMS }]) {
    assert.equal(planFromAnswer(body), null, JSON.stringify(body));
  }
});

test("the execute's answer: results, a 409's fresh plan (or none), a refusal", () => {
  const results = {
    deletedCount: 1, partialCount: 0, failedCount: 0,
    results: [{ tmdbId: 1, mediaType: "MOVIE", title: "A", status: "deleted", deleted: ["radarr:default"], failed: [], blacklisted: true }],
  };
  const done = readExecuteAnswer(200, results);
  assert.equal(done.kind, "done");
  if (done.kind === "done") assert.equal("blacklisted" in done.result.results[0], false);
  const conflict = readExecuteAnswer(409, { error: "changed", targetCount: 2, items: ITEMS });
  assert.equal(conflict.kind, "conflict");
  if (conflict.kind === "conflict") assert.equal(conflict.plan?.targetCount, 2);
  assert.deepEqual(readExecuteAnswer(409, { error: "changed" }), { kind: "conflict", plan: null });
  assert.deepEqual(readExecuteAnswer(404, { error: "Cleanup is off" }), { kind: "refused", error: "Cleanup is off" });
});

test("the cleanup pages' day formatter is the guarded one: a date that isn't one reads as a dash, never a RangeError", async () => {
  const { readFileSync } = await import("node:fs");
  const { utcDayFormatter } = await import("../src/components/admin/missing-format.ts");
  const src = readFileSync(new URL("../src/components/admin/cleanup-delete.tsx", import.meta.url), "utf8");
  assert.match(src, /export \{ utcDayFormatter as dayFormatter \} from "@\/components\/admin\/missing-format";/);
  assert.doesNotMatch(src, /fmt\.format\(new Date\(/, "no unguarded Intl format of a parsed string");
  const day = utcDayFormatter("en");
  assert.equal(day("not a date"), "—");
  assert.equal(day(null), "—");
  assert.equal(day("2026-03-01T00:00:00.000Z"), "Mar 1, 2026", "the UTC day, as before");
});
