// The Initial DB Fill's outcome rules (src/components/admin/master-db-fill.ts):
// a warm failure keeps the per-server library results beside its own error,
// and a failed run's line stays until the next run.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const { fillLibraryStep, fillLibraryFailedEnd, fillWarmEnd, fillWarmThrewEnd, fillResetDelayMs } = await import("../src/components/admin/master-db-fill.ts");
const { functionBody } = await import("./structural-pin-source-scan.mts");

const t = ((key: string, params?: Record<string, unknown>) => (params ? `${key}${JSON.stringify(params)}` : key)) as never;

const synced = { outcome: { kind: "synced" as const, count: 3 }, text: "Plex 3 items" };
const failed = { outcome: { kind: "failed" as const, error: "boom", status: 500 }, text: "Jellyfin boom" };
const silent = { outcome: { kind: "noAnswer" as const }, text: "Jellyfin no answer" };

test("phase 1: every server failing stops the run; a partial failure or a silent server carries on, flagged", () => {
  const all = fillLibraryStep([failed, { ...failed, text: "Plex boom" }]);
  assert.equal(all.allFailed, true);
  assert.deepEqual(fillLibraryFailedEnd(all, t), { phase: "error", summary: 'adminManage.library.fill.libraryFailedWith{"detail":"Jellyfin boom · Plex boom"}' });
  const partial = fillLibraryStep([synced, failed]);
  assert.deepEqual([partial.allFailed, partial.degraded, partial.pending], [false, true, false]);
  const quiet = fillLibraryStep([synced, silent]);
  assert.deepEqual([quiet.allFailed, quiet.degraded, quiet.pending], [false, false, true]);
});

test("a warm that failed keeps the library results in front of its error", () => {
  const step = fillLibraryStep([synced]);
  assert.deepEqual(fillWarmEnd(step, { status: 500, data: { error: "warm broke" } }, t, "en"), {
    phase: "error",
    summary: "Plex 3 items · warm broke",
  });
  assert.deepEqual(fillWarmEnd(step, { status: 409, data: {} }, t, "en"), {
    phase: "error",
    summary: 'Plex 3 items · adminManage.library.fill.warmFailedStatus{"status":409}',
  });
  assert.deepEqual(fillWarmThrewEnd(step, t), { phase: "error", summary: "Plex 3 items · adminManage.library.fill.warmFailed" });
});

test("a warm with no answer is pending, unless a library server already failed", () => {
  assert.deepEqual(fillWarmEnd(fillLibraryStep([synced]), { status: 0, data: null }, t, "en"), {
    phase: "pending",
    summary: "Plex 3 items · adminManage.library.fill.warmNoAnswer",
  });
  assert.equal(fillWarmEnd(fillLibraryStep([synced, failed]), { status: 504, data: null }, t, "en").phase, "error");
});

test("a finished warm names its counts; failed items or a failed server never end green", () => {
  const ok = fillWarmEnd(fillLibraryStep([synced]), { status: 200, data: { fetched: 1200, skipped: 2 } }, t, "en");
  assert.equal(ok.phase, "done");
  assert.equal(ok.summary, 'Plex 3 items · TMDB: adminManage.library.fill.fetched{"value":"1,200"}, adminManage.library.fill.cached{"value":"2"}');
  assert.equal(fillWarmEnd(fillLibraryStep([synced]), { status: 200, data: { failed: 1 } }, t, "en").phase, "error");
  assert.equal(fillWarmEnd(fillLibraryStep([synced, silent]), { status: 200, data: {} }, t, "en").phase, "pending");
  const odd = fillWarmEnd(fillLibraryStep([synced]), { status: 200, data: { fetched: "lots" } }, t, "en");
  assert.equal(odd.summary, 'Plex 3 items · TMDB: adminManage.library.btn.items{"count":0,"formatted":"0"}', "a count that isn't a number counts 0");
});

test("a failure's line stays until the next run; success and pending clear themselves", () => {
  assert.equal(fillResetDelayMs("error"), null);
  assert.equal(fillResetDelayMs("done"), 20_000);
  assert.equal(fillResetDelayMs("pending"), 20_000);
  const src = readFileSync(new URL("../src/components/admin/master-db-fill-button.tsx", import.meta.url), "utf8");
  const finish = functionBody(src, "function finish(");
  assert.match(finish, /const delay = fillResetDelayMs\(end\.phase\);\s*if \(delay !== null\) scheduleReset\(delay\);/);
  assert.equal(src.match(/scheduleReset\(/g)?.length, 2, "the definition and finish(): no exit path schedules its own reset");
  // A kept failure stays red (and an alert) after the admin opens and cancels the confirm.
  assert.match(src, /role=\{summary\.phase === "error" \? "alert" : "status"\}/);
  assert.match(src, /summary\.phase === "error" \? "text-red-400"/);
});
