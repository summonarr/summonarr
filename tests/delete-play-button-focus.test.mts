// The play-history Delete control swaps its trigger <button> for a confirm row
// (and back on Cancel), so the focused element leaves the tree and keyboard
// focus falls to the page body. Structural pin (the runner can't render .tsx):
// focus moves into the confirm row's Cancel when it opens — never onto the
// destructive Delete — and back to the trigger after Cancel, only on a step
// the user took (never on mount).
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const src = readFileSync(new URL("../src/components/admin/delete-play-button.tsx", import.meta.url), "utf8");

test("opening the confirm focuses Cancel, and Cancel hands focus back to the trigger", () => {
  assert.match(src, /useEffect\(\(\) => \{\n\s+if \(!stepped\.current\) return;\n\s+\(confirming \? cancelRef : triggerRef\)\.current\?\.focus\(\);\n\s+\}, \[confirming\]\);/);
  assert.match(src, /<button\n\s+ref=\{triggerRef\}\n\s+onClick=\{\(\) => step\(true\)\}/, "the trigger opens the confirm through step()");
  assert.match(src, /<button\n\s+ref=\{cancelRef\}\n\s+onClick=\{\(\) => step\(false\)\}/, "Cancel closes it through step()");
  assert.doesNotMatch(src, /setConfirming\((true|false)\)\}/, "no step skips the focus hand-off");
  assert.doesNotMatch(src, /autoFocus/, "focus never lands on mount");
});
