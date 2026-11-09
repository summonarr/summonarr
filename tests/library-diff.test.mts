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
  // The run is the shared one (fix-all-run.tsx, its loop in fix-all-sequence.ts),
  // the same as the library match check's.
  const run = readFileSync(new URL("../src/components/admin/fix-all-run.tsx", import.meta.url), "utf8");
  const loop = readFileSync(new URL("../src/lib/client/fix-all-sequence.ts", import.meta.url), "utf8");
  const control = run.slice(run.indexOf("export function FixAllControl("));
  assert.match(control, /ref=\{triggerRef\}\s*type="button"\s*onClick=\{run\.askConfirm\}/, "the first click opens a confirm step");
  assert.match(run, /askConfirm: \(\) => setState\("confirm"\),/);
  assert.match(control, /onClick=\{\(\) => \{ refocus\.current = true; onConfirm\(\); \}\}/, "only the confirm's own button starts the run");
  assert.equal(control.match(/onConfirm\(\)/g)?.length, 1);
  assert.match(run, /stop: \(\) => \{ stopRef\.current = true; abortRef\.current\?\.abort\(\); \},/, "Stop also ends the wait on the title in flight");
  assert.match(loop, /for \(const entry of entries\) \{\s*if \(deps\.stopped\(\)\) break;/, "the loop checks the stop flag between titles");
  assert.match(run, /return \(\) => \{ alive\.current = false; stopRef\.current = true; abortRef\.current\?\.abort\(\); \};/, "unmount aborts the status poll");
  const src = readFileSync(new URL("../src/components/admin/library-diff-client.tsx", import.meta.url), "utf8");
  assert.match(src, /const fixAll = useFixAllRun\(\);/);
  assert.doesNotMatch(src, /function FixAllArrButton|runFixMatch\(/, "no private copy of the loop");
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

import { badMatchSideKey, fixAllEligible } from "../src/lib/library-diff.ts";
test("Fix all sends only what the cards offer a Fix for: a verdict, the id, and that side's item key", () => {
  const m = (o: Record<string, unknown>) => ({ arrVerdict: "plex" as "plex" | "jellyfin" | null, arrTmdbId: 5 as number | null, plexRatingKey: "1001" as string | null, jellyfinItemId: "abcd" as string | null, ...o });
  assert.equal(fixAllEligible(m({})), true);
  assert.equal(fixAllEligible(m({ arrVerdict: "jellyfin" })), true);
  assert.equal(fixAllEligible(m({ plexRatingKey: null })), false, "a Plex verdict with no ratingKey says re-sync to fix");
  assert.equal(fixAllEligible(m({ plexRatingKey: "" })), false);
  assert.equal(fixAllEligible(m({ arrVerdict: "jellyfin", jellyfinItemId: null })), false, "a Jellyfin verdict with no item id too");
  assert.equal(fixAllEligible(m({ arrVerdict: "jellyfin", plexRatingKey: null })), true, "only the WRONG side's key matters");
  assert.equal(fixAllEligible(m({ arrVerdict: null })), false);
  assert.equal(fixAllEligible(m({ arrTmdbId: null })), false);
  assert.equal(badMatchSideKey(m({}), "plex"), "1001");
  assert.equal(badMatchSideKey(m({ jellyfinItemId: "" }), "jellyfin"), null);
});

test("structural: Fix all filters with that rule, the cards use the same key rule, and the run outlives the list emptying", () => {
  const src = readFileSync(new URL("../src/components/admin/library-diff-client.tsx", import.meta.url), "utf8");
  const section = src.slice(src.indexOf("function BadMatchSection("), src.indexOf("export function LibraryDiffClient("));
  assert.match(section, /const fixable = matches\.filter\(fixAllEligible\);/);
  assert.match(section, /onConfirm=\{\(\) => void fixAll\.start\(fixable\.map\(badMatchFixEntry\)\)\}/);
  // Both columns are one component, so the card's key rule is written once.
  assert.match(src, /\} else if \(badMatchSideKey\(match, side\)\) \{/);
  assert.match(src, /<BadMatchColumn match=\{match\} side="plex" /);
  assert.match(src, /<BadMatchColumn match=\{match\} side="jellyfin" /);
  // Searching every match away, or a run that fixed them all, used to unmount
  // the button — which stopped the run and discarded its results. The run now
  // lives in the page, and the section stays once it started.
  const run = readFileSync(new URL("../src/components/admin/fix-all-run.tsx", import.meta.url), "utf8");
  assert.match(run, /stopRef\.current = false;\s*setStarted\(true\);/);
  assert.match(src, /const fixAllStarted = fixAll\.started;/);
  assert.match(src, /\{\(filteredBadMatches\.length > 0 \|\| fixAllStarted\) && \(\s*<BadMatchSection /);
  assert.doesNotMatch(src, /\{filteredBadMatches\.length > 0 && \(/);
});

test("structural: while Fix all runs, a card offers no Fix for a side the run still has to do", () => {
  const src = readFileSync(new URL("../src/components/admin/library-diff-client.tsx", import.meta.url), "utf8");
  // The card checks the same key the run's entry carries.
  assert.match(src, /key: badMatchFixKey\(match\.arrVerdict, wrongItem\),/);
  assert.match(src, /locked=\{pending\.has\(badMatchFixKey\("plex", match\.plex\)\)\}/);
  assert.match(src, /locked=\{pending\.has\(badMatchFixKey\("jellyfin", match\.jellyfin\)\)\}/);
  const column = src.slice(src.indexOf("function BadMatchColumn("), src.indexOf("function BadMatchCard("));
  const locked = column.indexOf("} else if (locked) {");
  assert.ok(locked > 0 && locked < column.indexOf("<FixMatchButton"), "the lock is checked before the Fix is offered");
  assert.match(src, /pending=\{fixAll\.pending\}/);
});

test("structural: the bad-match list is drawn under a cap, with the same notice as the columns", () => {
  const src = readFileSync(new URL("../src/components/admin/library-diff-client.tsx", import.meta.url), "utf8");
  const section = src.slice(src.indexOf("function BadMatchSection("), src.indexOf("export function LibraryDiffClient("));
  assert.match(section, /\{matches\.slice\(0, BAD_MATCH_RENDER_CAP\)\.map\(\(match\) => \(/);
  assert.doesNotMatch(section, /\{matches\.map\(/, "never every card");
  assert.match(section, /\{matches\.length > BAD_MATCH_RENDER_CAP && \(/);
  assert.match(section, /t\("adminManage\.library\.diff\.renderCap", \{ cap: BAD_MATCH_RENDER_CAP\.toLocaleString\(locale\)/);
});
