// The Upcoming list shared by the /upcoming page and GET /api/upcoming
// (src/lib/upcoming-list.ts): the interleave, the live fallback for a side the
// cache is missing, and the failure policy — a failed read keeps what the other
// reads returned, and "failed" means an EMPTY list caused by a failure.
import { test } from "node:test";
import assert from "node:assert/strict";
import { interleaveUpcoming, loadUpcomingTitles } from "../src/lib/upcoming-list.ts";
type Media = import("../src/lib/tmdb-types.ts").TmdbMedia;

const NOW = Date.parse("2026-11-07T18:00:00Z");
const media = (id: number, mediaType: "movie" | "tv", releaseDate: string | null): Media => ({
  id, mediaType, title: `t${id}`, overview: "", posterPath: null, backdropPath: null,
  releaseDate, releaseYear: "", voteAverage: 0,
});
const ids = (list: Media[]) => list.map((m) => `${m.mediaType}-${m.id}`);
const boom = () => Promise.reject(new Error("down"));
const quietly = async <T,>(fn: () => Promise<T>): Promise<T> => {
  const orig = console.error;
  console.error = () => {};
  try { return await fn(); } finally { console.error = orig; }
};

test("interleaveUpcoming alternates movie and show and drops released or undated titles", () => {
  const all = [
    media(1, "movie", "2026-11-08"), media(2, "movie", "2026-11-09"), media(3, "movie", "2026-11-01"),
    media(10, "tv", "2026-11-10"), media(11, "tv", null),
  ];
  assert.deepEqual(ids(interleaveUpcoming(all, "2026-11-07")), ["movie-1", "tv-10", "movie-2"]);
});

test("a side missing from the cache is read live; a side the cache has is not", async () => {
  let tvCalls = 0;
  const { titles, failed } = await loadUpcomingTitles(NOW, {
    readCache: async () => [media(1, "movie", "2026-11-08")],
    liveMovies: async () => { throw new Error("must not be called"); },
    liveTv: async () => { tvCalls++; return [media(10, "tv", "2026-11-09")]; },
  });
  assert.equal(tvCalls, 1);
  assert.deepEqual(ids(titles), ["movie-1", "tv-10"]);
  assert.equal(failed, false);
});

test("a failed live fallback keeps the cached side instead of failing the whole list", async () => {
  const { titles, failed } = await quietly(() => loadUpcomingTitles(NOW, {
    readCache: async () => [media(1, "movie", "2026-11-08")],
    liveMovies: boom,
    liveTv: boom,
  }));
  assert.deepEqual(ids(titles), ["movie-1"]);
  assert.equal(failed, false, "titles came back, so the page shows them");
});

test("a failed cache read falls back to live reads for both sides", async () => {
  const { titles, failed } = await quietly(() => loadUpcomingTitles(NOW, {
    readCache: boom,
    liveMovies: async () => [media(1, "movie", "2026-11-08")],
    liveTv: async () => [],
  }));
  assert.deepEqual(ids(titles), ["movie-1"]);
  assert.equal(failed, false);
});

test("failed is reported only for an empty list caused by a failure", async () => {
  const outage = await quietly(() => loadUpcomingTitles(NOW, { readCache: boom, liveMovies: boom, liveTv: boom }));
  assert.deepEqual(outage, { titles: [], failed: true });
  const nothing = await loadUpcomingTitles(NOW, { readCache: async () => [], liveMovies: async () => [], liveTv: async () => [] });
  assert.deepEqual(nothing, { titles: [], failed: false });
});
