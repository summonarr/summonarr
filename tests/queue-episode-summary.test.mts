import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
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

test("a multi-episode pack row shows its episode COUNT (plural key present in every locale)", () => {
  const src = readFileSync(new URL("../src/components/admin/download-queue.tsx", import.meta.url), "utf8");
  assert.match(src, /r\.episodes\.length > 1 &&[^\n]*t\("adminManage\.queue\.episodeCount", \{ count: r\.episodes\.length \}\)/);
  for (const loc of ["en", "es", "fr", "de", "pt", "it", "zh"]) {
    const json = JSON.parse(readFileSync(new URL(`../src/lib/i18n/messages/${loc}/adminManage.json`, import.meta.url), "utf8"));
    assert.ok(json["adminManage.queue.episodeCount_one"] && json["adminManage.queue.episodeCount_other"], `${loc} has both plural forms`);
  }
});

test("four single-episode downloads stay four rows", () => {
  const rec = (id: number, n: number) => ({ id, downloadId: `H${id}`, seriesId: 9, series: { title: "Show" }, episode: { seasonNumber: 1, episodeNumber: n } });
  assert.equal(foldQueueRecords("sonarr", "", [rec(1, 1), rec(2, 2), rec(3, 3), rec(4, 4)]).length, 4);
});

import { seasonPackSeasons } from "../src/components/admin/queue-format.ts";

test("seasonPackSeasons: a season marker with no episode marker is a pack", () => {
  const eps = [e(1), e(2), e(3)];
  assert.deepEqual(seasonPackSeasons("Show.S01.1080p.WEB-DL", eps), [1]);
  assert.deepEqual(seasonPackSeasons("Show.S01E01E02E03.1080p", eps), null);
  assert.deepEqual(seasonPackSeasons("Show.S01.1080p", [e(1)]), null);
});
