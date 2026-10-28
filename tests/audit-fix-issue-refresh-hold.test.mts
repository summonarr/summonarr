// The issue dialogs' hold on the page's live refresh (src/lib/client/refresh-hold.ts).
//
// Why: Replace file / Replace release flip the issue to IN_PROGRESS and
// announce it over SSE BEFORE the work. LiveRefresh's router.refresh() then
// dropped the issue from the OPEN tab's list, and below xl the open dialog —
// with its result, the "may stay unmonitored" warning, a 410/409 refusal —
// was unmounted mid-request. A dialog now holds the refresh until it closes.
//
// One refresh per click: an issue button refreshed the page itself AND the
// change it made was announced over SSE, so LiveRefresh refreshed it again
// ~500 ms later — two full server renders per click. Both now go through
// requestPageRefresh, one debounced timer for the page.
//
// Also pinned structurally (no .tsx harness): LiveRefresh refreshes through
// requestPageRefresh, the Fix file window takes a hold released by an effect
// cleanup, its own post-success refreshes go through the shared timer, the
// issue page's buttons never call a bare router.refresh(), and the window
// renders a refused grab INSIDE itself with a Search again.
import { test, mock } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const { holdLiveRefresh, runOrDefer, requestPageRefresh, cancelPageRefresh, PAGE_REFRESH_DEBOUNCE_MS } = await import("../src/lib/client/refresh-hold.ts");
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

test("a click and the live event announcing it make ONE refresh", () => {
  mock.timers.enable({ apis: ["setTimeout"] });
  try {
    let runs = 0;
    requestPageRefresh(() => { runs++; }); // the button's own request
    mock.timers.tick(PAGE_REFRESH_DEBOUNCE_MS - 100);
    requestPageRefresh(() => { runs++; }); // the SSE event, a moment later
    mock.timers.tick(PAGE_REFRESH_DEBOUNCE_MS - 1);
    assert.equal(runs, 0, "each request restarts the wait");
    mock.timers.tick(1);
    assert.equal(runs, 1, "one refresh for the burst");
    mock.timers.tick(PAGE_REFRESH_DEBOUNCE_MS * 4);
    assert.equal(runs, 1, "nothing left behind");
    requestPageRefresh(() => { runs++; });
    mock.timers.tick(PAGE_REFRESH_DEBOUNCE_MS);
    assert.equal(runs, 2, "a later change refreshes again");
  } finally {
    mock.timers.reset();
  }
});

test("the shared refresh waits for an open dialog, and a cancel drops it", () => {
  mock.timers.enable({ apis: ["setTimeout"] });
  try {
    let runs = 0;
    const release = holdLiveRefresh();
    requestPageRefresh(() => { runs++; });
    mock.timers.tick(PAGE_REFRESH_DEBOUNCE_MS);
    assert.equal(runs, 0, "held while the dialog is open");
    release();
    assert.equal(runs, 1, "runs once the dialog closes");

    requestPageRefresh(() => { runs++; });
    cancelPageRefresh();
    mock.timers.tick(PAGE_REFRESH_DEBOUNCE_MS * 2);
    assert.equal(runs, 1, "the page went away: nothing runs");
  } finally {
    mock.timers.reset();
  }
});

test("structural: LiveRefresh refreshes through the shared timer, never its own", () => {
  const src = read("src/components/live-refresh.tsx");
  assert.match(src, /requestPageRefresh\(\(\) => router\.refresh\(\)\);/);
  assert.match(src, /useEffect\(\(\) => \(\) => cancelPageRefresh\(\), \[\]\);/);
  assert.doesNotMatch(src, /setTimeout\(/, "no private debounce timer");
  assert.doesNotMatch(src, /\n\s*router\.refresh\(\);/, "no bare refresh");
});

test("structural: the issue page's buttons refresh only through the shared timer", () => {
  for (const file of [
    "src/components/admin/issue-actions.tsx",
    "src/components/admin/issue-claim-button.tsx",
    "src/components/admin/issue-fix-match-button.tsx",
  ]) {
    const src = read(file);
    const bare = src.match(/(?<!=> )router\.refresh\(\)/g) ?? [];
    assert.deepEqual(bare, [], `${file}: every refresh is requestPageRefresh(() => router.refresh())`);
    assert.match(src, /requestPageRefresh\(\(\) => router\.refresh\(\)\)/, file);
  }
});

test("structural: the Fix file window holds the refresh while open, and its writes refresh through the shared timer", () => {
  const src = read("src/components/admin/issue-actions.tsx");
  const dialog = src.slice(src.indexOf("function FixFileDialog("));
  assert.ok(src.includes("function FixFileDialog("));
  assert.match(dialog, /useEffect\(\(\) => holdLiveRefresh\(\), \[\]\);/, "released on unmount");
  // Each function cut at its own closing brace, never a fixed window.
  const grab = functionBody(dialog, "async function grabRelease(");
  assert.match(grab, /setGrabOk\(true\);[\s\S]*?requestPageRefresh\(\(\) => router\.refresh\(\)\)/);
  const search = functionBody(dialog, "async function searchNow(");
  assert.match(search, /setSearched\(true\);[\s\S]*?requestPageRefresh\(\(\) => router\.refresh\(\)\)/);
  const replaceFn = functionBody(dialog, "async function replace(");
  assert.match(replaceFn, /void load\(instance\);\s*\}\s*$/, "the cut reaches the function's own tail");
  assert.match(replaceFn, /setSelected\(new Set\(\)\);\s*\/\/[^\n]*\n\s*requestPageRefresh\(\(\) => router\.refresh\(\)\);/);
});

test("structural: a refused grab is shown INSIDE the Fix file window, with Search again", () => {
  const src = read("src/components/admin/issue-actions.tsx");
  const dialog = src.slice(src.indexOf("function FixFileDialog("));
  assert.match(dialog, /\{releaseError && \(\s*<div role="alert"/, "the error renders inside the window");
  assert.match(dialog, /onClick=\{\(\) => void loadReleases\(instance\)\}\s*disabled=\{working\}/, "Search again, disabled during a write");
  assert.match(dialog, /t\("adminQueue\.issueActions\.searchAgain"\)/);
});
