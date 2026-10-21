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

test("credentials are masked in JSON, header, auth-scheme, encoded and path forms too", () => {
  const cases = [
    `{"apiKey":"S1SECRET","name":"x"}`,
    `{"apiKey": "S1SECRET"}`,
    "X-Api-Key: S1SECRET",
    "api_key = S1SECRET",
    "passkey:S1SECRET",
    "Authorization: Bearer S1SECRET.part",
    "Authorization: Basic S1SECRET==",
    "https://idx.example/api?url=https%3A%2F%2Fx%3Fapikey%3DS1SECRET",
    "https://bob:pa@ss:S1SECRET@tracker.example/rss",
    "https://tracker.example/rss/0123456789abcdef0123456789abcdefS1SECRET/feed",
    "https://tracker.example/announce/S1SECRET0123456789abcdef0123456789abcdef",
  ];
  for (const s of cases) assert.ok(!maskSecrets(s).includes("S1SECRET"), s);
  assert.equal(maskSecrets(`{"apiKey":"abc","name":"x"}`), `{"apiKey":"••••••••","name":"x"}`, "JSON stays JSON");
  assert.equal(maskSecrets("Unable to connect to indexer: timed out"), "Unable to connect to indexer: timed out", "ordinary prose survives");
  assert.equal(maskSecrets("https://host.example/movies/Some Title (2020)"), "https://host.example/movies/Some Title (2020)", "short path segments survive");
});

// Each case names the rule that masks it — removing that rule must fail here.
test("credentials are masked in the arrs' own `at [<url>]` form, quoted values, any Authorization header, and tracker path keys", () => {
  const T32 = "0123456789abcdef0123456789abcdef";
  const cases: Array<[string, string]> = [
    [`HTTP request failed: [404:NotFound] [GET] at [https://tracker.example/rss/${T32}S1SECRET]`, "PATH_TOKEN ends at ]"],
    [`(https://tracker.example/rss/${T32}S1SECRET)`, "PATH_TOKEN ends at )"],
    [`https://tracker.example/rss/${T32}S1SECRET, then`, "PATH_TOKEN ends at ,"],
    [`https://tracker.example/rss/12345.${T32}S1SECRET`, "PATH_TOKEN starts after ."],
    [`https://tracker.example/torrent/download/12345.${T32}S1SECRET`, "PATH_TOKEN starts after . (UNIT3D download)"],
    [`https://tracker.example/dl/${T32}S1SECRET.torrent`, "PATH_TOKEN ends at ."],
    [`{"password":"pa;ss S1SECRET"}`, "QUOTED_PAIR: ; and a space inside the quotes"],
    [`{"password": "p,ss word S1SECRET"}`, "QUOTED_PAIR: , inside the quotes"],
    [`ApiKey="SE CRET S1SECRET"`, "QUOTED_PAIR after ="],
    [`apikey: "S1SECRET with space"`, "QUOTED_PAIR, unquoted name"],
    [String.raw`{\"apiKey\":\"S1SECRET\"}`, "QUOTED_PAIR, escaped JSON"],
    [String.raw`{"apiKey":"pa\"ss S1SECRET"}`, "QUOTED_PAIR, an escaped quote inside the value"],
    ["Authorization: Token S1SECRET", "AUTH_HEADER, any scheme"],
    [`{"Authorization":"Token S1SECRET"}`, "AUTH_HEADER, JSON"],
    ["authorization: bearer S1SECRET.x", "lower-case Authorization"],
    ["sent bearer S1SECRET.x to the indexer", "lower-case bearer, no header name"],
    ["apikey%253DS1SECRET", "%253D (double-encoded =)"],
    ["https://rss24h.torrentleech.org/S1SECRETabcdef1234", "TORRENTLEECH rss key"],
    ["https://www.torrentleech.org/rss/download/12345/S1SECRETabcdef/name.torrent", "TORRENTLEECH download key"],
    ["https://iptorrents.com/t.rss?u=123;tp=abcdefS1SECRET;download", "IPTorrents tp="],
    ["x1apikey=S1SECRET", "a digit in the name's prefix"],
  ];
  for (const [s, rule] of cases) assert.ok(!maskSecrets(s).includes("S1SECRET"), `${rule}: ${s} → ${maskSecrets(s)}`);
  assert.equal(maskSecrets(`{"password":"a b","name":"x"}`), `{"password":"••••••••","name":"x"}`, "a quoted value is masked to ITS closing quote, not the next one");
  assert.equal(maskSecrets("Authorization failed for user"), "Authorization failed for user", "prose survives");
  assert.equal(maskSecrets("/downloads/Breaking.Bad.S01E01.1080p.mkv"), "/downloads/Breaking.Bad.S01E01.1080p.mkv", "short dotted segments survive");
});

