// Postgres resolves an unquoted GROUP BY name to an INPUT column before an output
// alias. `SELECT <expr> AS device ... GROUP BY device` therefore groups by the raw
// "device" column and never by <expr>: the bucketing CASE / COALESCE is defeated
// (resolution "720"/"720p" stayed split, NULL and '' devices gave two 'Unknown'
// rows). Group by ordinal (or the quoted column) instead.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(fileURLToPath(import.meta.url), "../..");
// PlayHistory columns that the stats queries also use as SELECT aliases.
const COLUMNS = ["resolution", "container", "device", "player", "platform", "title", "source", "location", "year"];

test("play-history.ts never groups by an unquoted name that is also a PlayHistory column", () => {
  const src = readFileSync(resolve(ROOT, "src/lib/play-history.ts"), "utf8");
  const bad = [...src.matchAll(/GROUP BY\s+([a-zA-Z_]+)\b/g)].filter((m) => COLUMNS.includes(m[1]));
  assert.deepEqual(bad.map((m) => m[0]), []);
});
