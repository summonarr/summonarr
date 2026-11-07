// A history list's grab states, read ONCE per list (grabStatesFor), are exactly
// what grabStateOf answers row by row — and the list is read a bounded number
// of times, never once per row (a whole series' history is thousands of
// records; the list re-renders on every expand or confirm — guardrail 5i).
import { test } from "node:test";
import assert from "node:assert/strict";
import type { ArrHistoryEvent } from "../src/lib/arr-history.ts";

const { grabStateOf, grabStatesFor, groupHistoryEvents, projectHistoryRecords } = await import("../src/lib/arr-history.ts");

function assertSameAsPerRow(events: ArrHistoryEvent[], label: string) {
  const rows = groupHistoryEvents(events);
  const all = grabStatesFor(rows, events);
  assert.equal(all.size, rows.length, `${label}: one state per row`);
  for (const row of rows) {
    assert.deepEqual(all.get(row.key), grabStateOf(row, events), `${label}: row ${row.key}`);
  }
}

test("the id-less grab fixtures: a newer failure of the same release and episode fails it, nothing else does", () => {
  const sonarr = projectHistoryRecords("sonarr", "", [
    { id: 80, seriesId: 21, eventType: "grabbed", date: "2026-10-01T10:00:00Z", sourceTitle: "Show.S02.1080p", episodeId: 201 },
    { id: 81, seriesId: 21, eventType: "grabbed", date: "2026-10-01T10:00:00Z", sourceTitle: "Show.S02.1080p", episodeId: 202 },
    { id: 82, seriesId: 21, eventType: "grabbed", date: "2026-10-01T10:00:00Z", sourceTitle: "Other.Release", episodeId: 203 },
    { id: 83, seriesId: 21, eventType: "downloadFailed", date: "2026-10-01T11:00:00Z", sourceTitle: "Show.S02.1080p", episodeId: 201 },
    { id: 84, seriesId: 99, eventType: "downloadFailed", date: "2026-10-01T11:00:00Z", sourceTitle: "Other.Release", episodeId: 203 },
    { id: 85, seriesId: 21, eventType: "grabbed", date: "2026-10-01T10:00:00Z", sourceTitle: "Release.A", episodeId: 204 },
    { id: 86, seriesId: 21, eventType: "downloadFailed", date: "2026-10-01T11:00:00Z", sourceTitle: "Release.B", episodeId: 204 },
  ]);
  assertSameAsPerRow(sonarr, "sonarr id-less");
  const states = grabStatesFor(groupHistoryEvents(sonarr), sonarr);
  assert.deepEqual(states.get(":80"), { failed: true, imported: false });
  assert.deepEqual(states.get(":81"), { failed: false, imported: false });
  const unknownEp = projectHistoryRecords("sonarr", "", [
    { id: 60, seriesId: 21, eventType: "grabbed", sourceTitle: "Show.S02.1080p" },
    { id: 61, seriesId: 21, eventType: "downloadFailed", sourceTitle: "Show.S02.1080p" },
  ]);
  assertSameAsPerRow(unknownEp, "no episode id");
  assert.deepEqual(grabStatesFor(groupHistoryEvents(unknownEp), unknownEp).get(":60"), { failed: false, imported: false });
  const radarr = projectHistoryRecords("radarr", "", [
    { id: 90, movieId: 11, eventType: "downloadFailed", date: "2026-09-01T11:00:00Z", sourceTitle: "Movie.1080p" },
    { id: 91, movieId: 11, eventType: "grabbed", date: "2026-10-01T10:00:00Z", sourceTitle: "Movie.1080p" },
    { id: 92, movieId: 12, eventType: "grabbed", date: "2026-10-01T10:00:00Z", sourceTitle: "Other.1080p" },
    { id: 93, movieId: 12, eventType: "downloadFailed", date: "2026-10-02T10:00:00Z", sourceTitle: "Other.1080p" },
  ]);
  assertSameAsPerRow(radarr, "radarr id-less");
  const r = grabStatesFor(groupHistoryEvents(radarr), radarr);
  assert.deepEqual(r.get(":91"), { failed: false, imported: false }, "an OLDER failure never counts");
  assert.deepEqual(r.get(":92"), { failed: true, imported: false });
});

