// /admin/stats' stacked monthly columns (src/components/admin/stats/month-columns.ts).
import { test } from "node:test";
import assert from "node:assert/strict";
import { monthColumns } from "../src/components/admin/stats/month-columns.ts";

test("each column's height is against the busiest month, with a sliver for an empty one", () => {
  const cols = monthColumns(["2026-07", "2026-08", "2026-09"], [
    { key: "a", label: "A", color: "red", values: [10, 0, 1] },
    { key: "b", label: "B", color: "blue", values: [10] },
  ], "2026-09");
  assert.deepEqual(cols.map((c) => c.total), [20, 0, 1]);
  assert.deepEqual(cols.map((c) => c.heightPct), [100, 1, 5]);
  assert.deepEqual(cols.map((c) => c.partial), [false, false, true]);
  assert.deepEqual(cols[0].segments, [{ key: "a", color: "red", pct: 50 }, { key: "b", color: "blue", pct: 50 }]);
  assert.deepEqual(cols[1].segments, [], "a series with nothing that month draws nothing");
});

test("a month with anything is at least 2% tall; the year shows on the first column and every January", () => {
  const cols = monthColumns(["2025-12", "2026-01", "2026-02"], [{ key: "a", label: "A", color: "red", values: [1000, 1, 0] }], "2026-03");
  assert.equal(cols[1].heightPct, 2);
  assert.deepEqual(cols.map((c) => c.showYear), [true, true, false]);
  assert.equal(monthColumns([], [], "2026-01").length, 0);
});
