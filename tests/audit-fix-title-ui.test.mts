// The admin title manager's UI (src/components/admin/arr-title/): the v0.34.0+
// audit's fixes, pinned. The rules live in the pure src/lib/arr-title-ui.ts;
// the wiring the pure rules can't see is pinned structurally (node:test has no
// client render harness).
//
// What is pinned:
//   C052  Closing during a Settings save WAITS: its PATCH is already sent, so
//         "discard your changes" would describe the opposite of what happens.
//         SettingsTab reports the save; the banner's Discard is off meanwhile.
//   C050  The History tab's Download Queue link goes through the same close
//         rules: unsaved Settings edits ask first and the navigation is
//         cancelled; a save in flight cancels it too.
//   C058  Following that link closes the manager itself — on the Download
//         Queue a link to the URL already open re-renders nothing that would.
//         A new-tab click leaves the page and the manager alone.
//   C051  Seasons tab: a flip whose re-read failed (`title: null`) has the
//         manager read the title again; a season flip holds the switches until
//         its list re-read answered; an episode flip re-reads a list whose
//         older read is still in flight; every expand re-reads; and a title
//         re-read with a season's header changed re-reads that open list.
//   C049  Files tab: the delete confirm (an alertdialog) takes focus on open,
//         and gives it back to Delete (n) when it closes unconfirmed.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { closeVerdict, opensElsewhere, seasonSignature, staleSeasons } from "../src/lib/arr-title-ui.ts";
import type { TitleSeason } from "../src/lib/arr-title.ts";

const src = (name: string) => readFileSync(new URL(`../src/components/admin/arr-title/${name}`, import.meta.url), "utf8");

