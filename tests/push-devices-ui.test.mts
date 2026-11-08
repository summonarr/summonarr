// Profile → push devices (src/components/profile/push-devices.tsx) is a .tsx
// client component the unit loader can't render, so its wiring is pinned by a
// structural scan.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const src = readFileSync(new URL("../src/components/profile/push-devices.tsx", import.meta.url), "utf8");

// The busy flag cleared as soon as router.refresh() was called, so the removed
// row came back with a live trash button until the refreshed list arrived.
test("a removed device stays hidden while the page refreshes, and each row has its own busy state", () => {
  const remove = src.slice(src.indexOf("async function remove("), src.indexOf("const visible ="));
  const hide = remove.indexOf("setRemoved((prev) => new Set(prev).add(id));");
  assert.ok(hide > 0 && hide < remove.indexOf("router.refresh();"), "hidden before the refresh starts");
  assert.match(src, /const visible = devices\.filter\(\(d\) => !removed\.has\(d\.id\)\);/);
  assert.match(src, /\{visible\.map\(\(device, i\) =>/);
  assert.doesNotMatch(src, /\{devices\.map\(/);
  assert.match(remove, /action\.run\(\s*`remove:\$\{id\}`/);
  assert.match(remove, /\{ ifBusy: "skip" \}/);
});
