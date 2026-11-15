// The /movies and /tv filter bar's readings (src/components/media/filter-bar-options.ts).
//
//   - An active rating the list doesn't hold (a shared link's minRating=6.5,
//     ratingFilter=imdb:5) gets its own option, so the select shows the filter
//     the chip shows instead of falling back to "Any rating".
//   - A rating pick writes TMDB's own minimum or a ratingFilter, never both.
//   - Every active filter gets a removable chip, named or not.
//   - The provider order is pinned to the "en" collation (SSR = hydration).
import { test } from "node:test";
import assert from "node:assert/strict";

const o = await import("../src/components/media/filter-bar-options.ts");
const t = (key: string, vars?: Record<string, string | number>) => `${key}${vars ? JSON.stringify(vars) : ""}`;

test("the rating select always holds the active value", () => {
  const listed = o.ratingSelectOptions(t, "imdb:7");
  assert.equal(listed.length, o.RATING_OPTIONS.length, "a listed value adds nothing");
  for (const [active, label] of [["tmdb:6.5", "TMDB 6.5+"], ["imdb:5", "imdb:5"]] as const) {
    const opts = o.ratingSelectOptions(t, active);
    assert.equal(opts.length, o.RATING_OPTIONS.length + 1);
    assert.deepEqual(opts[1], { value: active, label }, active);
    assert.equal(opts[0].value, "", "Any rating stays first");
  }
  assert.equal(o.ratingSelectOptions(t, "").length, o.RATING_OPTIONS.length);
});

test("the rating value and a pick", () => {
  assert.equal(o.activeRatingValue({ minRating: "7.5" }), "tmdb:7.5");
  assert.equal(o.activeRatingValue({ ratingFilter: "rt:70", minRating: "7" }), "rt:70");
  assert.equal(o.activeRatingValue({}), "");
  assert.deepEqual(o.ratingDelta("tmdb:8"), { minRating: "8", ratingFilter: undefined });
  assert.deepEqual(o.ratingDelta("rt:70"), { ratingFilter: "rt:70", minRating: undefined });
  assert.deepEqual(o.ratingDelta(""), { minRating: undefined, ratingFilter: undefined });
});

test("every active filter has a chip, a name it can't resolve included", () => {
  const chips = o.filterChips(
    { hideAvailable: true, genreId: "999", watchProvider: "12345", keywordId: "1", sortBy: "weird.desc", certification: "R", minRating: "6.5" },
    { genres: [{ id: 28, name: "Action" }], providers: [], showCertification: false },
    t,
  );
  assert.deepEqual(chips.map((c) => [c.key, c.label]), [
    ["genre", "999"],
    ["keyword", "media.filter.keyword"],
    ["rating", "TMDB 6.5+"],
    ["provider", 'media.filter.serviceChip{"id":"12345"}'],
    ["sort", "weird.desc"],
    ["hide", "media.filter.hidingAvailable"],
  ]);
  assert.deepEqual(chips.find((c) => c.key === "rating")?.remove, { minRating: undefined, ratingFilter: undefined });
  assert.equal(o.filterChips({ hideAvailable: false, sortBy: "popularity.desc" }, { genres: [], providers: [], showCertification: true }, t).length, 0);
});

test("providers: the big services first, then by the en collation", () => {
  const names = o.sortProviders([
    { provider_id: 2, provider_name: "Zed" },
    { provider_id: 3, provider_name: "Chili" },
    { provider_id: 8, provider_name: "Netflix" },
    { provider_id: 4, provider_name: "Hulu Plus" },
  ] as never).map((p) => p.provider_name);
  assert.deepEqual(names, ["Netflix", "Chili", "Hulu Plus", "Zed"]);
});

test("vote labels group by the catalog's separator", () => {
  assert.equal(o.voteCountLabel(t, ""), "media.filter.anyVotes");
  assert.equal(o.voteCountLabel(((k: string, v?: Record<string, string | number>) => (k === "media.filter.thousandsSeparator" ? "," : `${v?.n}+`)) as never, "10000"), "10,000+");
});

test("a fixed option list gains the active value it lacks, in numeric order", () => {
  const votes = ["", "100", "500", "1000"];
  assert.deepEqual(o.optionsWithActive(votes, "500"), votes, "a listed value adds nothing");
  assert.deepEqual(o.optionsWithActive(votes, undefined), votes);
  assert.deepEqual(o.optionsWithActive(votes, ""), votes);
  assert.deepEqual(o.optionsWithActive(votes, "250"), ["", "100", "250", "500", "1000"]);
  assert.deepEqual(o.optionsWithActive(votes, "2000"), ["", "100", "500", "1000", "2000"]);
  assert.deepEqual(o.optionsWithActive(votes, "50"), ["", "50", "100", "500", "1000"], "the any entry stays first");
  assert.deepEqual(o.optionsWithActive(["", "7", "7.5"], "7.2"), ["", "7", "7.2", "7.5"]);
  assert.notEqual(o.optionsWithActive(votes, "500"), votes, "never the caller's own array");
});
