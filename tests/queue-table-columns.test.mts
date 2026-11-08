// Admin → Download Queue's column picker (queue-table.tsx, useHiddenColumns).
// The unit loader can't render the .tsx hook, so this is structural: a toggle
// builds its next set from the LATEST state (a functional update), never the
// set the render closed over — two toggles before a re-render both land — and
// the stored copy follows every change.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const src = readFileSync(new URL("../src/components/admin/queue-table.tsx", import.meta.url), "utf8");

test("toggleColumn updates from the latest hidden set and stores what it set", () => {
  const at = src.indexOf("function toggleColumn(");
  assert.ok(at >= 0);
  const body = src.slice(at, src.indexOf("\n  }\n", at));
  assert.match(body, /setHidden\(\(prev\) => \{\s*const next = new Set\(prev\);/);
  assert.match(body, /persistHidden\(next\);\s*return next;/);
  assert.doesNotMatch(body, /new Set\(hidden\)/, "never the closed-over set");
  assert.match(src, /function saveHidden\(next: ReadonlySet<ColumnId>\) \{\s*setHidden\(next\);\s*persistHidden\(next\);/);
});
