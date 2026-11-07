// Unit tests for the duration formatters (src/lib/format-duration.ts). They
// were unified from same-named local helpers with INCOMPATIBLE units (ms vs
// seconds); the distinct names + these pins keep them from re-merging. Pure.
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  formatDurationHM,
  formatDurationMsLocalized,
} from "../src/lib/format-duration.ts";

// formatDurationHM is the LOCALIZED twin the personal watch pages use. The en
// pins keep it byte-identical to the `${h}h ${m}m` copies it replaced; the de
// pins are what fail if someone "simplifies" it back to hardcoded English.
test("formatDurationHM (en): h/m above an hour, m under, s under a minute, em-dash otherwise", () => {
  assert.equal(formatDurationHM(0, "en"), "—");
  assert.equal(formatDurationHM(-10, "en"), "—");
  assert.equal(formatDurationHM(Number.NaN, "en"), "—");
  assert.equal(formatDurationHM(45, "en"), "45s");
  assert.equal(formatDurationHM(59.6, "en"), "60s");
  assert.equal(formatDurationHM(60, "en"), "1m");
  assert.equal(formatDurationHM(900, "en"), "15m");
  assert.equal(formatDurationHM(3600, "en"), "1h 0m");
  assert.equal(formatDurationHM(7325, "en"), "2h 2m");
});

test("formatDurationHM (de): units come from Intl's narrow style, not English abbreviations", () => {
  assert.equal(formatDurationHM(8100, "de"), "2h 15 Min.");
  assert.equal(formatDurationHM(900, "de"), "15 Min.");
  assert.equal(formatDurationHM(45, "de"), "45 Sek.");
  assert.equal(formatDurationHM(0, "de"), "—");
});

test("formatDurationHM: a locale tag Intl rejects falls back to h/m/s instead of throwing", () => {
  // Intl.NumberFormat throws RangeError on a malformed BCP 47 tag.
  assert.throws(() => new Intl.NumberFormat("not a locale!!"), RangeError);
  assert.equal(formatDurationHM(7325, "not a locale!!"), "2h 2m");
  assert.equal(formatDurationHM(900, "not a locale!!"), "15m");
  assert.equal(formatDurationHM(45, "not a locale!!"), "45s");
});

test("the two formatters read the same number differently (units are not interchangeable)", () => {
  // 1500 is "1.5s" as ms, but "25m" as seconds — the exact confusion the split prevents.
  assert.equal(formatDurationMsLocalized(1500, "en"), "1.5s");
  assert.equal(formatDurationHM(1500, "en"), "25m");
});

test("formatDurationMsLocalized: localized units, one-decimal seconds, ms under a second", () => {
  assert.equal(formatDurationMsLocalized(170_660, "en"), "170.7s");
  assert.equal(formatDurationMsLocalized(420, "en"), "420ms");
  assert.equal(formatDurationMsLocalized(-1, "en"), "—");
  assert.equal(formatDurationMsLocalized(Number.NaN, "en"), "—");
  assert.equal(formatDurationMsLocalized(999, "en"), "999ms");
  // de uses a comma decimal and its own narrow unit — the point of the twin.
  const de = formatDurationMsLocalized(170_660, "de");
  assert.match(de, /170,7/);
  assert.notEqual(de, "170.7s");
});

test("formatDurationMsLocalized: a value that ROUNDS to a full second reads as seconds, never 1,000 ms", () => {
  assert.equal(formatDurationMsLocalized(999.6, "en"), formatDurationMsLocalized(1000, "en"));
  assert.equal(formatDurationMsLocalized(999.6, "en"), "1s");
  assert.equal(formatDurationMsLocalized(999.6, "not a locale!!"), "1.0s");
  assert.equal(formatDurationMsLocalized(999.4, "en"), "999ms");
});
