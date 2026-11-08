// The header search's reading of /api/search (src/components/layout/search-results.ts):
// an entry is kept only with a movie/tv type and an integer id, so a bad one
// can't route to /undefined/undefined or collide on its key, and one bad entry
// never empties the list.
import { test } from "node:test";
import assert from "node:assert/strict";
import { SEARCH_RESULT_LIMIT, searchHits } from "../src/components/layout/search-results.ts";

const hit = (o: Record<string, unknown> = {}) => ({ id: 1, mediaType: "movie", title: "Alien", posterPath: "/p.jpg", releaseYear: "1979", overview: "x", voteAverage: 8, ...o });

test("a non-list answer is no answer (the dropdown says search is unavailable)", () => {
  assert.equal(searchHits({ error: "nope" }), null);
  assert.equal(searchHits(null), null);
  assert.deepEqual(searchHits([]), []);
});

test("entries without a movie/tv type or an integer id are dropped, the rest kept in order", () => {
  const hits = searchHits([
    hit({ id: 1 }),
    hit({ id: undefined }),
    hit({ id: "2" }),
    hit({ id: 3, mediaType: "person" }),
    hit({ id: 4, mediaType: undefined }),
    hit({ id: 5, title: null }),
    "junk",
    hit({ id: 6, mediaType: "tv", posterPath: null, releaseYear: null, plexAvailable: true }),
  ]);
  assert.deepEqual(hits?.map((h) => `${h.mediaType}/${h.id}`), ["movie/1", "tv/6"]);
  assert.equal(hits?.[1].plexAvailable, true);
});

test("at most SEARCH_RESULT_LIMIT hits", () => {
  const many = Array.from({ length: 20 }, (_, i) => hit({ id: i + 1 }));
  assert.equal(searchHits(many)?.length, SEARCH_RESULT_LIMIT);
});
