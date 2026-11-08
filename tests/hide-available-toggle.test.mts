// HideAvailableToggle (home, /upcoming) shows the new state while the
// navigation is pending. Its toggle used to branch on the committed `active`
// prop, so a second click while the first was still landing (off → on → off)
// pushed hideAvailable=1 again: the user's last "off" was lost and the button
// stayed on. The next state must come from what the button SHOWS.
//
// Structural pin on the source (the loader cannot import .tsx), in the style of
// tests/browse-grid-error-state.test.mts.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const src = readFileSync(new URL("../src/components/media/hide-available-toggle.tsx", import.meta.url), "utf8");

test("the toggle's next state is derived from what is shown, not the committed prop", () => {
  assert.match(src, /const next = !shown;/);
  assert.match(src, /if \(next\) \{\s*params\.set\("hideAvailable", "1"\);/);
  assert.doesNotMatch(src, /if \(active\)/, "branching on the stale committed prop loses a second click");
});

test("the shown state tracks the pending target, like PillFilter", () => {
  assert.match(src, /useState<boolean \| null>\(null\)/);
  assert.match(src, /const shown = isPending && pendingValue !== null \? pendingValue : active;/);
  assert.match(src, /setPendingValue\(next\);\s*startTransition\(/);
  // The page reset and the busy marker stay.
  assert.match(src, /params\.delete\("page"\)/);
  assert.match(src, /aria-busy=\{isPending \|\| undefined\}/);
});
