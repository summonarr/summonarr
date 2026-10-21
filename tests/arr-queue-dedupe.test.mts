import { test } from "node:test";
import assert from "node:assert/strict";
import { foldQueueRecords } from "../src/lib/arr-queue.ts";
import { cutoffSeriesFromEpisodes } from "../src/lib/arr-missing.ts";

// The arr's queue and cutoff listings are read page by page while they change
// (the default queue order is time left, which moves with progress), so a record
// can come back on two pages. One record is one row.

test("a queue record repeated across pages is one Radarr row", () => {
  const rec = { id: 7, movieId: 1, movie: { title: "A", tmdbId: 1 }, size: 100, sizeleft: 50, status: "downloading" };
  const rows = foldQueueRecords("radarr", "", [rec, { id: 8, movieId: 2, movie: { title: "B" } }, rec]);
  assert.equal(rows.length, 2);
  assert.deepEqual(rows.map((r) => r.ids), [[7], [8]]);
});

test("a Sonarr pack record repeated across pages lists its id once", () => {
  const ep = (id: number, e: number) => ({ id, downloadId: "D", seriesId: 3, series: { title: "S" }, episode: { seasonNumber: 1, episodeNumber: e } });
  const rows = foldQueueRecords("sonarr", "", [ep(1, 1), ep(2, 2), ep(1, 1)]);
  assert.equal(rows.length, 1);
  assert.deepEqual(rows[0].ids, [1, 2]);
  assert.equal(rows[0].episodes.length, 2);
});

test("a cutoff episode repeated across pages is listed once", () => {
  const rec = { id: 11, seriesId: 3, seasonNumber: 1, episodeNumber: 1, hasFile: true, series: { title: "S" } };
  const out = cutoffSeriesFromEpisodes([rec, rec], "", new Map());
  assert.equal(out.length, 1);
  assert.equal(out[0].episodes.length, 1);
});
