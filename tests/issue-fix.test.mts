// The issue "Fix file" window (src/lib/issue-fix.ts, issue-actions.tsx and
// issue-fix-options.tsx).
//
// Why: Refetch, Replace and Replace file were three buttons for one job, and
// for the usual report — a broken file that already meets the quality cutoff —
// two of them did nothing: the search only takes an upgrade of a file on disk
// (yet said "Search triggered"), and the release list hid nearly every release
// as "rejected" against that file. One window now reads the files first and
// leads with the fix that can work.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { stripTypeScriptTypes } from "node:module";

const { fixAdvice, defaultFileSelection, rejectedOnlyForFileOnDisk, defaultRelease } = await import("../src/lib/issue-fix.ts");
const { functionBody, functionBodyRange, stripComments } = await import("./structural-pin-source-scan.mts");

const here = dirname(fileURLToPath(import.meta.url));
const read = (p: string) => readFileSync(join(here, "..", p), "utf8");

const file = (qualityCutoffNotMet: boolean) => ({ qualityCutoffNotMet });

test("fixAdvice: a file that meets the cutoff leads with delete — a search can't replace it", () => {
  assert.equal(fixAdvice([file(false)]), "broken");
  // Mixed: the search could only touch the file below the cutoff.
  assert.equal(fixAdvice([file(true), file(false)]), "broken");
});

test("fixAdvice: every file below the cutoff, or none on disk, leads with the search", () => {
  assert.equal(fixAdvice([file(true)]), "upgrade");
  assert.equal(fixAdvice([file(true), file(true)]), "upgrade");
  assert.equal(fixAdvice([]), "nothing");
});

test("fixAdvice: files not read (an issue admin, a failed read) is unknown, never 'nothing'", () => {
  assert.equal(fixAdvice(null), "unknown");
});

test("defaultFileSelection: ticks the only file, never a season's worth", () => {
  assert.deepEqual(defaultFileSelection([{ id: 7 }]), [7]);
  assert.deepEqual(defaultFileSelection([{ id: 1 }, { id: 2 }]), []);
  assert.deepEqual(defaultFileSelection([]), []);
});

// The arrs' own wording (UpgradeDiskSpecification.cs, Radarr develop and
// Sonarr main / v5-develop, read 2026-10-28), values filled in.
const DISK_REJECTIONS = [
  "Existing file meets cutoff: Bluray-1080p [x264]",
  "Existing file meets cutoff: WEBDL-1080p",
  "Existing file on disk is of equal or higher preference: Bluray-1080p v1",
  "Existing file on disk is of equal or higher revision: 2",
  "Existing file on disk meets quality cutoff: Bluray-1080p",
  "Existing file on disk meets Custom Format cutoff: 1000",
  "Existing file on disk has a equal or higher Custom Format score: 50",
  "Existing file on disk has Custom Format score within Custom Format score increment: 10",
  "Existing file on disk and Quality Profile 'HD-1080p' does not allow upgrades",
  "Season pack does not meet the upgrade criteria. Upgradable: 0/10 (0%), Mode: Threshold, Threshold: 50%",
];

test("rejectedOnlyForFileOnDisk: every arr wording of 'a file is already on disk' counts", () => {
  for (const reason of DISK_REJECTIONS) {
    assert.equal(rejectedOnlyForFileOnDisk({ rejected: true, rejections: [reason] }), true, reason);
  }
  assert.equal(rejectedOnlyForFileOnDisk({ rejected: true, rejections: DISK_REJECTIONS }), true, "several, all about the file");
});

test("rejectedOnlyForFileOnDisk: any other reason keeps the release rejected", () => {
  assert.equal(
    rejectedOnlyForFileOnDisk({ rejected: true, rejections: [DISK_REJECTIONS[2], "Language is not wanted in profile"] }),
    false,
    "one real reason is enough",
  );
  assert.equal(rejectedOnlyForFileOnDisk({ rejected: true, rejections: ["Not enough seeders"] }), false);
  assert.equal(rejectedOnlyForFileOnDisk({ rejected: true, rejections: [] }), false, "no reason given");
  assert.equal(rejectedOnlyForFileOnDisk({ rejected: false, rejections: [] }), false, "not rejected at all");
  assert.equal(
    rejectedOnlyForFileOnDisk({ rejected: true, rejections: ["Unknown: Existing file on disk is of equal or higher preference"] }),
    false,
    "anchored at the start, not anywhere in the text",
  );
});

test("defaultRelease: what the arr would take first, else the first turned down only for the file on disk, else none", () => {
  const ok = { guid: "a", rejected: false, rejections: [] };
  const disk = { guid: "b", rejected: true, rejections: [DISK_REJECTIONS[0]] };
  const bad = { guid: "c", rejected: true, rejections: ["Not enough seeders"] };
  assert.equal(defaultRelease([disk, ok, bad]), "a");
  assert.equal(defaultRelease([bad, disk]), "b");
  assert.equal(defaultRelease([bad]), null, "never pre-selects a release rejected for its own reasons");
  assert.equal(defaultRelease([]), null);
});

