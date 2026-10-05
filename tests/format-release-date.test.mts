// formatReleaseDate renders a date-only string on the day it names, in any
// server timezone (the detail pages used to print the previous day west of UTC).
import { test } from "node:test";
import assert from "node:assert/strict";
import { formatReleaseDate } from "../src/lib/format-release-date.ts";

test("a date-only value renders its own calendar day regardless of the process TZ", () => {
  const prev = process.env.TZ;
  try {
    for (const tz of ["America/Los_Angeles", "UTC", "Asia/Tokyo"]) {
      process.env.TZ = tz;
      assert.equal(formatReleaseDate("2024-05-01"), "May 1, 2024", tz);
      // TMDB's release_dates carry a UTC-midnight timestamp — same day.
      assert.equal(formatReleaseDate("2024-05-01T00:00:00.000Z"), "May 1, 2024", tz);
    }
  } finally {
    if (prev === undefined) delete process.env.TZ;
    else process.env.TZ = prev;
  }
});

test("missing or unparseable values are dropped, never 'Invalid Date'", () => {
  assert.equal(formatReleaseDate(null), null);
  assert.equal(formatReleaseDate(undefined), null);
  assert.equal(formatReleaseDate(""), null);
  assert.equal(formatReleaseDate("not a date"), null);
});
