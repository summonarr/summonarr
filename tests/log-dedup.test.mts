// warnOnChange — repeat-suppression for warnings that restate an UNCHANGED
// condition on every pass of a periodic job.
//
// The failure this guards against is subtle: the suppressed warnings are all
// TRUE, and each one individually looks worth keeping. What made them harmful
// is that their VOLUME is a property of the caller's polling rate, not of the
// condition — so when the sync orchestrator started running once a minute
// instead of once an hour, the same lines went from ~24/day to ~1,400/day and
// buried the anomaly they were adjacent to. These pins hold the two halves that
// matter: an unchanged condition must go quiet, and a changed one must not.

import test from "node:test";
import assert from "node:assert/strict";

const warns: string[] = [];
const realWarn = console.warn;
console.warn = (...args: unknown[]) => { warns.push(args.map(String).join(" ")); };
process.on("exit", () => { console.warn = realWarn; });

const { warnOnChange, resetLogDedup } = await import("../src/lib/log-dedup.ts");

function reset(): void {
  warns.length = 0;
  resetLogDedup();
}

test("first call for a key always logs — a fresh process must never hide the current state", () => {
  reset();
  warnOnChange("k", "sig", "[scope] 90 duplicates");
  assert.deepEqual(warns, ["[scope] 90 duplicates"]);
});

test("an identical signature is suppressed, however many times it repeats", () => {
  reset();
  for (let i = 0; i < 50; i++) warnOnChange("k", "90", "[scope] 90 duplicates");
  assert.equal(warns.length, 1, "50 identical passes must produce exactly one line");
});

test("a CHANGED signature re-logs immediately — suppression must never hide a real change", () => {
  reset();
  warnOnChange("k", "90", "[scope] 90 duplicates");
  warnOnChange("k", "91", "[scope] 91 duplicates");
  warnOnChange("k", "91", "[scope] 91 duplicates");
  warnOnChange("k", "90", "[scope] 90 duplicates"); // back again — still a change
  assert.deepEqual(warns, [
    "[scope] 90 duplicates",
    "[scope] 91 duplicates",
    "[scope] 90 duplicates",
  ]);
});

test("keys are independent — one condition going quiet must not silence another", () => {
  reset();
  warnOnChange("movies", "90", "[scope] 90 movies");
  warnOnChange("series", "27", "[scope] 27 series");
  warnOnChange("movies", "90", "[scope] 90 movies"); // suppressed
  warnOnChange("series", "28", "[scope] 28 series"); // changed → logs
  assert.deepEqual(warns, ["[scope] 90 movies", "[scope] 27 series", "[scope] 28 series"]);
});

test("the signature, not the message, decides — a same-signature message change stays suppressed", () => {
  // Documents the contract rather than endorsing it: callers must derive the
  // signature from everything the message states, or a changed message is lost.
  reset();
  warnOnChange("k", "same", "first wording");
  warnOnChange("k", "same", "DIFFERENT wording");
  assert.deepEqual(warns, ["first wording"]);
});

test("tracking is bounded: unbounded distinct keys cannot grow the map without limit", () => {
  reset();
  // Far more distinct keys than MAX_TRACKED_KEYS (256). The contract is only
  // that this stays bounded and keeps working — on overflow the map clears, so
  // a key may log a second time, which is the cheap, correct failure direction.
  for (let i = 0; i < 1000; i++) warnOnChange(`key-${i}`, "s", `msg ${i}`);
  assert.equal(warns.length, 1000, "every distinct condition still reports once");

  warns.length = 0;
  // A key logged long ago may have been evicted; a key logged since the last
  // clear must still be suppressed. Prove suppression is alive after overflow.
  warnOnChange("stable", "v1", "stable msg");
  warnOnChange("stable", "v1", "stable msg");
  assert.equal(warns.length, 1, "suppression must survive the overflow reset");
});

test("resetLogDedup clears state so cases cannot leak into each other", () => {
  reset();
  warnOnChange("k", "s", "m");
  warnOnChange("k", "s", "m");
  assert.equal(warns.length, 1);
  resetLogDedup();
  warnOnChange("k", "s", "m");
  assert.equal(warns.length, 2, "after a reset the condition is unknown again and must re-log");
});