// ── structural: the window ────────────────────────────────────────────────────

const src = read("src/components/admin/issue-actions.tsx");
const dialog = src.slice(src.indexOf("function FixFileDialog("));
const dialogBody = functionBody(src, "function FixFileDialog(");
// The options view: what is on disk, the choices and the delete, per instance.
const optionsSrc = read("src/components/admin/issue-fix-options.tsx");
const options = functionBody(optionsSrc, "export function FixFileOptions(");

test("structural: one Fix file button — Refetch, Replace and Replace file are gone from the row", () => {
  assert.ok(src.includes("function FixFileDialog("));
  const row = stripComments(functionBody(src, "export function IssueActions("));
  assert.match(row, /setPanel\("fix"\)/);
  assert.match(row, /t\("adminQueue\.issueActions\.fixFile"\)/);
  assert.doesNotMatch(row, /refetch: true/, "the row no longer searches on its own");
  assert.doesNotMatch(row, /\/releases|\/files/, "the row reads nothing from Radarr/Sonarr");
  for (const code of [src, optionsSrc]) {
    assert.doesNotMatch(code, /issueActions\.(refetch|replace|replaceFile|replaceEpisode|searchTriggered)"/);
  }
});

test("structural: the window reads the files once per instance, ADMIN only, and searches indexers only when the list is opened", () => {
  assert.match(options, /useEffect\(\(\) => \{\s*if \(isAdmin\) void load\(instance\);\s*\}, \[isAdmin, load, instance\]\);/);
  const open = functionBody(dialog, "function openReleases(");
  assert.match(open, /if \(releases === null && !releasesLoading\) void loadReleases\(instance\);/, "once per instance");
  // loadReleases is called only from opening the list, an instance switch while
  // it is open, and Search again — never on mount.
  const calls = dialog.match(/loadReleases\(/g) ?? [];
  assert.equal(calls.length, 4, "definition + open + instance switch + Search again (one handler for both of its buttons)");
  assert.doesNotMatch(optionsSrc, /loadReleases|runReleaseSearchJob|\/releases/, "the options view never searches indexers");
});

test("structural: the choices lead with the fix that fits what is on disk", () => {
  assert.match(options, /advice === "broken" \? \["delete", "pick", "search"\]/);
  assert.match(options, /: advice === "upgrade" \? \["search", "delete", "pick"\]/);
  assert.match(options, /: \["search", "pick", "delete"\];/);
  assert.match(options, /const canDelete = isAdmin && files\.length > 0;/, "delete needs listed files, ADMIN only");
});

test("structural: the block box picks the delete's follow-up — blocklist the release, or search", () => {
  assert.match(dialogBody, /const \[blockRelease, setBlockRelease\] = useState\(true\);/, "on by default");
  assert.match(options, /void replace\(blockRelease \? "markFailed" : "search"\)/);
});

test("structural: the search reports its own failures before claiming success", () => {
  const search = functionBody(options, "async function searchNow(");
  assert.match(search, /init: jsonInit\("PATCH", \{ refetch: true, instance \}\)/, "the window's instance");
  const okCheck = search.indexOf("if (!res.ok");
  const arrCheck = search.indexOf("if (data.arrError)");
  const sent = search.indexOf("setSearched(true)");
  assert.ok(okCheck > 0 && okCheck < arrCheck && arrCheck < sent, "res.ok, then arrError, then sent");
  // A refusal shows the route's own reason (the integration switched off, an
  // instance that isn't a configured one), never a bare "failed".
  assert.match(search, /res\.kind === "http"\s*\? apiErrorText\(res\.body, t\("adminQueue\.issueActions\.searchFailed", \{ status: res\.status \}\)\)/);
  // The request is bounded and dropped with the window.
  assert.match(search, /signal,\s*timeoutMs: SEARCH_TIMEOUT_MS,/);
});

// ── structural: what belongs to one instance never reaches another ───────────
//
// An instance switch used to reset a dozen setters by hand, so a new piece of
// per-instance state that was missed in that list carried one server's files,
// result or release list onto another. Now the options view is remounted per
// instance and the release search is read and written by instance.

test("structural: the options view is remounted per instance and stays mounted behind the release list", () => {
  const code = stripComments(dialogBody);
  const at = code.indexOf("<FixFileOptions");
  assert.ok(at > 0, "the window renders the options view");
  const tag = code.slice(at, code.indexOf("/>", at));
  assert.match(tag, /\bkey=\{instance\}/, "a switch remounts it: every piece of its state starts over");
  assert.match(tag, /\binstance=\{instance\}/);
  assert.match(tag, /\bshown=\{view === "options"\}/, "hidden, not unmounted, while the release list shows");
  assert.doesNotMatch(code.slice(Math.max(0, at - 40), at), /&&\s*\(?\s*$|\?\s*\(?\s*$/, "never mounted conditionally: Back must find the files as they were");

  // Hidden means rendering nothing AFTER every hook, so its state survives.
  const body = stripComments(options);
  const hidden = body.indexOf("if (!shown) return null;");
  assert.ok(hidden > 0, "renders nothing while hidden");
  const hooks = [...body.matchAll(/\buse[A-Z]\w*\(/g)].map((m) => m.index);
  assert.ok(hooks.length > 0 && hooks.every((i) => i < hidden), "every hook runs before the early return");
});

test("structural: an instance switch resets nothing by hand", () => {
  const pick = stripComments(functionBody(dialog, "function pickInstance("));
  assert.deepEqual(pick.match(/\bset[A-Z]\w*\([^)]*\)/g), ["setSearch(null)"], "the release search is dropped whole, nothing else is reset");
  assert.match(pick, /stopReleaseSearch\(\);/);
  assert.match(pick, /onInstanceChange\(next\);/);
  // The window keeps no per-instance state of the options view.
  for (const name of ["setListing", "setListLoading", "setListError", "setSelected", "setConfirming", "setResult", "setSearched", "setActionError", "reqRef"]) {
    assert.ok(!new RegExp(`\\b${name}\\b`).test(dialogBody), `${name} is the options view's, not the window's`);
    assert.ok(new RegExp(`\\b${name}\\b`).test(options), `${name} lives in the options view`);
  }
});

test("structural: the release search is read and written only by the instance it ran on", () => {
  const code = stripComments(dialogBody);
  assert.match(code, /const current = releaseSearchOn\(search, instance\);/);
  assert.doesNotMatch(code, /\bsearch(\?)?\.(releases|loading|error|grabOk)\b/, "nothing reads the search but through releaseSearchOn");
  // Each write names its instance: the new search is tagged, every later one patches by tag.
  const load = stripComments(functionBody(dialog, "async function loadReleases("));
  assert.match(load, /setSearch\(\{ instance: targetInstance, releases: null, loading: true, error: null, grabOk: false \}\);/);
  assert.equal(load.match(/setSearch\(/g)?.length, 1, "the rest of the search writes through patchSearch");
  assert.equal(load.match(/patchSearch\(targetInstance, /g)?.length, 4, "list, error, network error, spinner");
  const grab = stripComments(functionBody(dialog, "async function grabRelease("));
  assert.doesNotMatch(grab, /setSearch\(/);
  assert.match(grab, /patchSearch\(instance, \{ grabOk: true \}\);/);
});

// The two helpers, cut from the source (types stripped) and run.
type Search = { instance: string; releases: unknown[] | null; loading: boolean; error: string | null; grabOk: boolean };
function cut<T>(name: string): T {
  const anchor = `function ${name}(`;
  const at = src.indexOf(anchor);
  assert.ok(at >= 0, `${name} is in issue-actions.tsx`);
  const [, end] = functionBodyRange(src, anchor);
  return new Function(`${stripTypeScriptTypes(src.slice(at, end + 1))}\nreturn ${name};`)() as T;
}
const releaseSearchOn = cut<(s: Search | null, instance: string) => Search | null>("releaseSearchOn");
const patchReleaseSearch = cut<(instance: string, patch: Partial<Search>) => (s: Search | null) => Search | null>("patchReleaseSearch");

test("releaseSearchOn: another instance's search reads as not searched", () => {
  const onFourK: Search = { instance: "4k", releases: [{ guid: "a" }], loading: false, error: null, grabOk: false };
  assert.equal(releaseSearchOn(onFourK, "4k"), onFourK);
  assert.equal(releaseSearchOn(onFourK, ""), null, "the default instance never sees the 4K list");
  assert.equal(releaseSearchOn(null, ""), null);
});

test("patchReleaseSearch: a write lands only on its own instance's search", () => {
  const onDefault: Search = { instance: "", releases: null, loading: true, error: null, grabOk: false };
  assert.equal(patchReleaseSearch("4k", { releases: [{ guid: "x" }], loading: false })(onDefault), onDefault, "a late 4K answer leaves the default's search alone");
  assert.deepEqual(patchReleaseSearch("", { loading: false, error: "boom" })(onDefault), { ...onDefault, loading: false, error: "boom" });
  assert.equal(patchReleaseSearch("", { grabOk: true })(null), null, "a dropped search stays dropped");
  assert.equal(onDefault.loading, true, "never mutated in place");
});
