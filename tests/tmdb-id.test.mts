// parseTmdbIdParam — the one parser for a tmdbId taken from a URL path segment
// (the movie/TV/person detail pages, GET /api/person/[id], GET /api/media/…,
// the season route). Canonical digits only: `parseInt` read "550abc" as 550 and
// `Number` read "1e3", "0x3E8" and " 550 " as numbers, so one title answered at
// URLs that weren't its own and "1.5" reached TMDB.
import { test } from "node:test";
import assert from "node:assert/strict";
import { parseTmdbIdParam, isTmdbIdInRange, MAX_TMDB_ID } from "../src/lib/tmdb-id.ts";

test("canonical ids parse", () => {
  assert.equal(parseTmdbIdParam("550"), 550);
  assert.equal(parseTmdbIdParam("1"), 1);
  assert.equal(parseTmdbIdParam(String(MAX_TMDB_ID)), MAX_TMDB_ID);
});

test("every non-canonical spelling is refused", () => {
  for (const raw of ["1e3", "0x3E8", " 550 ", "550 ", "550.0", "1.5", "550abc", "+550", "-1", "0", "0550", "", "abc", "５５０"]) {
    assert.equal(parseTmdbIdParam(raw), null, JSON.stringify(raw));
  }
});

test("range is left to isTmdbIdInRange, so a route can tell the two 400s apart", () => {
  const big = parseTmdbIdParam("2147483648");
  assert.equal(big, 2_147_483_648);
  assert.equal(isTmdbIdInRange(big as number), false);
  assert.equal(isTmdbIdInRange(parseTmdbIdParam("2147483647") as number), true);
});
