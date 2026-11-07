// The For You "Rebuild" button's reading of /api/cron/warm-recommendations.
// The route answers 200 + `error` when SOME users failed: the other shelves —
// usually the admin's own — were rebuilt, so that is a warning and the grid
// refreshes. Only `graphFailed` means nothing changed. A "use client" module
// Node cannot import, so the branch is pinned in its source (the
// detail-action-state.test.mts idiom).
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const src = readFileSync(new URL("../src/components/media/rebuild-recommendations-button.tsx", import.meta.url), "utf8");

// The body of the `if (<cond>) { … return; }` block that starts at `marker`.
function branchAfter(marker: string): string {
  const at = src.indexOf(marker);
  assert.ok(at >= 0, `branch not found: ${marker}`);
  const end = src.indexOf("return;", at);
  assert.ok(end > at);
  return src.slice(at, end);
}

test("a partial rebuild (200 + error, graph built) is a warning that still refreshes the grid", () => {
  const partial = branchAfter("if (res.ok && data.error && !data.graphFailed) {");
  assert.match(partial, /t\("browse\.forYou\.rebuild\.partial"/);
  assert.match(partial, /type: "warning"/);
  assert.match(partial, /router\.refresh\(\)/, "the rebuilt shelves must be shown");
});

test("the partial branch is checked BEFORE the error branch, which still never refreshes", () => {
  const partialAt = src.indexOf("if (res.ok && data.error && !data.graphFailed) {");
  const errorAt = src.indexOf("if (!res.ok || data.error) {");
  assert.ok(partialAt >= 0 && errorAt > partialAt, "a partial result would otherwise be read as a failure");
  const error = branchAfter("if (!res.ok || data.error) {");
  assert.doesNotMatch(error, /router\.refresh\(\)/, "a failed or graph-failed run changed nothing to show");
  assert.match(error, /type: "error"/);
});
