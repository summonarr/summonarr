// Postgres resolves an unquoted GROUP BY name to an INPUT column before an output
// alias. `SELECT <expr> AS device ... GROUP BY device` therefore groups by the raw
// "device" column and never by <expr>: the bucketing CASE / COALESCE is defeated
// (resolution "720"/"720p" stayed split, NULL and '' devices gave two 'Unknown'
// rows). Group by ordinal (or the quoted column) instead.
import { test } from "node:test";
import assert from "node:assert/strict";
import { playHistorySource } from "./_play-history-source.mts";

// PlayHistory columns that the stats queries also use as SELECT aliases.
const COLUMNS = ["resolution", "container", "device", "player", "platform", "title", "source", "location", "year"];

test("the play-history modules never group by an unquoted name that is also a PlayHistory column", () => {
  const src = playHistorySource();
  const bad = [...src.matchAll(/GROUP BY\s+([a-zA-Z_]+)\b/g)].filter((m) => COLUMNS.includes(m[1]));
  assert.deepEqual(bad.map((m) => m[0]), []);
});

// A zero-runtime play has no completion percentage; counting it as 0% drags the
// title's average down. The AVG must skip it (NULL), not fold it in as 0.
test("the per-title average completion treats a zero-duration play as NULL, not 0%", () => {
  const src = playHistorySource();
  const m = src.match(/SELECT AVG\(\s*CASE WHEN "duration" > 0 THEN [^]*?END\s*\)::float8 AS avg_pct/);
  assert.ok(m, "avg_pct query not found");
  assert.match(m[0], /ELSE NULL END/);
  assert.doesNotMatch(m[0], /ELSE 0 END/);
});
