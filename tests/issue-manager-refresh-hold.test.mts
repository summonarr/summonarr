// The Issues page's title manager holds the page's live refresh.
//
// Why: the request list holds its refresh while a title manager is open
// (admin-request-list.tsx, pinned in arr-title-ui-state.test.mts), but
// the Issues page's Manage icons (IssueActions) didn't. The page refreshes on
// every issue event, and a row is keyed by its group's NEWEST report, so a
// duplicate report — or a status change that moves the issue off the tab —
// unmounted the row and the open manager with it, unsaved edits and all.
//
// Pinned: the real managerRefreshHolds (cut from issue-actions.tsx, types
// stripped) against the real refresh-hold.ts — an open manager defers the
// page's refresh, its close runs it once, a re-open never leaks a hold — and
// structurally, every Manage icon in IssueActions reports open/close through it.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { stripTypeScriptTypes } from "node:module";

const { holdLiveRefresh, runOrDefer } = await import("../src/lib/client/refresh-hold.ts");
const { functionBodyRange } = await import("./structural-pin-source-scan.mts");

const here = dirname(fileURLToPath(import.meta.url));
const SRC = readFileSync(join(here, "../src/components/admin/issue-actions.tsx"), "utf8");

type Holds = () => (slug: string, open: boolean) => void;
function loadManagerRefreshHolds(): Holds {
  const anchor = "function managerRefreshHolds(";
  const start = SRC.indexOf(anchor);
  assert.ok(start >= 0, "managerRefreshHolds is in issue-actions.tsx");
  const [, end] = functionBodyRange(SRC, anchor);
  const js = stripTypeScriptTypes(SRC.slice(start, end + 1));
  return new Function("holdLiveRefresh", `${js}\nreturn managerRefreshHolds;`)(holdLiveRefresh) as Holds;
}

test("an open title manager defers the page's refresh; its close runs it exactly once", () => {
  const onManagerActive = loadManagerRefreshHolds()();
  let runs = 0;
  onManagerActive("", true);
  runOrDefer(() => { runs++; });
  runOrDefer(() => { runs++; });
  assert.equal(runs, 0, "held while the manager is open");
  onManagerActive("", false);
  assert.equal(runs, 1, "the close runs the latest deferred refresh once");
  runOrDefer(() => { runs++; });
  assert.equal(runs, 2, "nothing held after the close");
});

test("two holders: the refresh waits for the LAST manager to close; a repeated open never leaks a hold", () => {
  const onManagerActive = loadManagerRefreshHolds()();
  let runs = 0;
  onManagerActive("", true);
  onManagerActive("4k", true);
  onManagerActive("4k", true); // a second open report for one button replaces its hold
  runOrDefer(() => { runs++; });
  onManagerActive("", false);
  assert.equal(runs, 0, "the 4K manager is still open");
  onManagerActive("4k", false);
  assert.equal(runs, 1);
  onManagerActive("4k", false); // an unmatched close releases nothing twice
  runOrDefer(() => { runs++; });
  assert.equal(runs, 2, "no hold left behind");
});

test("structural: every Manage icon in IssueActions reports open/close to one per-component hold set", () => {
  assert.match(
    SRC,
    /const \[onManagerActive\] = useState<\(slug: string, open: boolean\) => void>\(managerRefreshHolds\);/,
    "one hold set for the component's lifetime",
  );
  const at = SRC.indexOf("<ManageTitleButton", SRC.indexOf("export function IssueActions("));
  assert.ok(at > 0, "IssueActions renders ManageTitleButton");
  const button = SRC.slice(at, SRC.indexOf("/>", at));
  assert.match(button, /key=\{h\.slug\}/);
  assert.match(button, /onActiveChange=\{\(open\) => onManagerActive\(h\.slug, open\)\}/);
  assert.equal(SRC.match(/<ManageTitleButton/g)?.length, 1, "no other Manage icon without the hold");
});
