// Pure rules behind the admin Radarr/Sonarr management surfaces
// (src/lib/arr-parse.ts, arr-title.ts, arr-history.ts, arr-calendar.ts,
// arr-system.ts). The routes that use them are pinned in
// tests/arr-manage-routes.test.mts; these pin the judgements themselves.
import { test } from "node:test";
import assert from "node:assert/strict";
import { maskSecrets, safeMessage, protocolOf } from "../src/lib/arr-parse.ts";
import { editorBody, parseTitleEdit, projectTitle, rootFolderFor } from "../src/lib/arr-title.ts";
import { historyKindOf, parseIdList, parsePaging } from "../src/lib/arr-history.ts";
import { parseCalendarWindow, radarrCalendarEntries, sonarrCalendarEntries } from "../src/lib/arr-calendar.ts";
import { parseProviderEnableChange, projectCommands, projectTasks } from "../src/lib/arr-system.ts";

test("credentials in upstream text are masked, whatever the parameter is called", () => {
  const raw = "GET https://idx.example/api?t=caps&apikey=AAA&passkey=BBB&token=CCC&api_key=DDD failed";
  const masked = maskSecrets(raw);
  for (const secret of ["AAA", "BBB", "CCC", "DDD"]) assert.ok(!masked.includes(secret), secret);
  assert.ok(masked.includes("t=caps"), "ordinary parameters survive");
  assert.equal(safeMessage("line one\nline two token=x"), "line one line two token=••••••••");
  for (const s of ["jackett_apikey=S1", "torrent_pass=S1", "authkey=S1", "rsskey=S1", "https://bob:S1@tracker.example/rss"]) {
    assert.ok(!maskSecrets(s).includes("S1"), s);
  }
  assert.equal(maskSecrets("monkey=1&turkey=2"), "monkey=••••••••&turkey=••••••••", "a *key name is masked even inside a word — over-masking is the safe side");
  assert.equal(safeMessage("   "), null);
});

test("a history record's protocol is read from either spelling", () => {
  assert.equal(protocolOf("1"), "usenet");
  assert.equal(protocolOf("2"), "torrent");
  assert.equal(protocolOf("Torrent"), "torrent");
  assert.equal(protocolOf(undefined), "unknown");
});

test("history kinds map per service — the enums differ past 4", () => {
  assert.equal(historyKindOf("radarr", "movieFileDeleted"), "deleted");
  assert.equal(historyKindOf("sonarr", "seriesFolderImported"), "imported");
  assert.equal(historyKindOf("radarr", 6), "deleted");
  assert.equal(historyKindOf("sonarr", 6), "renamed");
  assert.equal(historyKindOf("sonarr", "somethingNew"), "unknown");
});

test("paging and id lists are bounded and refuse junk", () => {
  assert.deepEqual(parsePaging(null, null), { page: 1, pageSize: 50 });
  assert.equal(parsePaging("0", "50"), null);
  assert.equal(parsePaging("1", "101"), null);
  assert.equal(parsePaging("1e3", null), null);
  assert.deepEqual(parseIdList("3,3,4"), [3, 4]);
  assert.equal(parseIdList("3,-4"), null);
  assert.equal(parseIdList(""), null);
  assert.equal(parseIdList(Array.from({ length: 501 }, (_, i) => i + 1).join(",")), null);
});

test("an edit refuses the other service's fields and anything outside the arr's vocabulary", () => {
  assert.equal(parseTitleEdit("radarr", { seasons: [{ seasonNumber: 1, monitored: true }] }), null);
  assert.equal(parseTitleEdit("sonarr", { minimumAvailability: "released" }), null);
  assert.equal(parseTitleEdit("sonarr", { seriesType: "weekly" }), null);
  assert.equal(parseTitleEdit("sonarr", { seasons: [{ seasonNumber: 1, monitored: true }, { seasonNumber: 1, monitored: false }] }), null, "a season twice");
  assert.equal(parseTitleEdit("radarr", { tags: [1, 0] }), null);
  assert.deepEqual(parseTitleEdit("radarr", { tags: [2, 2, 1], monitored: false }), { tags: [2, 1], monitored: false });
});

test("the editor body carries only what changed; moveFiles is only ever true with a new root folder", () => {
  assert.equal(editorBody("radarr", 1, { moveFiles: true }, { rootFolderPath: "/m/" }), null);
  assert.deepEqual(editorBody("sonarr", 2, { seriesType: "anime", rootFolderPath: "/anime/", moveFiles: true }, { rootFolderPath: "/tv/" }), {
    seriesIds: [2], seriesType: "anime", rootFolderPath: "/anime/", moveFiles: true,
  });
  assert.deepEqual(editorBody("radarr", 1, { qualityProfileId: 3, moveFiles: true }, { rootFolderPath: "/m/" }), {
    movieIds: [1], qualityProfileId: 3, moveFiles: false,
  });
});

