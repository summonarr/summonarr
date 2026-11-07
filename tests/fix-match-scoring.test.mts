// The Plex fix-match picker's scoring rules (src/lib/fix-match-scoring.ts):
// title similarity works for every script, and a candidate the scorer called
// "wrong" is never the one marked Suggested. Pure — no DB, no network.
import test from "node:test";
import assert from "node:assert/strict";
import { assessCandidate, pickSuggestedGuid, titleSimilarity, type CandidateMatch } from "../src/lib/fix-match-scoring.ts";

test("titleSimilarity: two DIFFERENT non-Latin titles are not 100% alike", () => {
  // An [a-z0-9] filter emptied both sides, and two empty strings compared equal.
  assert.ok(titleSimilarity("千と千尋の神隠し", "もののけ姫") < 100);
  assert.ok(titleSimilarity("Брат", "Война и мир") < 100);
  assert.ok(titleSimilarity("기생충", "올드보이") < 100);
  assert.ok(titleSimilarity("Ζ", "Ο Θίασος") < 100);
});

test("titleSimilarity: identical non-Latin titles are 100, accents fold, punctuation and case are ignored", () => {
  assert.equal(titleSimilarity("千と千尋の神隠し", "千と千尋の神隠し"), 100);
  assert.equal(titleSimilarity("Война и мир", "война  и мир"), 100);
  assert.equal(titleSimilarity("Amélie", "Amelie"), 100, "an accented letter is the letter, not dropped");
  assert.equal(titleSimilarity("Spider-Man: No Way Home", "spider man no way home"), 95, "one dropped space in 22 letters");
  assert.equal(titleSimilarity("The Matrix", "THE MATRIX!"), 100);
});

test("titleSimilarity: a side with nothing comparable is no match, never a perfect one", () => {
  assert.equal(titleSimilarity("", ""), 0);
  assert.equal(titleSimilarity("!!!", "???"), 0);
  assert.equal(titleSimilarity("", "Dune"), 0);
});

test("titleSimilarity: an astral character counts once", () => {
  // Iterated by code point: "𠀀" (CJK Extension B) is two UTF-16 units but one letter.
  assert.equal(titleSimilarity("𠀀b", "xb"), 50);
});

test("assessCandidate: an IMDb disagreement is wrong; the TMDB id agreeing is exact", () => {
  const target = { tmdbId: 222, imdbId: "tt0000222", title: "Right", year: "2010", runtime: 100, genres: ["Drama"] };
  const base = { tmdbId: null, imdbId: null, name: "Right", year: 2010, tmdbTitle: null, tmdbRuntime: null, tmdbGenres: [], radarrConfirmed: false };
  assert.equal(assessCandidate({ ...base, imdbId: "tt0000999" }, target).matchLevel, "wrong");
  assert.equal(assessCandidate({ ...base, tmdbId: "222", imdbId: "tt0000999" }, target).matchLevel, "exact");
  assert.equal(assessCandidate({ ...base, imdbId: "tt0000222" }, target).matchLevel, "exact");
});

test("pickSuggestedGuid: when every candidate is wrong, nothing is suggested — not even the IMDb-GUID hit", () => {
  const wrong = (guid: string) => ({ guid, matchLevel: "wrong" as CandidateMatch });
  assert.equal(pickSuggestedGuid([wrong("a"), wrong("b")], "a"), null);
});

test("pickSuggestedGuid: the IMDb-GUID hit is suggested unless a better-ranked candidate exists", () => {
  const c = (guid: string, matchLevel: CandidateMatch) => ({ guid, matchLevel });
  assert.equal(pickSuggestedGuid([c("x", "exact"), c("a", "likely")], "a"), "x");
  assert.equal(pickSuggestedGuid([c("x", "likely"), c("a", "likely")], "a"), "a");
  assert.equal(pickSuggestedGuid([c("x", "possible"), c("a", "wrong")], "a"), "x", "a wrong IMDb hit gives way to the best non-wrong one");
  assert.equal(pickSuggestedGuid([c("x", "possible")], null), "x");
  assert.equal(pickSuggestedGuid([], null), null);
});