test("masking is linear: a long run of name characters can't stall the server", () => {
  // Unbounded, SECRET_NAME's prefix made this quadratic — ~3 s per run at this
  // size, against a few milliseconds bounded. (A synchronous regex blocks the
  // event loop, so a test timeout could never fire: the time is measured.)
  for (const run of ["a-".repeat(30_000), "a_".repeat(30_000)]) {
    const started = performance.now();
    assert.equal(maskSecrets(run), run);
    const ms = performance.now() - started;
    assert.ok(ms < 1_000, `${ms.toFixed(0)} ms for ${run.length} characters`);
    assert.ok(!safeMessage(`x ${run} apikey=S1SECRET`)?.includes("S1SECRET"));
  }
});

test("an unclosed quoted value full of escapes can't stall the server", () => {
  // QUOTED_PAIR's value once read `(?:\\.|.)*` — both branches eat a
  // backslash, so with no closing quote each escape doubled the backtracking:
  // ~1 s at 26 escapes, hours at 40. A release or file name the arrs quote in a
  // status or failure message is enough to reach it. (A synchronous regex
  // blocks the event loop, so a test timeout could never fire: the time is
  // measured.)
  const inputs = [
    () => maskSecrets(`password: "${"\\a".repeat(40)}`),
    () => safeMessage(`Import failed: file \`Show.S01E01 token: "${"\\x".repeat(40)}.mkv\` could not be parsed`),
    // safeMessage's own cut leaves exactly this unclosed shape behind.
    () => safeMessage(`{"password": "${"\\x".repeat(3_000)}`, 300),
    () => maskSecrets(String.raw`{\"apiKey\":\"` + "\\\\x".repeat(40)),
  ];
  for (const run of inputs) {
    const started = performance.now();
    run();
    const ms = performance.now() - started;
    assert.ok(ms < 200, `${ms.toFixed(0)} ms`);
  }
  assert.ok(!safeMessage(`{"password": "${"\\x".repeat(3_000)}`, 300)?.includes("\\x\\x"), "the value the cut left open never shows");
  // Still masked as before: an escaped quote inside, an escaped-JSON close, and
  // a value that ends in a lone backslash before its quote.
  assert.equal(maskSecrets(String.raw`{"apiKey":"pa\"ss S1"}`), `{"apiKey":"••••••••"}`);
  assert.equal(maskSecrets(String.raw`{\"apiKey\":\"S1 x\",\"n\":1}`), String.raw`{\"apiKey\":\"••••••••\",\"n\":1}`);
  assert.equal(maskSecrets(String.raw`password: "pa ss\" rest`), `password: "••••••••" rest`);
});

test("safeMessage masks a bounded prefix, and a credential the cut went through never shows", () => {
  // Only a bounded prefix is masked: text far past the answer never reaches it,
  // even when a long masked value shortens what comes before.
  assert.equal(safeMessage(`token=${"A".repeat(10_000)} TAILWORD`, 300), "token=••••••••");
  // Four long secrets shrink to a few characters each, so what straddled the
  // cut (max + 4 KB) moves into the first `max` characters.
  const shrink = Array.from({ length: 4 }, () => `token=${"A".repeat(1_000)} `).join("");
  const quoted = safeMessage(`${shrink}"apiKey": "SECRETVALUE ${"word ".repeat(300)}"`, 300);
  assert.ok(quoted && !quoted.includes("SECRETV"), `an unclosed quoted value at the cut is masked: ${quoted}`);
  // One long secret, then a URL whose path key the cut leaves 20 characters of
  // — too short for PATH_TOKEN to recognise.
  const lead = `token=${"A".repeat(300 + 4_096 - 6 - 1 - "https://tracker.example/rss/".length - 20)} `;
  const path = safeMessage(`${lead}https://tracker.example/rss/PATHKEY${"k".repeat(33)}`, 300);
  assert.ok(path !== null && !path.includes("PATHKEY"), `half a path key at the cut is dropped: ${path}`);
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

import { editorBody as __editorBody } from "../src/lib/arr-title.ts";
import { test as __t } from "node:test";
import __assert from "node:assert/strict";
__t("editorBody: a trailing slash on the root folder is not a move", () => {
  const same = __editorBody("sonarr", 1, { rootFolderPath: "/tv/", monitored: true } as never, { rootFolderPath: "/tv" });
  __assert.equal(same?.rootFolderPath, undefined);
  const moved = __editorBody("sonarr", 1, { rootFolderPath: "/anime/" } as never, { rootFolderPath: "/tv" });
  __assert.equal(moved?.rootFolderPath, "/anime/");
});