test("a root folder is found by the longest prefix, on either separator", () => {
  const roots = ["/data/", "/data/movies/", "D:\\Films\\"];
  assert.equal(rootFolderFor("/data/movies/Heat (1995)", roots), "/data/movies/");
  assert.equal(rootFolderFor("D:\\Films\\Heat (1995)", roots), "D:\\Films\\");
  assert.equal(rootFolderFor("/elsewhere/Heat", roots), null);
  assert.equal(rootFolderFor("/database/x", ["/data"]), null, "a prefix must end at a separator");
});

test("a series' totals exclude specials; a v3 series without monitorNewItems reads null", () => {
  const t = projectTitle("sonarr", "", {
    id: 5, title: "X", seasons: [
      { seasonNumber: 0, monitored: false, statistics: { episodeCount: 4, episodeFileCount: 0 } },
      { seasonNumber: 1, monitored: true, statistics: { episodeCount: 10, episodeFileCount: 7, nextAiring: "2026-11-01T00:00:00Z" } },
    ],
  });
  assert.ok(t);
  assert.deepEqual([t.episodeCount, t.episodeFileCount, t.hasFile, t.monitorNewItems], [10, 7, true, null]);
  assert.equal(t.nextAiring, "2026-11-01T00:00:00.000Z");
  assert.equal(projectTitle("radarr", "", { title: "no id" }), null);
});

test("calendar statuses: a cinema date never reads as missing; an unmonitored series wins over the episode's flag", () => {
  const now = Date.parse("2026-10-10T12:00:00Z");
  const movies = radarrCalendarEntries("", [{
    id: 1, title: "M", monitored: true, hasFile: false,
    inCinemas: "2026-10-01T00:00:00Z", digitalRelease: "2026-10-05T00:00:00Z", physicalRelease: "2026-12-01T00:00:00Z",
  }], Date.parse("2026-10-01T00:00:00Z"), Date.parse("2026-11-01T00:00:00Z"), now);
  assert.deepEqual(movies.map((e) => [e.kind, e.status]), [["cinema", "released"], ["digital", "missing"]], "the physical date is outside the window");
  const eps = sonarrCalendarEntries("", [
    { id: 1, seriesId: 9, airDateUtc: "2026-10-09T01:00:00Z", monitored: true, hasFile: false, series: { title: "S", monitored: false } },
    { id: 2, seriesId: 9, airDateUtc: "2026-10-09T01:00:00Z", monitored: true, hasFile: true, series: { title: "S", monitored: false } },
  ], now);
  assert.deepEqual(eps.map((e) => e.status), ["unmonitored", "downloaded"]);
});

test("the calendar window is two instants, in order, at most 62 days apart", () => {
  assert.ok(parseCalendarWindow("2026-10-01T00:00:00Z", "2026-12-02T00:00:00Z"));
  assert.equal(parseCalendarWindow("2026-10-01T00:00:00Z", "2026-12-03T00:00:00Z"), null);
  assert.equal(parseCalendarWindow("2026-10-02T00:00:00Z", "2026-10-01T00:00:00Z"), null);
  assert.equal(parseCalendarWindow("yesterday", "2026-10-01T00:00:00Z"), null);
});

test("commands: `name` is the command, `commandName` the label — a running task is matched on the command", () => {
  const rows = projectCommands([
    { id: 1, name: "RssSync", commandName: "Rss Sync", status: "Started", trigger: "manual", started: "2026-10-10T10:00:00Z", body: { secret: 1 } },
    { id: 2, name: "Backup", commandName: "Backup", status: "queued", queued: "2026-10-10T11:00:00Z" },
  ]);
  assert.deepEqual(rows.map((r) => [r.id, r.commandName, r.name, r.status]), [[2, "Backup", "Backup", "queued"], [1, "RssSync", "Rss Sync", "started"]]);
  assert.ok(!JSON.stringify(rows).includes("secret"));
  const tasks = projectTasks([{ taskName: "RssSync", name: "RSS Sync", interval: 15, lastDuration: "00:00:02.5" }, { taskName: "bad name!" }]);
  assert.deepEqual(tasks.map((t) => [t.taskName, t.lastDurationSeconds]), [["RssSync", 2]], "whole seconds, as the queue reads TimeSpans");
});

test("a provider switch names only its own kind's flags", () => {
  assert.deepEqual(parseProviderEnableChange("indexer", { enableRss: false }), { enableRss: false });
  assert.equal(parseProviderEnableChange("indexer", { enable: false }), null);
  assert.equal(parseProviderEnableChange("downloadClient", { enableRss: true }), null);
  assert.equal(parseProviderEnableChange("downloadClient", {}), null);
  assert.equal(parseProviderEnableChange("downloadClient", { enable: "no" }), null);
});
