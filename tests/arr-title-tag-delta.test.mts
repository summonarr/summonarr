// The title manager's Settings tags are edited as a DELTA (snapshot-rules.ts
// TagDelta), never an absolute list (audit F005).
//
// Why: the form can paint a snapshot up to a day old, and the live read that
// follows REBASES it without a remount, keeping the admin's edits. An absolute
// list toggled over the snapshot was saved as-is (the PATCH replaces tags), so
// a tag added on the arr since the snapshot was silently removed.
//
// What is pinned:
// - the form shows and saves (arr's tags ∪ added) \ removed, ascending, over
//   whatever base it holds NOW — a rebase keeps a tag the arr gained;
// - a removal of a tag the live read no longer has is a no-op;
// - no change (including a flip and flip back) sends no `tags` at all;
// - the component derives its list from the delta and toggles through it
//   (structural: the unit loader can't import .tsx).
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  applyTagDelta,
  NO_TAG_DELTA,
  tagDeltaChange,
  toggleTagDelta,
} from "../src/components/admin/arr-title/snapshot-rules.ts";

const SETTINGS = readFileSync(new URL("../src/components/admin/arr-title/settings-tab.tsx", import.meta.url), "utf8");

test("F005: a tag added over a snapshot survives the rebase onto a live list that gained a tag", () => {
  const snapshot = [1];
  const delta = toggleTagDelta(NO_TAG_DELTA, snapshot, 2);
  assert.deepEqual(applyTagDelta(snapshot, delta), [1, 2], "the form shows the added tag over the snapshot");
  // The live read lands: someone added tag 3 on the arr after the snapshot was kept.
  const live = [1, 3];
  assert.deepEqual(applyTagDelta(live, delta), [1, 2, 3]);
  assert.deepEqual(tagDeltaChange(live, delta), [1, 2, 3], "the PATCH keeps tag 3");
});

test("F005: a tag removed over a snapshot is removed from the live list, the arr's new tag kept", () => {
  const delta = toggleTagDelta(NO_TAG_DELTA, [1, 2], 2);
  assert.deepEqual(delta, { add: [], remove: [2] });
  assert.deepEqual(tagDeltaChange([1, 2, 3], delta), [1, 3]);
});

test("removing a tag the live read no longer has is a no-op — nothing to send", () => {
  const delta = toggleTagDelta(NO_TAG_DELTA, [1, 2], 2);
  // Tag 2 was taken off on the arr before the live read answered.
  assert.deepEqual(applyTagDelta([1], delta), [1]);
  assert.equal(tagDeltaChange([1], delta), undefined);
});

test("no change sends no tags", () => {
  assert.equal(tagDeltaChange([1, 3], NO_TAG_DELTA), undefined);
  assert.equal(tagDeltaChange([], NO_TAG_DELTA), undefined);
  // The arr's order is not a change.
  assert.equal(tagDeltaChange([3, 1], NO_TAG_DELTA), undefined);
  // Adding a tag the arr already gained by the time the live read lands.
  assert.equal(tagDeltaChange([1, 2], toggleTagDelta(NO_TAG_DELTA, [1], 2)), undefined);
});

test("a flip and a flip back leave no edit, so it can't outlive a later rebase", () => {
  const on = toggleTagDelta(NO_TAG_DELTA, [1], 2);
  assert.deepEqual(toggleTagDelta(on, [1], 2), NO_TAG_DELTA);
  const off = toggleTagDelta(NO_TAG_DELTA, [1], 1);
  assert.deepEqual(toggleTagDelta(off, [1], 1), NO_TAG_DELTA);
  // Turned off and back on: a live list that has since lost tag 1 is not given it back.
  assert.equal(tagDeltaChange([], toggleTagDelta(off, [1], 1)), undefined);
});

test("a flip is judged against the list the form shows NOW (after a rebase)", () => {
  // Added over the snapshot [1]; the live read [1, 2] already has it; the admin then turns it off.
  const added = toggleTagDelta(NO_TAG_DELTA, [1], 2);
  const off = toggleTagDelta(added, [1, 2], 2);
  assert.deepEqual(off, { add: [], remove: [2] });
  assert.deepEqual(tagDeltaChange([1, 2], off), [1]);
});

test("the derived list is ascending and duplicate-free", () => {
  assert.deepEqual(applyTagDelta([5, 1, 5], { add: [3, 3], remove: [] }), [1, 3, 5]);
  assert.deepEqual(tagDeltaChange([5, 1], { add: [3], remove: [] }), [1, 3, 5]);
});

test("Settings derives draft.tags from the delta, sends tagDeltaChange, and toggles through toggleTagDelta", () => {
  assert.match(SETTINGS, /type Edits = Partial<Omit<Draft, "tags">> & \{ tags\?: TagDelta \};/);
  assert.match(SETTINGS, /const \[edits, setEdits\] = useState<Edits>\(\{\}\);/);
  assert.match(SETTINGS, /const \{ tags: tagDelta = NO_TAG_DELTA, \.\.\.fieldEdits \} = edits;/);
  assert.match(SETTINGS, /const draft: Draft = \{ \.\.\.base, \.\.\.fieldEdits, tags: applyTagDelta\(base\.tags, tagDelta\) \};/);
  assert.match(SETTINGS, /const tagsChange = tagDeltaChange\(base\.tags, tagDelta\);\s*if \(tagsChange\) c\.tags = tagsChange;/);
  assert.match(SETTINGS, /onClick=\{\(\) => update\(\{ tags: toggleTagDelta\(tagDelta, base\.tags, tag\.id\) \}\)\}/);
  assert.match(SETTINGS, /function update\(patch: Edits\) \{/);
  // No absolute tag list is stored as an edit, and none is sent from draft.
  assert.doesNotMatch(SETTINGS, /update\(\{ tags: on \?/);
  assert.doesNotMatch(SETTINGS, /c\.tags = draft\.tags/);
});
