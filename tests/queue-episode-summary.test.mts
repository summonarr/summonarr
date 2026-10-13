import { test } from "node:test";
import assert from "node:assert/strict";
import { foldQueueRecords } from "../src/lib/arr-queue.ts";
import { episodeSummary } from "../src/components/admin/queue-format.ts";

const e = (n: number, s = 1) => ({ seasonNumber: s, episodeNumber: n });

test("a contiguous run in one season is a range", () => {
  assert.equal(episodeSummary([e(1), e(2), e(3), e(4)]), "S01E01–E04");
});

test("a gap is never presented as a range", () => {
  assert.equal(episodeSummary([e(1), e(3)]), "S01E01, S01E03");
  assert.equal(episodeSummary([e(1), e(2), e(4)]), "S01E01, S01E02, S01E04");
});

test("episodes across seasons list their codes", () => {
  assert.equal(episodeSummary([e(9, 1), e(1, 2)]), "S01E09, S02E01");
});

test("a four-episode pack folds to one row carrying all four episodes", () => {
  const rec = (id: number, n: number) => ({ id, downloadId: "HASH", seriesId: 9, series: { title: "Show" }, episode: { seasonNumber: 1, episodeNumber: n } });
  const rows = foldQueueRecords("sonarr", "", [rec(1, 1), rec(2, 2), rec(3, 3), rec(4, 4)]);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].episodes.length, 4);
  assert.deepEqual(rows[0].ids, [1, 2, 3, 4]);
});

test("four single-episode downloads stay four rows", () => {
  const rec = (id: number, n: number) => ({ id, downloadId: `H${id}`, seriesId: 9, series: { title: "Show" }, episode: { seasonNumber: 1, episodeNumber: n } });
  assert.equal(foldQueueRecords("sonarr", "", [rec(1, 1), rec(2, 2), rec(3, 3), rec(4, 4)]).length, 4);
});
