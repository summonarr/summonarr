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

test("unsorted or repeated episodes are sorted and de-duplicated before a range is claimed", () => {
  assert.equal(episodeSummary([e(1), e(5), e(3)]), "S01E01, S01E03, S01E05", "a gap given out of order is still a gap");
  assert.equal(episodeSummary([e(1), e(3), e(3)]), "S01E01, S01E03", "a duplicate never fills a gap");
  assert.equal(episodeSummary([e(3), e(1), e(2)]), "S01E01–E03", "a real run in any order is a range");
  assert.equal(episodeSummary([e(2), e(2)]), "S01E02", "one episode twice is one episode");
  assert.equal(episodeSummary([e(1, 2), e(9, 1)]), "S01E09, S02E01");
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
  const src = readFileSync(new URL("../src/components/admin/queue-table.tsx", import.meta.url), "utf8");
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

import { ageFormatter, queueFormatters, sizeFormatter } from "../src/components/admin/queue-format.ts";

test("one size format for the queue and the release lists: GB from a gigabyte up, whole MB below, never negative", () => {
  const size = sizeFormatter("en-US");
  assert.equal(size(1_400_000_000), "1.4GB");
  assert.equal(size(734_600_000), "735MB");
  assert.equal(size(-5), "0MB");
  const q = queueFormatters("en-US");
  for (const n of [0, 499_999, 734_600_000, 1e9, 12_345_678_901]) assert.equal(q.size(n), size(n), `queue size of ${n}`);
  assert.equal(ageFormatter("en-US")(2.6), "3d");
  assert.equal(ageFormatter("en-US")(-1), "0d");
});
