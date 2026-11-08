// What the issue "Fix file" window reads from its routes
// (src/components/admin/issue-fix-answers.ts): every answer is checked before
// the window renders it, and a replace that deleted nothing is never shown as done.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const { releaseListOf, fileListingOf, replaceResultOf } = await import("../src/components/admin/issue-fix-answers.ts");
const { functionBody } = await import("./structural-pin-source-scan.mts");

const release = {
  guid: "g1", title: "Some.Release.1080p", size: 1e9, indexerId: 3, indexer: "idx",
  quality: { quality: { id: 7, name: "Bluray-1080p" }, revision: { version: 1 } },
  qualityWeight: 10, releaseWeight: null, customFormatScore: null, customFormats: [], languages: ["English"],
  protocol: "torrent", seeders: 5, leechers: null, age: 3, rejected: false, rejections: [], downloadAllowed: true,
};

test("a release list is offered only when every release has the shape the picker reads", () => {
  assert.deepEqual(releaseListOf([release]), [release]);
  assert.deepEqual(releaseListOf([]), [], "an empty answer is an empty list, not a failure");
  assert.equal(releaseListOf([{ ...release, quality: { ...release.quality, quality: { id: 7 } } }]), null, "no quality name: the render read rel.quality.quality.name");
  assert.equal(releaseListOf([{ ...release, quality: { quality: release.quality.quality } }]), null, "no revision: the render read rel.quality.revision.version");
  assert.equal(releaseListOf([{ ...release, rejections: null }]), null);
  assert.equal(releaseListOf({ error: "nope" }), null);
  assert.equal(releaseListOf(null), null);
});

const file = {
  id: 1, relativePath: "Season 1/e01.mkv", path: "/tv/x/Season 1/e01.mkv", size: 100, quality: "WEBDL-1080p",
  qualityCutoffNotMet: false, languages: [], releaseGroup: null,
  episodes: [{ seasonNumber: 1, episodeNumber: 1, title: "Pilot" }], grab: { failed: false, event: { sourceTitle: "rel" } },
};

test("a file listing is read field by field: counts default, a wrong shape is a failed read", () => {
  assert.deepEqual(fileListingOf({ files: [file], otherFiles: 3, seriesType: "anime" }), { files: [file], otherFiles: 3, seriesType: "anime" });
  assert.deepEqual(fileListingOf({ files: [] }), { files: [], otherFiles: 0, seriesType: null });
  assert.equal(fileListingOf({ files: [{ ...file, episodes: "S01E01" }] }), null);
  assert.equal(fileListingOf({ error: "Not on this instance" }), null);
});

test("a replace's answer is shown as done only when files went; a 502 carrying what WAS done still shows it", () => {
  assert.deepEqual(replaceResultOf({ deleted: 2, requested: 2, marked: 1, unmarked: 0, searched: true, redownload: true, redownloading: 1, remonitored: 0, remonitorFailed: false, nothingMissing: false }), {
    deleted: 2, marked: 1, unmarked: 0, searched: true, redownloading: 1, remonitored: 0, remonitorFailed: false, nothingMissing: false,
  });
  assert.equal(replaceResultOf({ deleted: 0, requested: 1 }), null, "nothing deleted is not a result");
  assert.equal(replaceResultOf({ error: "refused" }), null);
  assert.equal(replaceResultOf(null), null);
  assert.equal(replaceResultOf({ deleted: 1, marked: "x" })?.marked, 0, "a count that isn't one reads 0");
});

test("a 2xx replace that deleted nothing says so and re-reads the files — never a silent close", () => {
  const src = readFileSync(new URL("../src/components/admin/issue-fix-options.tsx", import.meta.url), "utf8");
  const replaceFn = functionBody(src, "async function replace(");
  assert.match(replaceFn, /const done = replaceResultOf\(answer\.data\);/);
  assert.match(replaceFn, /if \(answer\.status < 200 \|\| answer\.status >= 300 \|\| !done\) \{\s*setActionError\(apiErrorText\(answer\.data, t\("adminQueue\.issueActions\.replaceFileFailed"\)\)\);\s*reload = true;/);
});

test("the release list and the files are checked before they render", () => {
  const actions = readFileSync(new URL("../src/components/admin/issue-actions.tsx", import.meta.url), "utf8");
  const load = functionBody(actions, "async function loadReleases(");
  assert.match(load, /releaseListOf\(answer\.data\)/);
  assert.doesNotMatch(actions, /as ArrRelease\[\]/, "no unchecked cast of the answer");
  const options = readFileSync(new URL("../src/components/admin/issue-fix-options.tsx", import.meta.url), "utf8");
  assert.match(options, /const read = res\.ok \? fileListingOf\(res\.data\) : null;/);
  assert.doesNotMatch(options, /as Partial<FileListing>|as Partial<ReplaceResult>/);
});

test("the delete's confirm takes focus as it opens, and a Cancel gives it back to Delete", () => {
  const parts = readFileSync(new URL("../src/components/admin/issue-fix-options-parts.tsx", import.meta.url), "utf8");
  const confirm = parts.slice(parts.indexOf("export function ReplaceConfirm("));
  assert.match(confirm, /useEffect\(\(\) => \{\s*cancelRef\.current\?\.focus\(\);\s*\}, \[\]\);/);
  assert.match(confirm, /<Button ref=\{cancelRef\} variant="ghost"/);
  assert.match(parts, /ref=\{deleteRef\}/);
  const options = readFileSync(new URL("../src/components/admin/issue-fix-options.tsx", import.meta.url), "utf8");
  assert.match(options, /onCancel=\{\(\) => \{ refocusDelete\.current = true; setConfirming\(false\); \}\}/);
  assert.match(options, /if \(!confirming && refocusDelete\.current\) \{\s*refocusDelete\.current = false;\s*deleteRef\.current\?\.focus\(\);/);
});
