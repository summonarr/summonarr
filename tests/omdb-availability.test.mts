// Unit tests for hasAnyMdblistRating (src/lib/omdb-availability.ts) — the
// source-arbitration gate for ratings. MDBList's batch endpoint returns a real
// row for titles it merely *indexes* (every score null); if such an empty row
// counted as "has ratings" it would (a) shadow a populated OMDB warm-cache row
// in mergeWarm and (b) exclude the title from mdbMisses so the OMDB fallback
// never fires — leaving a title OMDB *could* rate showing none. The predicate
// must therefore read true ONLY when at least one of the nine score fields
// carries a value, and must ignore the non-score metadata fields (imdbId,
// imdbVotes, releasedDigital, trailerUrl) entirely.
//
// Everything else in the module is network/DB (after(), prisma, MDBList/OMDB
// fetch chains) and is deliberately untested here.
import { test } from "node:test";
import assert from "node:assert/strict";
import { hasAnyMdblistRating } from "../src/lib/omdb-availability.ts";
import type { MdblistRatings } from "../src/lib/mdblist.ts";

// A fully-null row — exactly what MDBList returns for an indexed-but-unscored
// title. Overrides layer individual fields on top.
function row(overrides: Partial<MdblistRatings> = {}): MdblistRatings {
  return {
    imdbId: null,
    imdbRating: null,
    imdbVotes: null,
    rottenTomatoes: null,
    rtAudienceScore: null,
    metacritic: null,
    traktRating: null,
    letterboxdRating: null,
    mdblistScore: null,
    malRating: null,
    rogerEbertRating: null,
    releasedDigital: null,
    trailerUrl: null,
    ...overrides,
  };
}

// The nine fields the predicate consults — one per external ratings source.
const RATING_FIELDS = [
  "imdbRating",
  "rottenTomatoes",
  "rtAudienceScore",
  "metacritic",
  "traktRating",
  "letterboxdRating",
  "mdblistScore",
  "malRating",
  "rogerEbertRating",
] as const;

// Metadata fields that are NOT ratings — their presence alone must never make
// an MDBList row win over a populated OMDB row.
const NON_RATING_FIELDS = ["imdbId", "imdbVotes", "releasedDigital", "trailerUrl"] as const;

test("all-null row (indexed but unscored) → false", () => {
  assert.equal(hasAnyMdblistRating(row()), false);
});

for (const field of RATING_FIELDS) {
  test(`a single ${field} value alone → true`, () => {
    assert.equal(hasAnyMdblistRating(row({ [field]: "7.4" })), true);
  });
}

test("every rating field populated at once → true", () => {
  const full = row(Object.fromEntries(RATING_FIELDS.map((f) => [f, "8"])) as Partial<MdblistRatings>);
  assert.equal(hasAnyMdblistRating(full), true);
});

for (const field of NON_RATING_FIELDS) {
  test(`${field} alone is metadata, not a rating → false`, () => {
    assert.equal(hasAnyMdblistRating(row({ [field]: "tt0111161" })), false);
  });
}

test("all four metadata fields together, still no scores → false", () => {
  const r = row({
    imdbId: "tt0111161",
    imdbVotes: "2900000",
    releasedDigital: "2024-01-15",
    trailerUrl: "https://youtube.com/watch?v=abc",
  });
  assert.equal(hasAnyMdblistRating(r), false);
});

test("empty-string scores are falsy — treated the same as null", () => {
  // Defensive: MDBList shapes scores as string|null, but an upstream change to
  // "" for absent scores must not flip the arbitration.
  const r = row(Object.fromEntries(RATING_FIELDS.map((f) => [f, ""])) as Partial<MdblistRatings>);
  assert.equal(hasAnyMdblistRating(r), false);
});

test('PINS CURRENT BEHAVIOR: a literal "0" score counts as a rating', () => {
  // Scores are strings, and the non-empty string "0" is truthy. A genuine
  // zero-score title (e.g. metacritic "0") therefore reads as rated — which is
  // correct: an explicit 0 is data, not absence.
  assert.equal(hasAnyMdblistRating(row({ metacritic: "0" })), true);
});

test("one real score among otherwise-null fields wins regardless of metadata", () => {
  const r = row({ imdbId: "tt0111161", letterboxdRating: "4.6" });
  assert.equal(hasAnyMdblistRating(r), true);
});

test("returns a real boolean, both branches (Boolean() wrapper contract)", () => {
  // mergeWarm and the batch-hit filter use the result in boolean expressions;
  // pin that callers never see a truthy string leak through.
  assert.equal(typeof hasAnyMdblistRating(row()), "boolean");
  assert.equal(typeof hasAnyMdblistRating(row({ imdbRating: "9.3" })), "boolean");
});
