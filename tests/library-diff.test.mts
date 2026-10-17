// Pins src/lib/library-diff.ts: attention rows sort first, the order is total
// (stable across renders), and the source of a one-sided title is named.
import test from "node:test";
import assert from "node:assert/strict";
import { diffCollator, diffSourceFor, makeBadMatchComparator, makeDiffComparator, needsAttention } from "../src/lib/library-diff.ts";

const c = diffCollator("en");
const row = (o: Record<string, unknown>) => ({ tmdbId: 1, mediaType: "MOVIE" as const, serverInstance: "", title: "A", arrMismatch: false, diffSource: null, ...o });

test("attention rows sort ahead of plain misses regardless of title", () => {
  const rows = [row({ title: "Aaa" }), row({ tmdbId: 2, title: "Zzz", arrMismatch: true }), row({ tmdbId: 3, title: "Mmm", diffSource: { kind: "idMismatch" } })];
  assert.deepEqual(rows.sort(makeDiffComparator(c)).map((r) => r.title), ["Mmm", "Zzz", "Aaa"]);
});

test("ties break on tmdbId then serverInstance; titles sort numerically; untitled last", () => {
  const rows = [row({ tmdbId: 9, title: "Movie 10" }), row({ tmdbId: 8, title: "Movie 2" }), row({ tmdbId: 7, title: null }),
    row({ tmdbId: 5, title: "Same", serverInstance: "b" }), row({ tmdbId: 5, title: "Same", serverInstance: "a" })];
  const out = rows.sort(makeDiffComparator(c));
  assert.deepEqual(out.map((r) => `${r.title}:${r.serverInstance}`), ["Movie 2:", "Movie 10:", "Same:a", "Same:b", "null:"]);
});

test("diffSourceFor names the cause", () => {
  const other = new Map([["Film (2020)/a.mkv", { tmdbId: 5, mediaType: "MOVIE" as const, serverInstance: "", title: "Other" }]]);
  const unmatched = new Set(["MOVIE:gone (2019)"]);
  assert.equal(diffSourceFor("Film (2020)/a.mkv", "film (2020)", "MOVIE", other, unmatched).kind, "idMismatch");
  assert.equal(diffSourceFor("Gone (2019)/g.mkv", "gone (2019)", "MOVIE", other, unmatched).kind, "unmatched");
  assert.equal(diffSourceFor("Lost (2018)/l.mkv", "lost (2018)", "MOVIE", other, unmatched).kind, "notOnOther");
  assert.equal(diffSourceFor(null, null, "MOVIE", other, unmatched).kind, "noPath");
  assert.equal(needsAttention({ arrMismatch: false, diffSource: { kind: "notOnOther" } }), false);
});

test("bad matches: fixable first, then by path", () => {
  const out = [{ relativePath: "b", arrVerdict: null }, { relativePath: "z", arrVerdict: "plex" as const }, { relativePath: "a", arrVerdict: null }].sort(makeBadMatchComparator(c));
  assert.deepEqual(out.map((m) => m.relativePath), ["z", "a", "b"]);
});

// Structural pins for the bulk "Fix all" (no component harness in this repo):
// it must ask before remapping N titles on live media servers, be stoppable,
// and stop when the page goes away.
import { readFileSync } from "node:fs";
test("bulk Fix all asks first, can be stopped, and stops on unmount", () => {
  const src = readFileSync(new URL("../src/components/admin/library-diff-client.tsx", import.meta.url), "utf8");
  const fixAll = src.slice(src.indexOf("function FixAllArrButton"), src.indexOf("function ArrFilterButton"));
  assert.match(fixAll, /onClick=\{\(\) => setRunState\("confirm"\)\}/, "the first click opens a confirm step");
  assert.doesNotMatch(fixAll, /onClick=\{handleFixAll\}[^>]*\n[^>]*disabled=\{state === "running"\}/, "the start button must not run the loop directly");
  assert.match(fixAll, /stopRef\.current = true/);
  assert.match(fixAll, /if \(stopRef\.current\) break;/, "the loop checks the stop flag between titles");
  assert.match(fixAll, /abortRef\.current\?\.abort\(\)/, "unmount aborts the status poll");
});

import { folderYear, suggestWrongSide } from "../src/lib/library-diff.ts";
test("folderYear reads the deepest folder's (YYYY), never the file name", () => {
  assert.equal(folderYear("Ghost in the Shell (2017)/Ghost.mkv"), 2017);
  assert.equal(folderYear("Shows/Foo (2013)/Season 1/e01.mkv"), 2013);
  assert.equal(folderYear("Film.2017.1080p.mkv"), null);
  assert.equal(folderYear("NoYear/Film.mkv"), null);
});

test("suggestWrongSide: only when one side fits the folder year and the other is 2+ years off", () => {
  const p = "Ghost in the Shell (2017)/g.mkv";
  assert.deepEqual(suggestWrongSide(p, "1995", "2017"), { wrong: "plex", year: 2017 });
  assert.deepEqual(suggestWrongSide(p, "2017", "1995"), { wrong: "jellyfin", year: 2017 });
  assert.equal(suggestWrongSide(p, "2016", "2017"), null, "both fit");
  assert.equal(suggestWrongSide(p, "1990", "1995"), null, "neither fits");
  assert.deepEqual(suggestWrongSide(p, "2015", "2017"), { wrong: "plex", year: 2017 }, "two years off counts");
  assert.equal(suggestWrongSide(p, null, "2017"), null, "an unknown year is never guessed");
  assert.equal(suggestWrongSide("NoYear/f.mkv", "1995", "2017"), null);
});
