// The search-param changes shared by the pill groups on one page
// (src/lib/client/pending-query.ts, used by usePendingSearchParam).
import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { holdPendingQuery, nextPendingQuery, settlePendingQuery } from "../src/lib/client/pending-query.ts";

const PATH = "/for-you";
// A URL nothing was made against: drops whatever an earlier test left.
beforeEach(() => settlePendingQuery("/reset", "reset=1"));

test("a second group's change before the first lands keeps the first", () => {
  // Both built from the committed URL alone, the second push dropped `type`.
  assert.equal(nextPendingQuery(PATH, "", "type", "movie"), "type=movie");
  assert.equal(nextPendingQuery(PATH, "", "sort", "newest"), "type=movie&sort=newest");
  // A third, clearing the first again.
  assert.equal(nextPendingQuery(PATH, "", "type", undefined), "sort=newest");
});

test("every change drops the page number", () => {
  assert.equal(nextPendingQuery(PATH, "page=3&filter=missing", "sort", "rating"), "filter=missing&sort=rating");
});

test("carried changes are dropped once the URL moves, and never cross pages", () => {
  nextPendingQuery(PATH, "", "type", "movie");
  settlePendingQuery(PATH, "type=movie");
  assert.equal(nextPendingQuery(PATH, "type=movie", "sort", "newest"), "type=movie&sort=newest");
  // Back to the bare URL (the Back button): the old change is not reapplied.
  settlePendingQuery(PATH, "");
  assert.equal(nextPendingQuery(PATH, "", "filter", "missing"), "filter=missing");
  // Same query string on another page.
  assert.equal(nextPendingQuery("/upcoming", "", "hideAvailable", "1"), "hideAvailable=1");
});

test("settling on the URL the changes were made against keeps them", () => {
  nextPendingQuery(PATH, "", "type", "tv");
  settlePendingQuery(PATH, "");
  assert.equal(nextPendingQuery(PATH, "", "sort", "newest"), "type=tv&sort=newest");
});

test("a change whose navigation never commits is dropped when the last pending one ends", () => {
  // The pill was clicked, then another link won: the URL stays as it was.
  const release = holdPendingQuery();
  nextPendingQuery(PATH, "", "type", "tv");
  release();
  release(); // an effect cleanup running twice releases once
  assert.equal(nextPendingQuery(PATH, "", "sort", "newest"), "sort=newest", "the abandoned type=tv is not re-applied");
});

test("changes stay carried while any group's navigation is still pending", () => {
  const first = holdPendingQuery();
  nextPendingQuery(PATH, "", "type", "movie");
  const second = holdPendingQuery();
  nextPendingQuery(PATH, "", "sort", "newest");
  // The first group's navigation was superseded by the second's.
  first();
  assert.equal(nextPendingQuery(PATH, "", "filter", "missing"), "type=movie&sort=newest&filter=missing");
  second();
  assert.equal(nextPendingQuery(PATH, "", "filter", "missing"), "filter=missing");
});
