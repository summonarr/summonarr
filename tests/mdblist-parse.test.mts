// Unit tests for parseBatchItem (src/lib/mdblist.ts) — the single translation
// point from MDBList's wire shape to the MdblistRatings row every ratings
// surface consumes. Two families of rules live here and have regressed before:
//
// 1. Source-name aliasing. MDBList has renamed rating sources across API
//    versions ("audience" / "tomatoesaudience" / "popcornrating" all mean the
//    RT audience score; "letterrating" vs "letterboxd"; "myanimelist" vs
//    "mal"). findSrc scans aliases in declaration order and returns the first
//    HIT — so alias priority is the argument order, not array order.
// 2. Per-source formatting. Percent sources get `${Math.round(v)}%`,
//    metacritic gets `/100`, trakt and the mdblist score round to integer
//    strings, while letterboxd/MAL/Ebert pass through unrounded. IMDb rating
//    uses a `!= null` gate (an explicit 0 is data → "0"), but IMDb votes uses
//    a truthiness gate (0 votes is absence, not a count worth showing).
//
// parseBatchItem is pure (no fetch, no prisma) — importing it drags in the
// mdblist module, which the suite already loads via omdb-availability.
import { test } from "node:test";
import assert from "node:assert/strict";
import { parseBatchItem } from "../src/lib/mdblist.ts";
import type { MdblistBatchRaw, MdblistRatings } from "../src/lib/mdblist.ts";

type RatingEntry = NonNullable<MdblistBatchRaw["ratings"]>[number];

// Minimal valid batch item; overrides layer fields on top. score / imdb_id /
// trailer / released_digital are deliberately absent by default.
function parse(overrides: Partial<MdblistBatchRaw> = {}): MdblistRatings {
  return parseBatchItem({ id: 603, title: "Fixture", type: "movie", year: 2020, ...overrides });
}

function src(source: string, value: number | null, extra: Partial<RatingEntry> = {}): RatingEntry {
  return { source, value, ...extra };
}

// ---------------------------------------------------------------------------
// Source-name aliases resolve to the right field
// ---------------------------------------------------------------------------

test("plain source names map to their fields (imdb, tomatoes, metacritic, trakt, rogerebert)", () => {
  const out = parse({
    ratings: [
      src("imdb", 8.7),
      src("tomatoes", 83),
      src("metacritic", 73),
      src("trakt", 85),
      src("rogerebert", 4),
    ],
  });
  assert.equal(out.imdbRating, "8.7");
  assert.equal(out.rottenTomatoes, "83%");
  assert.equal(out.metacritic, "73/100");
  assert.equal(out.traktRating, "85");
  assert.equal(out.rogerEbertRating, "4");
});

for (const alias of ["audience", "tomatoesaudience", "popcornrating"] as const) {
  test(`RT audience score resolves via the "${alias}" alias`, () => {
    const out = parse({ ratings: [src(alias, 85)] });
    assert.equal(out.rtAudienceScore, "85%");
  });
}

for (const alias of ["letterboxd", "letterrating"] as const) {
  test(`letterboxd rating resolves via the "${alias}" alias`, () => {
    const out = parse({ ratings: [src(alias, 4.6)] });
    assert.equal(out.letterboxdRating, "4.6");
  });
}

for (const alias of ["mal", "myanimelist"] as const) {
  test(`MAL rating resolves via the "${alias}" alias`, () => {
    const out = parse({ ratings: [src(alias, 8.9)] });
    assert.equal(out.malRating, "8.9");
  });
}

test("an unknown source name maps to nothing", () => {
  const out = parse({ ratings: [src("flixometer", 99)] });
  for (const [field, value] of Object.entries(out)) {
    assert.equal(value, null, `${field} should be null for an unknown source`);
  }
});

// ---------------------------------------------------------------------------
// Formatting rules
// ---------------------------------------------------------------------------

test("rottenTomatoes rounds to an integer percent string", () => {
  assert.equal(parse({ ratings: [src("tomatoes", 84.6)] }).rottenTomatoes, "85%");
  assert.equal(parse({ ratings: [src("tomatoes", 84.4)] }).rottenTomatoes, "84%");
});

test("rtAudienceScore rounds to an integer percent string", () => {
  assert.equal(parse({ ratings: [src("audience", 77.5)] }).rtAudienceScore, "78%");
  assert.equal(parse({ ratings: [src("audience", 77.4)] }).rtAudienceScore, "77%");
});

test("metacritic rounds and appends /100", () => {
  assert.equal(parse({ ratings: [src("metacritic", 66.6)] }).metacritic, "67/100");
  assert.equal(parse({ ratings: [src("metacritic", 66.4)] }).metacritic, "66/100");
});

test("traktRating is a rounded integer string (no suffix)", () => {
  assert.equal(parse({ ratings: [src("trakt", 82.5)] }).traktRating, "83");
  assert.equal(parse({ ratings: [src("trakt", 82.4)] }).traktRating, "82");
});

test("mdblistScore comes from raw.score, rounded to an integer string", () => {
  assert.equal(parse({ score: 71.5 }).mdblistScore, "72");
  assert.equal(parse({ score: 68 }).mdblistScore, "68");
});

