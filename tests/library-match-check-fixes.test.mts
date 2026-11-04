// The library match check's "fixed on this page" bookkeeping
// (src/lib/client/match-check-fixes.ts, used by library-match-check.tsx).
//
// Why: an item-mode fix drops its flag from the stored report and lowers
// counts.flagged in the same transaction (dropMatchFlagInTx), and Fix all ends
// with router.refresh(), which brings that report while the component keeps its
// state. The summary subtracted every fix AGAIN ("0 flagged" over 10 listed
// rows), and the rows kept on screen for a partial-fix warning (plexConflated)
// vanished as soon as their flag left the report.
//
// Pinned: a fix counts against the report only while the report still lists
// it; a fix with a warning keeps its row after the report dropped it; a report
// from a new check voids the old fixes; and structurally the component renders
// through matchCheckView, never `counts.flagged - fixed.size`.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const { matchCheckView, matchFlagKey, noMatchFixes, recordMatchFix } = await import("../src/lib/client/match-check-fixes.ts");

type Flag = { server: string; serverInstance: string; itemKey: string; kind: string };
const flag = (i: number, kind = "wrongMatch"): Flag => ({ server: i % 2 ? "plex" : "jellyfin", serverInstance: "", itemKey: `item-${i}`, kind });
const CHECKED = "2026-11-01T10:00:00.000Z";

// 30 flags: 20 fixable wrong matches, 10 the admin can't fix from here.
const all = [...Array.from({ length: 20 }, (_, i) => flag(i)), ...Array.from({ length: 10 }, (_, i) => flag(100 + i, "yearMismatch"))];
const before = { checkedAt: CHECKED, counts: { flagged: 30 }, flags: all };
const WARNED = all[3];
const WARNING = "Plex merged this item's metadata; the remap is partial.";

function fixAllTwenty() {
  let fixes = noMatchFixes<Flag>();
  for (const f of all.slice(0, 20)) fixes = recordMatchFix(fixes, CHECKED, f, f === WARNED ? WARNING : "");
  return fixes;
}

test("before the refresh: fixes come off the stored count, rows without a warning are hidden, the warned row stays in place", () => {
  const view = matchCheckView(before, fixAllTwenty());
  assert.equal(view.flagged, 10);
  assert.deepEqual(view.flags.map(matchFlagKey), [matchFlagKey(WARNED), ...all.slice(20).map(matchFlagKey)]);
  assert.equal(view.fixed.get(matchFlagKey(WARNED)), WARNING);
  assert.equal(view.fixed.get(matchFlagKey(all[0])), "");
  assert.equal(view.fixed.size, 20);
});

test("after router.refresh brings the report that dropped them: no second subtraction, and the warned row is still listed", () => {
  // dropMatchFlagInTx: the 20 flags are gone and counts.flagged went 30 → 10; checkedAt is unchanged.
  const after = { checkedAt: CHECKED, counts: { flagged: 10 }, flags: all.slice(20) };
  const view = matchCheckView(after, fixAllTwenty());
  assert.equal(view.flagged, 10, "was 0: counts.flagged (10) - fixed.size (20), clamped");
  assert.deepEqual(view.flags.map(matchFlagKey), [matchFlagKey(WARNED), ...all.slice(20).map(matchFlagKey)]);
  assert.equal(view.fixed.get(matchFlagKey(WARNED)), WARNING, "the row still shows its warning (and stays out of Fix all)");
});

test("a fix the report reflects only in part (some refreshed, some not) is counted exactly once each", () => {
  let fixes = noMatchFixes<Flag>();
  fixes = recordMatchFix(fixes, CHECKED, all[0]);
  fixes = recordMatchFix(fixes, CHECKED, all[1]);
  // The stored report already dropped all[0] (counts 29) but still lists all[1].
  const mid = { checkedAt: CHECKED, counts: { flagged: 29 }, flags: all.filter((f) => f !== all[0]) };
  const view = matchCheckView(mid, fixes);
  assert.equal(view.flagged, 28);
  assert.equal(view.flags.length, 28);
  assert.ok(!view.flags.includes(all[1]));
});

test("a report from a NEW check voids the old fixes: a re-flagged item is listed and counted again", () => {
  const fresh = { checkedAt: "2026-11-02T10:00:00.000Z", counts: { flagged: 2 }, flags: [all[0], WARNED] };
  const view = matchCheckView(fresh, fixAllTwenty());
  assert.equal(view.flagged, 2);
  assert.deepEqual(view.flags, [all[0], WARNED]);
  assert.equal(view.fixed.size, 0);
  // And a fix recorded against the new report starts a new set.
  const next = recordMatchFix(fixAllTwenty(), fresh.checkedAt, all[0]);
  assert.equal(next.checkedAt, fresh.checkedAt);
  assert.deepEqual([...next.entries.keys()], [matchFlagKey(all[0])]);
});

test("no report: nothing to list", () => {
  assert.deepEqual(matchCheckView(null, fixAllTwenty()), { flags: [], flagged: 0, fixed: new Map() });
});

test("structural: the component lists, counts and records fixes through match-check-fixes", () => {
  const here = dirname(fileURLToPath(import.meta.url));
  const src = readFileSync(join(here, "../src/components/admin/library-match-check.tsx"), "utf8");
  assert.doesNotMatch(src, /counts\.flagged\s*-\s*fixed/, "no subtraction of every fix from the stored count");
  assert.match(src, /flagged: view\.flagged\.toLocaleString\(locale\)/);
  assert.match(src, /const view = useMemo\(\(\) => matchCheckView\(report, fixes\), \[report, fixes\]\);/);
  assert.match(src, /\(\) => view\.flags\.filter\(\(f\) => !mediaType \|\| f\.mediaType === mediaType\)/, "rows come from the view, kept warning rows included");
  assert.match(src, /setFixes\(\(prev\) => recordMatchFix\(prev, checkedAt, flag, warning\)\)/);
  assert.match(src, /onFixed\(flag, warning \?\? undefined\);/, "Fix one passes the flag itself");
  assert.match(src, /onFixed\(flag, fixMatchWarningMessage\(outcome, t\) \?\? undefined\);/, "so does Fix all");
  assert.match(src, /setFixes\(noMatchFixes\(\)\);\s*router\.refresh\(\);/, "Check now starts clean");
});
