// The issue dialogs' hold on the page's live refresh (src/lib/client/refresh-hold.ts).
//
// Why: Replace file / Replace release flip the issue to IN_PROGRESS and
// announce it over SSE BEFORE the work. LiveRefresh's router.refresh() then
// dropped the issue from the OPEN tab's list, and below xl the open dialog —
// with its result, the "may stay unmonitored" warning, a 410/409 refusal —
// was unmounted mid-request. A dialog now holds the refresh until it closes.
//
// Also pinned structurally (no .tsx harness): LiveRefresh refreshes through
// runOrDefer, both dialogs take a hold released by an effect cleanup, their
// own post-success refreshes are deferred, and the Replace-release dialog
// renders a refused grab INSIDE itself (the column copy sits under the
// dialog's backdrop) with a Search again that re-runs the search.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const { holdLiveRefresh, runOrDefer } = await import("../src/lib/client/refresh-hold.ts");
const { functionBody } = await import("./audit-fix2-R8b-tests-vacuous-source.mts");

const here = dirname(fileURLToPath(import.meta.url));
const read = (p: string) => readFileSync(join(here, "..", p), "utf8");

test("no hold: a refresh runs at once", () => {
  let runs = 0;
  runOrDefer(() => { runs++; });
  assert.equal(runs, 1);
});

test("while held a refresh waits, and the release runs it exactly once", () => {
  let runs = 0;
  const release = holdLiveRefresh();
  runOrDefer(() => { runs++; });
  runOrDefer(() => { runs++; });
  assert.equal(runs, 0, "deferred while the dialog is open");
  release();
  assert.equal(runs, 1, "the latest pending refresh, once");
  release();
  assert.equal(runs, 1, "a second release is a no-op");
});

test("two holds: the refresh runs only after BOTH release; a double release never drives the count negative", () => {
  let runs = 0;
  const a = holdLiveRefresh();
  const b = holdLiveRefresh();
  runOrDefer(() => { runs++; });
  a();
  a();
  assert.equal(runs, 0, "b still holds — a's double release must not count as b's");
  b();
  assert.equal(runs, 1);
  // Count back at zero: the next refresh runs at once, nothing left pending.
  runOrDefer(() => { runs++; });
  assert.equal(runs, 2);
});

test("a release with nothing pending runs nothing", () => {
  let runs = 0;
  const release = holdLiveRefresh();
  release();
  assert.equal(runs, 0);
  runOrDefer(() => { runs++; });
  assert.equal(runs, 1);
});

test("structural: LiveRefresh refreshes through runOrDefer, never a bare router.refresh in its timer", () => {
  const src = read("src/components/live-refresh.tsx");
  assert.match(src, /setTimeout\(\(\) => runOrDefer\(\(\) => router\.refresh\(\)\), 500\)/);
  assert.doesNotMatch(src, /setTimeout\(\(\) => router\.refresh\(\)/);
});

test("structural: both issue dialogs hold the refresh while open and defer their own post-success refresh", () => {
  const src = read("src/components/admin/issue-actions.tsx");
  assert.match(src, /useEffect\(\(\) => \(panel === "replace" \? holdLiveRefresh\(\) : undefined\), \[panel\]\);/, "the Replace-release dialog");
  const dialog = src.slice(src.indexOf("function ReplaceFileDialog("));
  assert.ok(dialog.length > 0);
  assert.match(dialog, /useEffect\(\(\) => holdLiveRefresh\(\), \[\]\);/, "ReplaceFileDialog — released on unmount");
  // Each function cut at its own closing brace, never a fixed window: a
  // window stops short as the function grows (the tail goes unchecked) or
  // runs into the next function (a match there is not this function's).
  const grab = functionBody(src, "async function grabRelease(");
  assert.match(grab, /setGrabOk\(true\);[\s\S]*?runOrDefer\(\(\) => router\.refresh\(\)\)/);
  assert.doesNotMatch(grab, /\n\s*router\.refresh\(\);/, "no bare refresh after a grab");
  const replaceFn = functionBody(dialog, "async function replace(");
  assert.match(replaceFn, /void load\(instance\);\s*\}\s*$/, "the cut reaches the function's own tail");
  assert.match(replaceFn, /setSelected\(new Set\(\)\);\s*\/\/[^\n]*\n\s*runOrDefer\(\(\) => router\.refresh\(\)\);/);
  assert.doesNotMatch(replaceFn, /\n\s*router\.refresh\(\);/, "no bare refresh under the result");
});

test("structural: a refused grab is shown INSIDE the Replace-release dialog, with Search again", () => {
  const src = read("src/components/admin/issue-actions.tsx");
  const open = src.indexOf('<Dialog open={panel === "replace"}');
  const close = src.indexOf("</Dialog>", open);
  assert.ok(open > 0 && close > open);
  const popup = src.slice(open, close);
  assert.match(popup, /\{arrError && \(\s*<div role="alert"/, "the error renders inside the dialog");
  assert.match(popup, /onClick=\{\(\) => void loadReleases\(instance\)\}\s*disabled=\{loading !== null\}/, "Search again, disabled during a grab");
  assert.match(popup, /t\("adminQueue\.issueActions\.searchAgain"\)/);
  // The column copy is not drawn a second time under the backdrop.
  assert.match(src.slice(close), /\{arrError && panel !== "replace" && \(/);
});
