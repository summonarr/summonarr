// The Features tab's batched saves (src/lib/feature-toggle-queue.ts, used by
// src/components/settings/features-form.tsx). /api/settings allows 10 PATCHes a
// minute per admin, and flipping switches about a second apart sends one each:
// the 11th used to be reverted on screen with an error although the server never
// judged it. A 429 must leave the batch pending and schedule a retry; any other
// failure still reverts.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import {
  RATE_LIMIT_RETRY_MAX_MS,
  RATE_LIMIT_RETRY_MIN_MS,
  flushOutcome,
  nextRetryDelay,
  settleBatch,
  type ToggleQueue,
} from "../src/lib/feature-toggle-queue.ts";

function queue(saved: Record<string, boolean>, pending: Array<[string, boolean]>): ToggleQueue {
  return { saved: { ...saved }, pending: new Map(pending) };
}

test("a 429 is 'not sent yet'; any other non-success, or no answer, is a failure", () => {
  assert.equal(flushOutcome({ status: 429, ok: undefined }), "rateLimited");
  assert.equal(flushOutcome({ status: 200, ok: true }), "saved");
  assert.equal(flushOutcome({ status: 200, ok: false }), "failed", "ok:false in a 200 is still a failure");
  assert.equal(flushOutcome({ status: 400, ok: undefined }), "failed");
  assert.equal(flushOutcome({ status: 500, ok: undefined }), "failed");
  assert.equal(flushOutcome(null), "failed");
});

test("a rate-limited reply keeps the WHOLE batch pending and confirms nothing", () => {
  const q = queue({ "feature.page.top": false, "feature.page.votes": true }, [["feature.page.top", true], ["feature.page.votes", false]]);
  const settled = settleBatch(q, [["feature.page.top", true], ["feature.page.votes", false]], "rateLimited");
  assert.deepEqual(settled, [], "no switch is finished — none is reverted");
  assert.deepEqual([...q.pending], [["feature.page.top", true], ["feature.page.votes", false]], "both stay queued for the retry");
  assert.deepEqual(q.saved, { "feature.page.top": false, "feature.page.votes": true });
});

test("a failed reply reverts each finished switch to its confirmed value", () => {
  const q = queue({ "feature.page.top": false }, [["feature.page.top", true], ["feature.page.new", true]]);
  const settled = settleBatch(q, [["feature.page.top", true], ["feature.page.new", true]], "failed");
  assert.deepEqual(settled, [
    { key: "feature.page.top", ok: false, revertTo: false },
    { key: "feature.page.new", ok: false, revertTo: false },
  ]);
  assert.equal(q.pending.size, 0);
});

test("a saved reply confirms the batch; a switch flipped again meanwhile stays pending with its newer value", () => {
  const q = queue({ "feature.page.top": false, "feature.page.votes": false }, [["feature.page.top", true], ["feature.page.votes", false]]);
  // Sent: top=true, votes=true. While in flight the admin flipped votes back off.
  const settled = settleBatch(q, [["feature.page.top", true], ["feature.page.votes", true]], "saved");
  assert.deepEqual(settled, [{ key: "feature.page.top", ok: true }]);
  assert.deepEqual([...q.pending], [["feature.page.votes", false]], "the newer intent is not overwritten");
  assert.deepEqual(q.saved, { "feature.page.top": true, "feature.page.votes": true }, "what the server holds now");
});

test("the retry backs off from 6s, doubling to a one-minute ceiling", () => {
  const delays: number[] = [];
  let d: number | null = null;
  for (let i = 0; i < 6; i++) delays.push((d = nextRetryDelay(d)));
  assert.deepEqual(delays, [6_000, 12_000, 24_000, 48_000, 60_000, 60_000]);
  assert.equal(delays[0], RATE_LIMIT_RETRY_MIN_MS);
  assert.equal(delays.at(-1), RATE_LIMIT_RETRY_MAX_MS);
});

test("features-form wires the rules: a 429 schedules the retry and returns before settling (so nothing reverts); a flip during the backoff waits for it", () => {
  const src = readFileSync(new URL("../src/components/settings/features-form.tsx", import.meta.url), "utf8");
  const flush = src.slice(src.indexOf("async function flush()"), src.indexOf("function scheduleFlush()"));
  const limited = flush.indexOf('if (outcome === "rateLimited")');
  assert.ok(limited > 0, "the 429 branch exists");
  assert.ok(limited < flush.indexOf("settleBatch("), "it runs before any switch is settled or reverted");
  assert.match(flush.slice(limited, flush.indexOf("settleBatch(")), /scheduleRetry\(retryDelay\.current\);\s*return;/);
  const schedule = src.slice(src.indexOf("function scheduleFlush()"), src.indexOf("function scheduleRetry("));
  assert.match(schedule, /if \(backingOff\.current\) return;/, "a flip during the backoff doesn't fire straight into another 429");
});
