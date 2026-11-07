// Admin → Missing's dates (src/components/admin/missing-format.ts). A release
// date is a calendar day the arr stores as midnight UTC and is shown on that
// UTC day everywhere; an air time is a real instant and is shown in the
// viewer's own zone — formatted in UTC, an episode airing at 21:00 in New York
// (02:00 UTC the next day) showed the next day.
import { test } from "node:test";
import assert from "node:assert/strict";

const { missingDateFormatters } = await import("../src/components/admin/missing-format.ts");

test("an air time is the viewer's local day; a release date stays on its UTC day", () => {
  const ny = missingDateFormatters("en-US", "America/New_York");
  assert.equal(ny.aired("2024-03-01T02:00:00.000Z"), "Feb 29, 2024", "21:00 in New York is still the 29th there");
  assert.equal(ny.day("2024-03-01T00:00:00.000Z"), "Mar 1, 2024", "a release day is not shifted to the 29th");
  const utc = missingDateFormatters("en-US", "UTC");
  assert.equal(utc.aired("2024-03-01T02:00:00.000Z"), "Mar 1, 2024");
  const tokyo = missingDateFormatters("en-US", "Asia/Tokyo");
  assert.equal(tokyo.day("2024-03-01T00:00:00.000Z"), "Mar 1, 2024");
  assert.equal(tokyo.aired("2024-02-29T20:00:00.000Z"), "Mar 1, 2024");
});

test("no date is a dash, in either form", () => {
  const f = missingDateFormatters("en-US", "UTC");
  assert.deepEqual([f.day(null), f.aired(null)], ["—", "—"]);
});

test("the page formats air times with `aired` and release dates with `day`", async () => {
  const { readFileSync } = await import("node:fs");
  const src = readFileSync(new URL("../src/components/admin/missing-report.tsx", import.meta.url), "utf8");
  assert.match(src, /aired\(s\.lastAired\)/);
  assert.match(src, /date: aired\(e\.airDateUtc\)/);
  assert.match(src, /day\(m\.physicalRelease\)/);
  assert.match(src, /day\(m\.digitalRelease\)/);
  assert.doesNotMatch(src, /\bday\([^)]*(lastAired|airDateUtc)\)/);
  assert.doesNotMatch(src, /timeZone: "UTC"/, "the page has no UTC formatter of its own");
});