test("the download-keyed fixtures: a pack's newer failures and imports, a re-grab after a failure, another download's records", () => {
  const ep = (id: number, eventType: string, downloadId: string | null, [s, e]: [number, number], minute = 0) => ({
    id, seriesId: 21, eventType, downloadId, episodeId: s * 100 + e,
    date: new Date(Date.UTC(2026, 9, 1, 10, minute)).toISOString(), sourceTitle: "Show.S02",
    episode: { seasonNumber: s, episodeNumber: e },
  });
  const lists = {
    regrab: [ep(22, "grabbed", "HASH", [1, 1], 30), ep(21, "downloadFailed", "HASH", [1, 1], 20), ep(20, "grabbed", "HASH", [1, 1])],
    pack: [
      ep(15, "downloadFailed", "PACK", [2, 2], 9), ep(14, "downloadFailed", "PACK", [2, 1], 9), ep(13, "downloadFolderImported", "PACK", [2, 1], 8),
      ep(10, "grabbed", "PACK", [2, 2]), ep(9, "grabbed", "PACK", [2, 1]), ep(5, "downloadFailed", "OTHER", [3, 1]),
    ],
    elsewhere: [ep(12, "downloadFailed", "ELSE", [2, 1], 9), ep(11, "downloadFolderImported", "ELSE", [2, 1], 8), ep(10, "grabbed", "PACK", [2, 2]), ep(9, "grabbed", "PACK", [2, 1])],
  };
  for (const [label, raw] of Object.entries(lists)) assertSameAsPerRow(projectHistoryRecords("sonarr", "", raw), label);
  const pack = projectHistoryRecords("sonarr", "", lists.pack);
  const lead = groupHistoryEvents(pack).find((row) => row.lead.id === 10)!;
  assert.deepEqual(grabStatesFor(groupHistoryEvents(pack), pack).get(lead.key), { failed: true, imported: true });
});

test("over thousands of generated lists, every row's state equals grabStateOf's", () => {
  // A small deterministic generator: the lists mix both services, two
  // instances, keyed and id-less downloads, episode ids present or not, and
  // ids in any order — every axis grabStateOf / failsIdlessGrab compares.
  let seed = 0x9e3779b9;
  const rnd = (n: number) => {
    seed = (Math.imul(seed ^ (seed >>> 15), 0x2c1b3c6d) + 0x6d2b79f5) >>> 0;
    return seed % n;
  };
  const kinds = ["grabbed", "downloadFailed", "downloadFolderImported", "episodeFileDeleted", "grabbed", "downloadFailed"];
  for (let list = 0; list < 2_000; list++) {
    const ids = Array.from({ length: 1 + rnd(14) }, (_, i) => i + 1).sort(() => rnd(3) - 1);
    const events: ArrHistoryEvent[] = [];
    for (const id of ids) {
      const service = rnd(4) === 0 ? "radarr" : "sonarr";
      const raw = {
        id,
        eventType: kinds[rnd(kinds.length)],
        date: new Date(Date.UTC(2026, 9, 1, 10, rnd(30))).toISOString(),
        sourceTitle: ["A", "B", ""][rnd(3)],
        downloadId: rnd(2) === 0 ? null : ["D1", "D2"][rnd(2)],
        movieId: rnd(5) === 0 ? null : 1 + rnd(2),
        seriesId: rnd(5) === 0 ? null : 1 + rnd(2),
        episodeId: rnd(3) === 0 ? null : 1 + rnd(2),
      };
      events.push(...projectHistoryRecords(service, ["", "4k"][rnd(2)], [raw]));
    }
    assertSameAsPerRow(events, `list ${list}`);
  }
});

test("the list is read a bounded number of times — never once per row", () => {
  const raw = [];
  // 3,000 records: every grab its own download, failures and imports between.
  for (let i = 1; i <= 3_000; i++) {
    const kind = i % 3 === 0 ? "grabbed" : i % 3 === 1 ? "downloadFailed" : "downloadFolderImported";
    raw.push({ id: i, movieId: 1 + (i % 7), eventType: kind, sourceTitle: `R${i % 11}`, downloadId: i % 5 === 0 ? null : `D${i % 13}` });
  }
  const events = projectHistoryRecords("radarr", "", raw);
  const rows = groupHistoryEvents(events);
  let reads = 0;
  const counted = new Proxy(events, {
    get(target, prop, receiver) {
      if (typeof prop === "string" && /^\d+$/.test(prop)) reads++;
      return Reflect.get(target, prop, receiver);
    },
  });
  const states = grabStatesFor(rows, counted);
  assert.equal(states.size, rows.length);
  assert.ok(reads <= 2 * events.length, `read ${reads} elements for ${events.length} records and ${rows.length} rows`);
  for (const row of rows.slice(0, 200)) assert.deepEqual(states.get(row.key), grabStateOf(row, events));
});