test("letterboxd, MAL, and Ebert pass through unrounded via String()", () => {
  const out = parse({ ratings: [src("letterboxd", 4.25), src("mal", 8.61), src("rogerebert", 3.5)] });
  assert.equal(out.letterboxdRating, "4.25");
  assert.equal(out.malRating, "8.61");
  assert.equal(out.rogerEbertRating, "3.5");
});

test("imdbRating passes through unrounded via String()", () => {
  assert.equal(parse({ ratings: [src("imdb", 7.8)] }).imdbRating, "7.8");
});

test('imdbRating 0 is a valid rating → "0" (the != null gate, not truthiness)', () => {
  // An explicit zero score is data, not absence. A truthiness gate here would
  // erase it — pin the `value != null` contract.
  assert.equal(parse({ ratings: [src("imdb", 0)] }).imdbRating, "0");
});

test("imdbVotes is emitted only when votes is truthy", () => {
  assert.equal(parse({ ratings: [src("imdb", 8.7, { votes: 2_900_000 })] }).imdbVotes, "2900000");
  // 0 votes is absence for the votes field (truthiness gate — contrast imdbRating 0).
  assert.equal(parse({ ratings: [src("imdb", 8.7, { votes: 0 })] }).imdbVotes, null);
  assert.equal(parse({ ratings: [src("imdb", 8.7)] }).imdbVotes, null);
});

test("an imdb entry with a null value can still carry votes", () => {
  const out = parse({ ratings: [src("imdb", null, { votes: 1234 })] });
  assert.equal(out.imdbRating, null);
  assert.equal(out.imdbVotes, "1234");
});

// ---------------------------------------------------------------------------
// Null / absent handling
// ---------------------------------------------------------------------------

const ALL_NULL: MdblistRatings = {
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
};

test("absent ratings array → every field null", () => {
  assert.deepEqual(parse(), ALL_NULL);
});

test("empty ratings array → every field null", () => {
  assert.deepEqual(parse({ ratings: [] }), ALL_NULL);
});

test("a source present with value null → that field null", () => {
  const out = parse({
    ratings: [
      src("imdb", null),
      src("tomatoes", null),
      src("audience", null),
      src("metacritic", null),
      src("trakt", null),
      src("letterboxd", null),
      src("mal", null),
      src("rogerebert", null),
    ],
  });
  assert.deepEqual(out, ALL_NULL);
});

test("raw.score null → mdblistScore null", () => {
  assert.equal(parse({ score: null }).mdblistScore, null);
});

test("imdb_id: empty string and absent both → null; a real id passes through", () => {
  assert.equal(parse({ imdb_id: "" }).imdbId, null);
  assert.equal(parse().imdbId, null);
  assert.equal(parse({ imdb_id: "tt0133093" }).imdbId, "tt0133093");
});

test("released_digital: falsy → null; a real date passes through untouched", () => {
  assert.equal(parse({ released_digital: "" }).releasedDigital, null);
  assert.equal(parse({ released_digital: null }).releasedDigital, null);
  assert.equal(parse({ released_digital: "2024-01-15" }).releasedDigital, "2024-01-15");
});

test("trailer: falsy → null; a real URL passes through untouched", () => {
  assert.equal(parse({ trailer: "" }).trailerUrl, null);
  assert.equal(parse({ trailer: null }).trailerUrl, null);
  assert.equal(parse({ trailer: "https://youtube.com/watch?v=abc" }).trailerUrl, "https://youtube.com/watch?v=abc");
});

// ---------------------------------------------------------------------------
// Alias priority when multiple alias entries coexist
// ---------------------------------------------------------------------------

test("alias priority is argument order, not array order (RT audience)", () => {
  // "audience" is the first-declared alias, so it wins even when other
  // aliases appear earlier in the ratings array.
  const out = parse({
    ratings: [src("tomatoesaudience", 60), src("popcornrating", 70), src("audience", 90)],
  });
  assert.equal(out.rtAudienceScore, "90%");
});

test("alias priority: letterboxd beats letterrating", () => {
  const out = parse({ ratings: [src("letterrating", 3.1), src("letterboxd", 4.6)] });
  assert.equal(out.letterboxdRating, "4.6");
});

test("alias priority: mal beats myanimelist", () => {
  const out = parse({ ratings: [src("myanimelist", 7.2), src("mal", 8.9)] });
  assert.equal(out.malRating, "8.9");
});

test("duplicate entries for one source → first array entry wins", () => {
  const out = parse({ ratings: [src("imdb", 8.7), src("imdb", 9.9)] });
  assert.equal(out.imdbRating, "8.7");
});

test("PINS CURRENT BEHAVIOR: a first-alias hit with value null shadows a later alias with a value", () => {
  // findSrc returns the first alias HIT regardless of its value — a null-value
  // "audience" entry wins the scan, so the real "popcornrating" score is never
  // consulted. If MDBList ever ships null primary + populated fallback rows,
  // this is the line to revisit; until then, pin the scan-by-alias semantics.
  const out = parse({ ratings: [src("audience", null), src("popcornrating", 80)] });
  assert.equal(out.rtAudienceScore, null);
});
