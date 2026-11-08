// Admin → Missing's selection arithmetic (src/components/admin/bulk-selection.ts):
// the cap counts every ticked row of the list — on another page or hidden by a
// filter — and the header box ticks only as far as the cap leaves room.
import { test } from "node:test";
import assert from "node:assert/strict";
import { listSelection, pageSelection } from "../src/components/admin/bulk-selection.ts";
import { BULK_SEARCH_MAX } from "../src/lib/bulk-search-run.ts";

type Row = { instance: string; arrId: number };
const rows = (from: number, n: number): Row[] => Array.from({ length: n }, (_, i) => ({ instance: "", arrId: from + i }));
const selKey = (r: Row) => `radarr:missing|${r.instance}:${r.arrId}`;
const rules = (selected: Row[], closed: Row[] = []) => {
  const closedKeys = new Set(closed.map(selKey));
  return { selected: new Set(selected.map(selKey)), selKey, isOpen: (r: Row) => !closedKeys.has(selKey(r)) };
};

test("the selection is the listed ticks in order, then the hidden ones; a closed row never counts", () => {
  const listed = rows(1, 5);
  const hiddenRow = { instance: "", arrId: 99 };
  const report = [...listed, hiddenRow];
  const list = listSelection(listed, report, rules([listed[3], listed[1], hiddenRow, listed[0]], [listed[0]]));
  assert.deepEqual(list.selectedHere.map((r) => r.arrId), [2, 4, 99]);
  assert.deepEqual(list.selectedHidden.map((r) => r.arrId), [99]);
  assert.equal(list.atCap, false);
});

test("the cap counts ticks on other pages and hidden ones, and the run takes at most the cap", () => {
  const listed = rows(1, BULK_SEARCH_MAX + 20);
  const list = listSelection(listed, listed, rules(listed));
  assert.equal(list.atCap, true);
  assert.equal(list.toRun.length, BULK_SEARCH_MAX);
  assert.deepEqual(list.toRun[0], listed[0], "in the order shown");
});

test("select-all on a page leaves room for the ticks elsewhere, and 'all selected' means as many as the room allows", () => {
  const listed = rows(1, 150);
  const page = listed.slice(0, 50);
  // 70 ticked on other pages, 20 hidden by the filters: 10 left for this page.
  const hidden = rows(1000, 20);
  const ticked = [...listed.slice(80, 150), ...hidden];
  let list = listSelection(listed, [...listed, ...hidden], rules(ticked));
  let view = pageSelection(list, page, rules(ticked));
  assert.equal(view.selectedOffPage, 70);
  assert.equal(view.roomOnPage, BULK_SEARCH_MAX - 70 - 20);
  assert.equal(view.allSelected, false);
  // Ticking the room's worth on this page is "all selected" for this page.
  const withPage = [...ticked, ...page.slice(0, view.roomOnPage)];
  list = listSelection(listed, [...listed, ...hidden], rules(withPage));
  view = pageSelection(list, page, rules(withPage));
  assert.equal(view.allSelected, true);
  assert.equal(list.selectedHere.length, BULK_SEARCH_MAX);
});

test("a page whose rows are all closed is never 'all selected', and the header works on the open rows only", () => {
  const page = rows(1, 3);
  const r = rules(page, page);
  const view = pageSelection(listSelection(page, page, r), page, r);
  assert.equal(view.selectable.length, 0);
  assert.equal(view.allSelected, false);
  assert.equal(view.shownKeys.size, 3);
});

test("the bulk hook says whether a run is going through a function, read live", async () => {
  const { readFileSync } = await import("node:fs");
  const hook = readFileSync(new URL("../src/components/admin/use-bulk-search.ts", import.meta.url), "utf8");
  assert.match(hook, /const isBulkRunning = useCallback\(\(\) => bulkAbort\.current !== null, \[\]\);/);
  assert.match(hook, /return \{[\s\S]*?\bisBulkRunning,/);
});
