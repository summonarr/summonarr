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
const hook = readFileSync(new URL("../src/components/media/use-pending-search-param.ts", import.meta.url), "utf8");
const pill = readFileSync(new URL("../src/components/media/pill-filter.tsx", import.meta.url), "utf8");

test("the toggle's next state is derived from what is shown, not the committed prop", () => {
  assert.match(src, /const pressed = shown === "1";/);
  assert.match(src, /set\(pressed \? undefined : "1"\);/);
  assert.doesNotMatch(src, /if \(active\)/, "branching on the stale committed prop loses a second click");
});

test("the shown state tracks the pending target in one hook shared with PillFilter", () => {
  assert.match(hook, /const shown = isPending && pendingValue \? pendingValue\.v : active;/);
  assert.match(hook, /setPendingValue\(\{ v: value \}\);\s*startTransition\(/);
  for (const [name, body] of [["toggle", src], ["pill", pill]] as const) {
    assert.match(body, /usePendingSearchParam/, name);
    assert.doesNotMatch(body, /startTransition|router\.push/, `${name}: a private copy of the navigation`);
  }
  // The page reset and the busy marker stay.
  assert.match(hook, /nextPendingQuery\(pathname, committed, param, value\)/);
  assert.match(readFileSync(new URL("../src/lib/client/pending-query.ts", import.meta.url), "utf8"), /page: undefined/);
  assert.match(src, /aria-busy=\{isPending \|\| undefined\}/);
});
