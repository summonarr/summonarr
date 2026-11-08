// The notification switches' autosave sends only what was flipped, and a
// failed save puts back only its own switches
// (src/components/profile/notification-prefs-delta.ts).
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { applyDelta, revertFailed } from "../src/components/profile/notification-prefs-delta.ts";

type P = { a: boolean; b: boolean; c: boolean };
const confirmed: P = { a: false, b: false, c: true };

test("a confirmed save applies only the flipped keys", () => {
  assert.deepEqual(applyDelta(confirmed, { a: true }), { a: true, b: false, c: true });
});

test("a failed save reverts its own keys and nothing else", () => {
  // `b` was turned on by another save that succeeded and is shown here.
  const shown: P = { a: true, b: true, c: true };
  assert.deepEqual(revertFailed(shown, { ...confirmed, b: true }, { a: true }, null), { a: false, b: true, c: true });
});

test("a key flipped again while the save was in flight is left for the next save", () => {
  // The failed save carried a:true and b:true; since then `a` was flipped off
  // and on again, so the next save sends a:true and the switch must stay on.
  const shown: P = { a: true, b: true, c: true };
  assert.deepEqual(revertFailed(shown, confirmed, { a: true, b: true }, { a: true }), { a: true, b: false, c: true });
});

test("the component sends the delta, not the whole set, and no longer refreshes the page per flip", () => {
  const src = readFileSync(new URL("../src/components/profile/notification-prefs.tsx", import.meta.url), "utf8");
  const flush = src.slice(src.indexOf("async function flush()"), src.indexOf("function toggle("));
  assert.match(flush, /jsonInit\("PATCH", delta\)/, "the save body is the delta");
  assert.doesNotMatch(flush, /router\.refresh\(\)/, "a pref save re-rendered the whole profile page");
  assert.match(src, /body: JSON\.stringify\(pending\),\s*keepalive: true/, "the unmount save sends the pending delta");
});
