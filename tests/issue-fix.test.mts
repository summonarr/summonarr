// The issue "Fix file" window (src/lib/issue-fix.ts + issue-actions.tsx).
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

const { fixAdvice, defaultFileSelection, rejectedOnlyForFileOnDisk, defaultRelease } = await import("../src/lib/issue-fix.ts");
const { functionBody, stripComments } = await import("./audit-fix2-R8b-tests-vacuous-source.mts");

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

test("structural: one Fix file button — Refetch, Replace and Replace file are gone from the row", () => {
  assert.ok(src.includes("function FixFileDialog("));
  const row = stripComments(functionBody(src, "export function IssueActions("));
  assert.match(row, /setPanel\("fix"\)/);
  assert.match(row, /t\("adminQueue\.issueActions\.fixFile"\)/);
  assert.doesNotMatch(row, /refetch: true/, "the row no longer searches on its own");
  assert.doesNotMatch(row, /\/releases|\/files/, "the row reads nothing from Radarr/Sonarr");
  assert.doesNotMatch(src, /issueActions\.(refetch|replace|replaceFile|replaceEpisode|searchTriggered)"/);
});

test("structural: the window reads the files once per instance, ADMIN only, and searches indexers only when the list is opened", () => {
  assert.match(dialog, /useEffect\(\(\) => \{\s*if \(isAdmin\) void load\(instance\);\s*\}, \[isAdmin, load, instance\]\);/);
  const open = functionBody(dialog, "function openReleases(");
  assert.match(open, /if \(releases === null && !releasesLoading\) void loadReleases\(instance\);/, "once per instance");
  // loadReleases is called only from opening the list, an instance switch while
  // it is open, and Search again — never on mount.
  const calls = dialog.match(/loadReleases\(/g) ?? [];
  assert.equal(calls.length, 5, "definition + open + instance switch + two Search again");
});

test("structural: the choices lead with the fix that fits what is on disk", () => {
  assert.match(dialog, /advice === "broken" \? \["delete", "pick", "search"\]/);
  assert.match(dialog, /: advice === "upgrade" \? \["search", "delete", "pick"\]/);
  assert.match(dialog, /: \["search", "pick", "delete"\];/);
  assert.match(dialog, /const canDelete = isAdmin && files\.length > 0;/, "delete needs listed files, ADMIN only");
});

test("structural: the block box picks the delete's follow-up — blocklist the release, or search", () => {
  assert.match(dialog, /const \[blockRelease, setBlockRelease\] = useState\(true\);/, "on by default");
  assert.match(dialog, /void replace\(blockRelease \? "markFailed" : "search"\)/);
});

test("structural: the search reports its own failures before claiming success", () => {
  const search = functionBody(dialog, "async function searchNow(");
  assert.match(search, /body: JSON\.stringify\(\{ refetch: true, instance \}\)/, "the window's instance");
  const okCheck = search.indexOf("if (!res.ok)");
  const arrCheck = search.indexOf("if (data.arrError)");
  const sent = search.indexOf("setSearched(true)");
  assert.ok(okCheck > 0 && okCheck < arrCheck && arrCheck < sent, "res.ok, then arrError, then sent");
});
