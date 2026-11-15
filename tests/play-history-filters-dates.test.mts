import { test } from "node:test";
import assert from "node:assert/strict";
import { parsePlayHistoryFilters, composeWhere } from "../src/lib/play-history-filters.ts";

test("an unparseable startDate/endDate is ignored, not bound as an Invalid Date", () => {
  const f = parsePlayHistoryFilters(new URLSearchParams({ startDate: "not-a-date", endDate: "garbage" }), "UTC");
  assert.equal(f.length, 0);
});

test("valid dates still bind in order", () => {
  const f = parsePlayHistoryFilters(new URLSearchParams({ startDate: "2026-01-01", endDate: "2026-02-01" }), "UTC");
  const { whereSql, binds } = composeWhere(f);
  assert.match(whereSql, /"startedAt" >= \$1 AND h\."startedAt" <= \$2/);
  assert.equal(binds.length, 2);
  assert.ok(binds.every((b) => b instanceof Date && !isNaN(b.getTime())));
});

test("tmdbId filter accepts only a canonical in-range integer", async () => {
  const { normalizePlayHistoryFilters } = await import("../src/lib/play-history-filters.ts");
  const at = (v: string) => normalizePlayHistoryFilters(new URLSearchParams({ tmdbId: v }), "UTC").tmdbId;
  assert.equal(at("550"), 550);
  assert.equal(at("12abc"), null);
  assert.equal(at("1.5"), null);
  assert.equal(at("99999999999"), null);
  assert.equal(at("0"), null);
});
