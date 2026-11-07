// PaginationBar's numbered window (src/lib/pager-window.ts).
//
// A current page past the last one — a stale bookmark, a list that shrank under
// the reader — used to build the window around the requested page: with
// ?page=9 of 5, start=7 > end=5 rendered no numbers at all and Previous pointed
// at page 8, another empty page. Past the end the window now sits on the last
// page, Previous goes there, and no page is marked current.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const { pagerWindow } = await import("../src/lib/pager-window.ts");

test("past the end: the window ends at the last page, Previous goes to it, nothing is current", () => {
  const w = pagerWindow(9, 5);
  assert.deepEqual(w.pages, [3, 4, 5]);
  assert.equal(w.end, 5);
  assert.equal(w.prev, 5, "Previous must lead back to a page that exists");
  assert.equal(w.next, null);
  assert.equal(w.active, null, "the requested page is not on the bar, so nothing is marked current");
  assert.equal(w.anchor, 5);
});

test("in range: the ±2 window, prev/next and the current page are unchanged", () => {
  assert.deepEqual(pagerWindow(1, 10), { anchor: 1, start: 1, end: 3, pages: [1, 2, 3], prev: null, next: 2, active: 1 });
  assert.deepEqual(pagerWindow(5, 10), { anchor: 5, start: 3, end: 7, pages: [3, 4, 5, 6, 7], prev: 4, next: 6, active: 5 });
  assert.deepEqual(pagerWindow(10, 10), { anchor: 10, start: 8, end: 10, pages: [8, 9, 10], prev: 9, next: null, active: 10 });
  assert.deepEqual(pagerWindow(2, 2), { anchor: 2, start: 1, end: 2, pages: [1, 2], prev: 1, next: null, active: 2 });
});

test("PaginationBar draws from the window rather than its own arithmetic", () => {
  const bar = readFileSync(new URL("../src/components/media/pagination-bar.tsx", import.meta.url), "utf8");
  assert.match(bar, /pagerWindow\(currentPage, totalPages\)/);
  assert.match(bar, /p === active \?/, "the current marker follows the window's `active`");
  assert.match(bar, /prev !== null \? buildHref\(prev\)/);
  assert.doesNotMatch(bar, /currentPage - 1|currentPage \+ 1/, "no Previous/Next built from the unclamped page");
});