/** The body of `function <name>` / `const <name> = …` up to the next top-level-ish declaration. */
function body(text: string, start: string): string {
  const i = text.indexOf(start);
  assert.ok(i >= 0, `missing: ${start}`);
  const rest = text.slice(i + start.length);
  const end = rest.search(/\n {2}(?:async function |function |const [A-Za-z]+ = |useEffect\(|if \()/);
  return end < 0 ? rest : rest.slice(0, end);
}

// ── C052 / C050: the close rules ───────────────────────────────────────────

test("C052: a close during a Settings save waits — whatever else is true", () => {
  for (const dirty of [true, false]) {
    for (const confirming of [true, false]) {
      assert.equal(closeVerdict({ removed: false, saving: true, dirty, confirming }), "wait", `dirty=${dirty} confirming=${confirming}`);
    }
  }
});

test("C050: unsaved edits ask first; the second ask (banner showing) closes; nothing to lose closes", () => {
  assert.equal(closeVerdict({ removed: false, saving: false, dirty: true, confirming: false }), "confirm");
  assert.equal(closeVerdict({ removed: false, saving: false, dirty: true, confirming: true }), "close");
  assert.equal(closeVerdict({ removed: false, saving: false, dirty: false, confirming: false }), "close");
  assert.equal(closeVerdict({ removed: false, saving: false, dirty: false, confirming: true }), "close");
});

test("a removed title closes — its form is gone with it", () => {
  assert.equal(closeVerdict({ removed: true, saving: false, dirty: true, confirming: false }), "close");
  assert.equal(closeVerdict({ removed: true, saving: true, dirty: true, confirming: false }), "close");
});

test("C052: SettingsTab reports a save in flight, and stops on its answer or its unmount", () => {
  const tab = src("settings-tab.tsx");
  assert.match(tab, /onSavingChange\?: \(saving: boolean\) => void;/);
  assert.match(
    tab,
    /useEffect\(\(\) => \{\s*if \(!saving\) return;\s*onSavingChange\?\.\(true\);[\s\S]*?return \(\) => onSavingChange\?\.\(false\);\s*\}, \[saving, onSavingChange\]\);/,
    "true when the save starts; the cleanup (answer OR unmount) reports false — never a stuck 'saving' that blocks closing",
  );
});

test("C052/C050: the manager closes only through closeVerdict, fed the in-flight save", () => {
  const mgr = src("title-manager.tsx");
  const leave = body(mgr, "function leave(): boolean {");
  assert.match(leave, /closeVerdict\(\{ removed, saving: settingsSaving, dirty: settingsDirty, confirming: confirmDiscard \}\)/);
  assert.match(leave, /if \(verdict === "close"\) \{\s*onOpenChange\(false\);\s*return true;\s*\}/);
  assert.match(leave, /if \(verdict === "confirm"\) setConfirmDiscard\(true\);/);
  assert.match(leave, /return false;/);
  const close = body(mgr, "function requestClose(nextOpen: boolean) {");
  assert.match(close, /if \(nextOpen\) return onOpenChange\(true\);\s*leave\(\);/, "Escape / X / backdrop go through leave()");
  assert.doesNotMatch(close, /settingsDirty/, "no second copy of the rule");
  assert.match(mgr, /onSavingChange=\{setSettingsSaving\}/, "SettingsTab is told where to report its save");
  assert.match(mgr, /<Button size="sm" disabled=\{settingsSaving\}[^>]*onClick=\{\(\) => onOpenChange\(false\)\}>\s*\{t\("adminArr\.settings\.discard"\)\}/, "Discard is off while the save is in flight");
  assert.match(mgr, /setSettingsDirty\(false\);\s*setSettingsSaving\(false\);/, "the open-time reset clears it");
});

// ── C058 / C050: the History tab's queue link ──────────────────────────────

test("C058/C050: the queue link asks the manager to leave, and cancels the navigation when it won't", () => {
  const tab = src("history-tab.tsx");
  assert.match(tab, /onLeave\?: \(\) => boolean;/);
  const link = tab.slice(tab.indexOf("<Link"), tab.indexOf("</Link>"));
  assert.match(link, /href=\{queueTitleHref\(titleRef\)\}/);
  assert.match(link, /onClick=\{\(e\) => \{[\s\S]*?if \(!onLeave \|\| opensElsewhere\(e\)\) return;\s*if \(!onLeave\(\)\) e\.preventDefault\(\);/);
  assert.match(src("title-manager.tsx"), /<HistoryTab titleRef=\{ref\} onLeave=\{leave\} \/>/, "the manager hands it its own close");
});

test("C058: a new-tab click is left to the browser; a plain click is the manager's", () => {
  const plain = { button: 0, metaKey: false, ctrlKey: false, shiftKey: false, altKey: false };
  assert.equal(opensElsewhere(plain), false);
  for (const k of ["metaKey", "ctrlKey", "shiftKey", "altKey"] as const) assert.equal(opensElsewhere({ ...plain, [k]: true }), true, k);
  assert.equal(opensElsewhere({ ...plain, button: 1 }), true, "middle click");
});

// ── C051: the Seasons tab ──────────────────────────────────────────────────

const season = (over: Partial<TitleSeason> = {}): TitleSeason => ({
  seasonNumber: 1,
  monitored: true,
  episodeCount: 10,
  episodeFileCount: 10,
  totalEpisodeCount: 10,
  sizeOnDisk: 1000,
  nextAiring: null,
  previousAiring: null,
  ...over,
});

test("C051: a season seen for the first time is recorded, never reported", () => {
  const seen = new Map<number, string>();
  assert.deepEqual(staleSeasons(seen, [season(), season({ seasonNumber: 2 })]), []);
  assert.equal(seen.get(1), seasonSignature(season()));
  assert.deepEqual(staleSeasons(seen, [season(), season({ seasonNumber: 2 })]), [], "unchanged is not stale");
});

test("C051: every header field an episode row can disagree with makes the season stale", () => {
  const changes: Array<Partial<TitleSeason>> = [
    { monitored: false },
    { episodeCount: 9 },
    { episodeFileCount: 9 },
    { totalEpisodeCount: 11 },
    { sizeOnDisk: 900 },
  ];
  for (const c of changes) {
    const seen = new Map<number, string>();
    staleSeasons(seen, [season(), season({ seasonNumber: 2 })]);
    assert.deepEqual(staleSeasons(seen, [season(c), season({ seasonNumber: 2 })]), [1], JSON.stringify(c));
    assert.deepEqual(staleSeasons(seen, [season(c), season({ seasonNumber: 2 })]), [], "reported once, then seen");
  }
});

test("C051: a flip whose re-read failed is handed to the manager, which reads the title again", () => {
  const tab = src("seasons-tab.tsx");
  assert.match(tab, /onTitle: \(title: ArrTitle \| null\) => void;/);
  assert.doesNotMatch(tab, /if \(res\.data\.title\) onTitle/, "a null re-read is not swallowed");
  assert.equal(tab.match(/onTitle\(res\.data\.title\);/g)?.length, 2, "both flips hand the answer over");
  const mgr = src("title-manager.tsx");
  const handler = mgr.slice(mgr.indexOf("onTitle={(next) => {"), mgr.indexOf("runCommand={runCommand}"));
  assert.match(handler, /if \(!next\) return reload\(\);/);
  assert.match(handler, /mergeTitle\(s\.title, next\)/);
});

test("C051 (F073): a season flip holds the switches until its list re-read answered", () => {
  const fn = src("seasons-tab.tsx").split("async function setSeasonMonitored")[1].split("async function setEpisodeMonitored")[0];
  const reread = fn.indexOf("await loadEpisodes(n)");
  assert.ok(reread > 0, "the re-read is awaited");
  assert.ok(fn.lastIndexOf("setBusy(null)") > reread, "busy clears after it");
  assert.equal(fn.match(/setBusy\(null\)/g)?.length, 2, "once on a failed PATCH, once after the re-read — never before it");
  assert.ok(fn.indexOf("markSeen(res.data.title, n)") < fn.indexOf("onTitle(res.data.title)"), "its own season is marked seen first — no second re-read from the effect");
});

test("C051 (F073): an episode flip re-reads a season whose older read is still in flight", () => {
  const tab = src("seasons-tab.tsx");
  const fn = tab.split("async function setEpisodeMonitored")[1].split("async function command")[0];
  assert.match(fn, /if \(\(listSeq\.current\[season\] \?\? 0\) !== \(doneSeq\.current\[season\] \?\? 0\)\) void loadEpisodes\(season\);/);
  assert.match(tab, /if \(listSeq\.current\[n\] !== seq\) return;\s*doneSeq\.current\[n\] = seq;/, "a read is done only once it answered as the newest");
});

test("C051 (F071): every expand re-reads, and a changed header re-reads an open list", () => {
  const tab = src("seasons-tab.tsx");
  const toggle = tab.split("function toggle(n: number) {")[1].split("async function setSeasonMonitored")[0];
  assert.match(toggle, /if \(opening\) void loadEpisodes\(n\);/);
  assert.doesNotMatch(toggle, /lists\[n\]\.error/, "no longer only a failed list");
  assert.match(
    tab,
    /useEffect\(\(\) => \{\s*for \(const n of staleSeasons\(seenSig\.current, title\.seasons\)\) \{\s*if \(expanded\.has\(n\) && lists\[n\]\) void loadEpisodes\(n\);\s*\}\s*\}, \[title\.seasons, expanded, lists, loadEpisodes\]\);/,
  );
});

// ── C049: the Files tab's delete confirm ───────────────────────────────────

test("C049: the delete confirm takes focus, and gives it back to Delete (n) when it closes unconfirmed", () => {
  const tab = src("files-tab.tsx");
  assert.match(
    tab,
    /useEffect\(\(\) => \{\s*if \(confirmDelete\) cancelDeleteRef\.current\?\.focus\(\);\s*else if \(refocusDelete\.current\) \{\s*refocusDelete\.current = false;\s*deleteRef\.current\?\.focus\(\);\s*\}\s*\}, \[confirmDelete\]\);/,
  );
  assert.match(tab, /<Button ref=\{deleteRef\}[^>]*onClick=\{\(\) => setConfirmDelete\(true\)\}>/);
  const confirm = tab.slice(tab.indexOf('role="alertdialog"'), tab.indexOf('t("adminArr.files.confirmDelete")'));
  assert.match(confirm, /ref=\{cancelDeleteRef\}[\s\S]*?onClick=\{\(\) => \{\s*refocusDelete\.current = true;\s*setConfirmDelete\(false\);/, "Cancel gives focus back");
  const remove = tab.split("async function remove()")[1].split("async function preview()")[0];
  assert.ok(remove.indexOf("refocusDelete.current = !res.ok;") >= 0 && remove.indexOf("refocusDelete.current = !res.ok;") < remove.indexOf("setConfirmDelete(false)"), "a failed delete gives it back too — set before the close renders");
  // A change of selection closes the confirm WITHOUT moving focus off the checkbox.
  for (const fn of ["function toggle(id: number) {", "function selectAll(on: boolean) {"]) {
    assert.doesNotMatch(tab.split(fn)[1].split("\n  }\n")[0], /refocusDelete/, fn);
  }
});
