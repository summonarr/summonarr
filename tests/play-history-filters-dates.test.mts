import { test } from "node:test";
import assert from "node:assert/strict";
import { parsePlayHistoryFilters, composeWhere } from "../src/lib/play-history-filters.ts";

test("an unparseable startDate/endDate is ignored, not bound as an Invalid Date", () => {
  const f = parsePlayHistoryFilters(new URLSearchParams({ startDate: "not-a-date", endDate: "garbage" }));
  assert.equal(f.length, 0);
});

test("valid dates still bind in order", () => {
  const f = parsePlayHistoryFilters(new URLSearchParams({ startDate: "2026-01-01", endDate: "2026-02-01" }));
  const { whereSql, binds } = composeWhere(f);
  assert.match(whereSql, /"startedAt" >= \$1 AND h\."startedAt" <= \$2/);
  assert.equal(binds.length, 2);
  assert.ok(binds.every((b) => b instanceof Date && !isNaN(b.getTime())));
});
