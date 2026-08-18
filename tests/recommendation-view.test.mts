// Unit tests for src/lib/recommendation-view.ts — the filter/sort layer shared
// by the /for-you page and its native mirror /api/recommendations. Pinned here:
//   - the param parsers reject junk and fall back to the documented defaults
//     (an unknown ?sort= must not silently produce an unsorted grid);
//   - "match" preserves the engine's ranking EXACTLY and never re-derives it;
//   - "newest" is a date order with undated titles last, and ties fall back to
//     rank (sort stability), so the two surfaces can't disagree about ordering;
//   - filters compose, and every path returns a COPY — the caller still holds
//     the enriched array it counts the unfiltered total from.
//
// Pure module: no DB, no network, no Prisma. Imported directly.
import { test } from "node:test";
import assert from "node:assert/strict";

import {
  applyRecommendationView,
  parseAvailability,
  parseRecommendationSort,
  parseRecommendationType,
} from "../src/lib/recommendation-view.ts";
import type { TmdbMedia } from "../src/lib/tmdb-types.ts";

function media(over: Partial<TmdbMedia> & { id: number }): TmdbMedia {
  return {
    mediaType: "movie",
    title: `Title ${over.id}`,
    overview: "",
    posterPath: null,
    backdropPath: null,
    releaseDate: null,
    releaseYear: null,
    voteAverage: 0,
    ...over,
  };
}

test("parsers: junk, empty and absent values fall back to the documented defaults", () => {
  assert.equal(parseAvailability("available"), "available");
  assert.equal(parseAvailability("missing"), "missing");
  assert.equal(parseAvailability("AVAILABLE"), undefined); // case-sensitive on purpose
  assert.equal(parseAvailability("garbage"), undefined);
  assert.equal(parseAvailability(null), undefined);
  assert.equal(parseAvailability(undefined), undefined);

  assert.equal(parseRecommendationType("movie"), "movie");
  assert.equal(parseRecommendationType("tv"), "tv");
  assert.equal(parseRecommendationType("MOVIE"), undefined);
  assert.equal(parseRecommendationType(null), undefined);

  // Sort has a non-undefined default: an unrecognized value must land on
  // "match", never on undefined, or the grid renders in no defined order.
  assert.equal(parseRecommendationSort("newest"), "newest");
  assert.equal(parseRecommendationSort("rating"), "rating");
  assert.equal(parseRecommendationSort("match"), "match");
  assert.equal(parseRecommendationSort("score"), "match");
  assert.equal(parseRecommendationSort(null), "match");
});

test('"match" preserves the engine ranking exactly, and returns a copy', () => {
  const items = [media({ id: 1, voteAverage: 2 }), media({ id: 2, voteAverage: 9 }), media({ id: 3, voteAverage: 5 })];
  const out = applyRecommendationView(items, { sort: "match" });

  assert.deepEqual(out.map((m) => m.id), [1, 2, 3], "input order (rank) is untouched");
  assert.notEqual(out, items, "a copy — the caller still counts the unfiltered set");
  assert.deepEqual(items.map((m) => m.id), [1, 2, 3], "and the input was not mutated");

  // Omitting `sort` entirely means the same thing.
  assert.deepEqual(applyRecommendationView(items, {}).map((m) => m.id), [1, 2, 3]);
});

test('"newest" orders by date descending, puts undated titles last, and breaks ties by rank', () => {
  const items = [
    media({ id: 1, releaseDate: "2020-06-01" }),
    media({ id: 2, releaseDate: null }),
    media({ id: 3, releaseDate: "2024-01-15" }),
    media({ id: 4, releaseDate: "2020-06-01" }), // ties with 1 — must stay AFTER it
    media({ id: 5, releaseDate: "2024-02-01" }),
  ];
  const out = applyRecommendationView(items, { sort: "newest" });
  assert.deepEqual(out.map((m) => m.id), [5, 3, 1, 4, 2]);
});

test('"rating" orders by score descending with ties falling back to rank', () => {
  const items = [
    media({ id: 1, voteAverage: 7.5 }),
    media({ id: 2, voteAverage: 9.1 }),
    media({ id: 3, voteAverage: 7.5 }),
    media({ id: 4, voteAverage: 0 }),
  ];
  assert.deepEqual(applyRecommendationView(items, { sort: "rating" }).map((m) => m.id), [2, 1, 3, 4]);
});

test("availability reads BOTH servers: on either one counts as available", () => {
  const items = [
    media({ id: 1, plexAvailable: true, jellyfinAvailable: false }),
    media({ id: 2, plexAvailable: false, jellyfinAvailable: true }),
    media({ id: 3, plexAvailable: false, jellyfinAvailable: false }),
    media({ id: 4 }), // never enriched — absent reads as not available
  ];
  assert.deepEqual(applyRecommendationView(items, { availability: "available" }).map((m) => m.id), [1, 2]);
  assert.deepEqual(applyRecommendationView(items, { availability: "missing" }).map((m) => m.id), [3, 4]);
  assert.deepEqual(applyRecommendationView(items, { availability: undefined }).map((m) => m.id), [1, 2, 3, 4]);
});

test("type and availability compose, and the sort applies to what survives both", () => {
  const items = [
    media({ id: 1, mediaType: "movie", plexAvailable: true, releaseDate: "2001-01-01" }),
    media({ id: 2, mediaType: "tv", plexAvailable: true, releaseDate: "2024-01-01" }),
    media({ id: 3, mediaType: "movie", plexAvailable: false, releaseDate: "2023-01-01" }),
    media({ id: 4, mediaType: "movie", plexAvailable: true, releaseDate: "2019-01-01" }),
  ];

  // movies ∩ on-server = {1, 4}; newest-first = [4, 1]. The TV title is on the
  // server and the newest of all, so it appearing here would mean the type
  // filter ran after the sort truncated, or not at all.
  const out = applyRecommendationView(items, { type: "movie", availability: "available", sort: "newest" });
  assert.deepEqual(out.map((m) => m.id), [4, 1]);
});

test("a filtered result is a fresh array, so sorting it can never reorder the caller's input", () => {
  const items = [
    media({ id: 1, mediaType: "movie", voteAverage: 1 }),
    media({ id: 2, mediaType: "movie", voteAverage: 9 }),
  ];
  const out = applyRecommendationView(items, { type: "movie", sort: "rating" });
  assert.deepEqual(out.map((m) => m.id), [2, 1]);
  assert.deepEqual(items.map((m) => m.id), [1, 2], "input untouched");
});

test("an empty input stays empty for every combination", () => {
  for (const sort of ["match", "newest", "rating"] as const) {
    assert.deepEqual(applyRecommendationView([], { sort, type: "movie", availability: "available" }), []);
  }
});
