// The detail pages' Digital / Physical dates come from TMDB release types 4/5,
// preferring the US (the region of the certification and watch providers) and
// falling back to the earliest date anywhere.
import { test } from "node:test";
import assert from "node:assert/strict";
import { extractHomeReleaseDates } from "../src/lib/home-release-dates.ts";

const rd = (type: number, release_date: string) => ({ type, release_date });

test("the US date wins over an earlier date elsewhere", () => {
  const out = extractHomeReleaseDates({
    results: [
      { iso_3166_1: "GB", release_dates: [rd(4, "2024-01-10T00:00:00.000Z"), rd(5, "2024-02-01T00:00:00.000Z")] },
      { iso_3166_1: "US", release_dates: [rd(4, "2024-03-05T00:00:00.000Z"), rd(5, "2024-04-09T00:00:00.000Z")] },
    ],
  });
  assert.deepEqual(out, { digital: "2024-03-05", physical: "2024-04-09" });
});

test("a type the US lacks falls back to the earliest date of that type in any region", () => {
  const out = extractHomeReleaseDates({
    results: [
      { iso_3166_1: "US", release_dates: [rd(4, "2024-03-05T00:00:00.000Z")] },
      { iso_3166_1: "DE", release_dates: [rd(5, "2024-06-01T00:00:00.000Z")] },
      { iso_3166_1: "FR", release_dates: [rd(5, "2024-05-20T00:00:00.000Z")] },
    ],
  });
  assert.deepEqual(out, { digital: "2024-03-05", physical: "2024-05-20" });
});

test("the earliest of several US entries of one type is used", () => {
  const out = extractHomeReleaseDates({
    results: [{ iso_3166_1: "US", release_dates: [rd(4, "2024-09-01T00:00:00.000Z"), rd(4, "2024-08-15T00:00:00.000Z")] }],
  });
  assert.equal(out.digital, "2024-08-15");
});

test("theatrical, premiere and TV types never count as a home release", () => {
  const out = extractHomeReleaseDates({
    results: [{ iso_3166_1: "US", release_dates: [rd(1, "2024-01-01"), rd(2, "2024-01-02"), rd(3, "2024-01-03"), rd(6, "2024-01-06")] }],
  });
  assert.deepEqual(out, { digital: null, physical: null });
});

test("missing or malformed input yields nulls, never a throw", () => {
  assert.deepEqual(extractHomeReleaseDates(undefined), { digital: null, physical: null });
  assert.deepEqual(extractHomeReleaseDates(null), { digital: null, physical: null });
  assert.deepEqual(extractHomeReleaseDates({}), { digital: null, physical: null });
  assert.deepEqual(
    extractHomeReleaseDates({ results: [{ iso_3166_1: "US", release_dates: [{ type: 4 }, rd(5, "soon")] }] }),
    { digital: null, physical: null },
  );
});
