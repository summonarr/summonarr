// The admin title manager's UI (src/components/admin/arr-title/): the v0.34.0+
// audit's fixes, pinned. The rules live in the pure src/lib/arr-title-ui.ts;
// the wiring the pure rules can't see is pinned structurally (node:test has no
// client render harness).
//
// What is pinned:
// Closing during a Settings save WAITS: its PATCH is already sent, so
//         "discard your changes" would describe the opposite of what happens.
//         SettingsTab reports the save; the banner's Discard is off meanwhile.
// The History tab's Download Queue link goes through the same close
//         rules: unsaved Settings edits ask first and the navigation is
//         cancelled; a save in flight cancels it too.
// Following that link closes the manager itself — on the Download
//         Queue a link to the URL already open re-renders nothing that would.
//         A new-tab click leaves the page and the manager alone.
// Seasons tab: a flip whose re-read failed (`title: null`) has the
//         manager read the title again; a season flip holds the switches until
//         its list re-read answered; an episode flip re-reads a list whose
//         older read is still in flight; every expand re-reads; and a title
//         re-read with a season's header changed re-reads that open list.
// Files tab: the delete confirm (an alertdialog) takes focus on open,
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

// ── the close rules ───────────────────────────────────────────

test("a close during a Settings save waits — whatever else is true", () => {
  for (const dirty of [true, false]) {
    for (const confirming of [true, false]) {
      assert.equal(closeVerdict({ removed: false, saving: true, dirty, confirming }), "wait", `dirty=${dirty} confirming=${confirming}`);
    }
  }
});

test("unsaved edits ask first; the second ask (banner showing) closes; nothing to lose closes", () => {
  assert.equal(closeVerdict({ removed: false, saving: false, dirty: true, confirming: false }), "confirm");
  assert.equal(closeVerdict({ removed: false, saving: false, dirty: true, confirming: true }), "close");
  assert.equal(closeVerdict({ removed: false, saving: false, dirty: false, confirming: false }), "close");
  assert.equal(closeVerdict({ removed: false, saving: false, dirty: false, confirming: true }), "close");
});

test("a removed title closes — its form is gone with it", () => {
  assert.equal(closeVerdict({ removed: true, saving: false, dirty: true, confirming: false }), "close");
  assert.equal(closeVerdict({ removed: true, saving: true, dirty: true, confirming: false }), "close");
});

test("SettingsTab reports a save in flight, and stops on its answer or its unmount", () => {
  const tab = src("settings-tab.tsx");
  assert.match(tab, /onSavingChange\?: \(saving: boolean\) => void;/);
  assert.match(
    tab,
    /useEffect\(\(\) => \{\s*if \(!saving\) return;\s*onSavingChange\?\.\(true\);[\s\S]*?return \(\) => onSavingChange\?\.\(false\);\s*\}, \[saving, onSavingChange\]\);/,
    "true when the save starts; the cleanup (answer OR unmount) reports false — never a stuck 'saving' that blocks closing",
  );
});

test("the manager closes only through closeVerdict, fed the in-flight save", () => {
  const mgr = src("title-manager.tsx");
  const leave = body(mgr, "function leave(): boolean {");
  assert.match(leave, /closeVerdict\(\{ removed, saving: settingsSaving, dirty: settingsDirty, confirming: confirmDiscard \}\)/);
  assert.match(leave, /if \(verdict === "close"\) \{\s*onOpenChange\(false\);\s*return true;\s*\}/);
  assert.match(leave, /if \(verdict === "confirm"\) \{[\s\S]*?setConfirmDiscard\(true\);\s*\}/);
  assert.match(leave, /return false;/);
  const close = body(mgr, "function requestClose(nextOpen: boolean) {");
  assert.match(close, /if \(nextOpen\) return onOpenChange\(true\);\s*leave\(\);/, "Escape / X / backdrop go through leave()");
  assert.doesNotMatch(close, /settingsDirty/, "no second copy of the rule");
  assert.match(mgr, /onSavingChange=\{setSettingsSaving\}/, "SettingsTab is told where to report its save");
  assert.match(mgr, /<DiscardBanner saving=\{settingsSaving\} keepRef=\{keepEditingRef\} onKeep=\{\(\) => setConfirmDiscard\(false\)\} onDiscard=\{\(\) => onOpenChange\(false\)\} \/>/);
  assert.match(src("manager-parts.tsx"), /<Button size="sm" disabled=\{saving\}[^>]*onClick=\{onDiscard\}>\s*\{t\("adminArr\.settings\.discard"\)\}/, "Discard is off while the save is in flight");
  assert.match(mgr, /setSettingsDirty\(false\);\s*setSettingsSaving\(false\);/, "the open-time reset clears it");
});

// ── the History tab's queue link ──────────────────────────────

test("the queue link asks the manager to leave, and cancels the navigation when it won't", () => {
  const tab = src("history-tab.tsx");
  assert.match(tab, /onLeave\?: \(\) => boolean;/);
  const link = tab.slice(tab.indexOf("<Link"), tab.indexOf("</Link>"));
  assert.match(link, /href=\{queueTitleHref\(titleRef\)\}/);
  assert.match(link, /onClick=\{\(e\) => \{[\s\S]*?if \(!onLeave \|\| opensElsewhere\(e\)\) return;\s*if \(!onLeave\(\)\) e\.preventDefault\(\);/);
  assert.match(src("title-manager.tsx"), /<HistoryTab titleRef=\{ref\} onLeave=\{leave\} \/>/, "the manager hands it its own close");
});

test("a new-tab click is left to the browser; a plain click is the manager's", () => {
  const plain = { button: 0, metaKey: false, ctrlKey: false, shiftKey: false, altKey: false };
  assert.equal(opensElsewhere(plain), false);
  for (const k of ["metaKey", "ctrlKey", "shiftKey", "altKey"] as const) assert.equal(opensElsewhere({ ...plain, [k]: true }), true, k);
  assert.equal(opensElsewhere({ ...plain, button: 1 }), true, "middle click");
});

// ── the Seasons tab ──────────────────────────────────────────────────

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

test("a season seen for the first time is recorded, never reported", () => {
  const seen = new Map<number, string>();
  assert.deepEqual(staleSeasons(seen, [season(), season({ seasonNumber: 2 })]), []);
  assert.equal(seen.get(1), seasonSignature(season()));
  assert.deepEqual(staleSeasons(seen, [season(), season({ seasonNumber: 2 })]), [], "unchanged is not stale");
});

test("every header field an episode row can disagree with makes the season stale", () => {
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

test("a flip whose re-read failed is handed to the manager, which reads the title again", () => {
  const tab = src("seasons-tab.tsx");
  assert.match(tab, /onTitle: \(title: ArrTitle \| null\) => void;/);
  assert.doesNotMatch(tab, /if \(res\.data\.title\) onTitle/, "a null re-read is not swallowed");
  assert.equal(tab.match(/onTitle\(res\.data\.title\);/g)?.length, 2, "both flips hand the answer over");
  assert.match(src("title-manager.tsx"), /onTitle=\{applyWrite\}/);
  const load = src("use-title-load.ts");
  const handler = load.slice(load.indexOf("const applyWrite = useCallback("), load.indexOf("}, [reload, supersedeReads]);"));
  assert.match(handler, /if \(!next\) return reload\(\);/);
  assert.match(handler, /mergeTitle\(s\.title, next\)/);
});

test(": a season flip holds the switches until its list re-read answered", () => {
  const fn = src("seasons-tab.tsx").split("async function setSeasonMonitored")[1].split("async function setEpisodeMonitored")[0];
  // Every switch waits while any of the tab's actions is out; the re-read runs under the flip's own key.
  assert.match(fn, /const key = `season:\$\{n\}`;/);
  const reread = fn.indexOf("if (expanded.has(n) && lists[n]) await action.run(key, () => loadEpisodes(n));");
  assert.ok(reread > 0, "the re-read is awaited under the flip's key");
  assert.ok(fn.indexOf("markSeen(res.data.title, n)") < fn.indexOf("onTitle(res.data.title)"), "its own season is marked seen first — no second re-read from the effect");
  assert.ok(fn.indexOf("onTitle(res.data.title)") < reread, "the manager has the title before the re-read");
  assert.match(src("seasons-tab.tsx"), /busy=\{action\.anyBusy\}/);
});

test(": an episode flip re-reads a season whose older read is still in flight", () => {
  const tab = src("seasons-tab.tsx");
  const fn = tab.split("async function setEpisodeMonitored")[1].split("function command")[0];
  assert.match(fn, /if \(readInFlight\(season\)\) void loadEpisodes\(season\);/);
  const lists = src("use-episode-lists.ts");
  assert.match(lists, /readInFlight: \(n: number\) => \(listSeq\.current\[n\] \?\? 0\) !== \(doneSeq\.current\[n\] \?\? 0\),/);
  assert.match(lists, /if \(listSeq\.current\[n\] !== seq\) return;\s*doneSeq\.current\[n\] = seq;/, "a read is done only once it answered as the newest");
});

test("every expand re-reads, and a changed header re-reads an open list — once per re-read title", () => {
  const tab = src("seasons-tab.tsx");
  const toggle = tab.split("function toggle(n: number) {")[1].split("async function setSeasonMonitored")[0];
  assert.match(toggle, /if \(opening\) void loadEpisodes\(n\);/);
  assert.doesNotMatch(toggle, /lists\[n\]\.error/, "no longer only a failed list");
  assert.match(
    src("use-episode-lists.ts"),
    /useEffect\(\(\) => \{\s*if \(checkedSeasons\.current === seasons\) return;\s*checkedSeasons\.current = seasons;\s*for \(const n of staleSeasons\(seenSig\.current, seasons\)\) \{\s*if \(expanded\.has\(n\) && lists\[n\]\) void loadEpisodes\(n\);\s*\}\s*\}, \[seasons, expanded, lists, loadEpisodes\]\);/,
    "not again on every list or expand change",
  );
});

// ── the Files tab's delete confirm ───────────────────────────────────

test("the delete confirm takes focus, and gives it back to Delete (n) when it closes unconfirmed", () => {
  const tab = src("files-tab.tsx");
  assert.match(
    tab,
    /useEffect\(\(\) => \{\s*if \(confirmDelete\) cancelDeleteRef\.current\?\.focus\(\);\s*else if \(refocusDelete\.current\) \{\s*refocusDelete\.current = false;\s*deleteRef\.current\?\.focus\(\);\s*\}\s*\}, \[confirmDelete\]\);/,
  );
  assert.match(tab, /<Button ref=\{deleteRef\}[^>]*onClick=\{\(\) => setConfirmDelete\(true\)\}>/);
  const confirm = tab.slice(tab.indexOf("<DeleteConfirm"), tab.indexOf("/>", tab.indexOf("<DeleteConfirm")));
  assert.match(confirm, /cancelRef=\{cancelDeleteRef\}[\s\S]*?onCancel=\{\(\) => \{\s*refocusDelete\.current = true;\s*setConfirmDelete\(false\);/, "Cancel gives focus back");
  const parts = src("files-parts.tsx");
  const dialog = parts.slice(parts.indexOf('role="alertdialog"'), parts.indexOf('t("adminArr.files.confirmDelete")'));
  assert.match(dialog, /<Button ref=\{cancelRef\} variant="ghost" size="sm" onClick=\{onCancel\}/);
  const remove = tab.split("async function remove()")[1].split("async function preview()")[0];
  assert.ok(remove.indexOf('refocusDelete.current = res.kind !== "deleted";') >= 0 && remove.indexOf('refocusDelete.current = res.kind !== "deleted";') < remove.indexOf("setConfirmDelete(false)"), "a failed delete gives it back too — set before the close renders");
  // A change of selection closes the confirm WITHOUT moving focus off the checkbox.
  for (const fn of ["function toggle(id: number) {", "function selectAll(on: boolean) {"]) {
    assert.doesNotMatch(tab.split(fn)[1].split("\n  }\n")[0], /refocusDelete/, fn);
  }
});

// ── the Files tab's selection while a delete runs ───────────────────────────

test("the files' checkboxes and Select all are locked while a delete or rename runs", () => {
  const tab = src("files-tab.tsx");
  const selectAll = tab.slice(tab.indexOf("onChange={(e) => selectAll(e.target.checked)}"), tab.indexOf('t("adminArr.files.selectAll")'));
  assert.match(selectAll, /disabled=\{busy !== null\}/, "Select all");
  assert.match(tab, /onSelect=\{\(\) => toggle\(f\.id\)\}\s*busy=\{busy !== null\}/, "each file's checkbox is told");
  const parts = src("files-parts.tsx");
  const row = parts.slice(parts.indexOf("onChange={onSelect}"), parts.indexOf('aria-label={t("adminArr.files.selectAria"'));
  assert.match(row, /disabled=\{busy\}/, "each file's checkbox");
});

// ── a delete's or rename's refusal outlives the re-read that follows it ─────

test("the Files tab keeps a delete's refusal (or still running) apart from the list's read, so the re-read can't wipe it", () => {
  const tab = src("files-tab.tsx");
  const load = tab.slice(tab.indexOf("const load = useCallback("), tab.indexOf("}, [action, readPath, tRef, markLive]);"));
  assert.match(load, /setLoadError\(""\);/);
  assert.doesNotMatch(load, /setActionError/, "a successful re-read never clears the delete's line");
  const remove = tab.split("async function remove()")[1].split("async function preview()")[0];
  assert.match(remove, /setActionError\(res\.kind === "running" \? t\("adminArr\.files\.deleteStillRunning"\) : res\.error\);/);
  assert.ok(remove.indexOf("setActionError(res.kind") < remove.indexOf("await load();"));
  assert.match(tab, /const error = actionError \|\| loadError;/);
});

// ── the Remove panel ────────────────────────────────────────────────────────

test("the Remove panel takes focus on Cancel when it opens, and gives it back to Remove when Cancel closes it", () => {
  const panel = src("remove-panel.tsx");
  assert.match(
    panel,
    /useEffect\(\(\) => \{\s*if \(open\) cancelRef\.current\?\.focus\(\);\s*else if \(refocusTrigger\.current\) \{\s*refocusTrigger\.current = false;\s*triggerRef\.current\?\.focus\(\);\s*\}\s*\}, \[open\]\);/,
  );
  assert.match(panel, /<Button ref=\{triggerRef\}[^>]*onClick=\{\(\) => void loadPlan\(\)\}>/);
  assert.match(panel, /<Button ref=\{cancelRef\}[^>]*onClick=\{cancel\}/);
  assert.match(body(panel, "function cancel() {"), /^\s*refocusTrigger\.current = true;/, "set before the close renders");
});

test("the Remove panel's 'open requests' link goes through the manager's close rules, like the History tab's", () => {
  const panel = src("remove-panel.tsx");
  assert.match(panel, /onLeave\?: \(\) => boolean;/);
  const link = panel.slice(panel.indexOf("<Link"), panel.indexOf("</Link>"));
  assert.match(link, /href="\/admin"/);
  assert.match(link, /onClick=\{\(e\) => \{[\s\S]*?if \(!onLeave \|\| opensElsewhere\(e\)\) return;\s*if \(!onLeave\(\)\) e\.preventDefault\(\);/);
  assert.match(src("title-manager.tsx"), /<RemovePanel\s+titleRef=\{ref\}\s+instanceLabel=\{instanceLabel\}\s+onLeave=\{leave\}/);
});

test("the Remove panel's dry run is cancelled with the panel: a late plan never lands in a closed panel or over a newer one", () => {
  const panel = src("remove-panel.tsx");
  const plan = body(panel, "async function loadPlan() {");
  assert.match(plan, /const res = await action\.run\("plan", \(signal\) =>/);
  assert.match(plan, /if \(!res\) return;/);
  assert.ok(plan.indexOf("if (!res) return;") < plan.indexOf("setPlan(res.data)"));
  assert.match(body(panel, "function cancel() {"), /action\.abort\("plan"\);/);
  assert.match(body(panel, "async function remove() {"), /\{ ifBusy: "skip" \}/, "a second click never removes twice");
});

test("Cancel on the Remove panel clears 'delete the files' and the exclusion — nothing pre-selected next time", () => {
  const cancel = body(src("remove-panel.tsx"), "function cancel() {");
  assert.match(cancel, /setDeleteFiles\(false\);/);
  assert.match(cancel, /setExclude\(false\);/);
  assert.match(cancel, /setOpen\(false\);/);
  // Never inside loadPlan: `base` is captured at render, so the dry run would send stale flags.
  assert.doesNotMatch(body(src("remove-panel.tsx"), "async function loadPlan() {"), /setDeleteFiles|setExclude/);
});

// ── the Settings tab's selects and move confirm ─────────────────────────────

test("Settings keeps a quality profile the list lacks selectable, and a null availability shows as no choice", () => {
  const tab = src("settings-tab.tsx");
  assert.match(tab, /\{\(draft\.qualityProfileId === null \|\| !\(qualityProfiles \?\? \[\]\)\.some\(\(p\) => p\.id === draft\.qualityProfileId\)\) && \(\s*<option value=\{draft\.qualityProfileId === null \? "" : String\(draft\.qualityProfileId\)\}>/);
  // Every vocabulary select (availability, series type, monitor new seasons): no value is no choice, an unknown one stays as sent.
  const select = tab.slice(tab.indexOf("function VocabularySelect<"), tab.indexOf("function SeriesFields("));
  assert.match(select, /\{value === null && <option value="">—<\/option>\}/);
  assert.match(select, /\{value !== null && !oneOf\(choices, value\) && <option value=\{value\}>\{value\}<\/option>\}/);
  assert.match(select, /value=\{value \?\? ""\}/);
  assert.match(tab, /<VocabularySelect\s+value=\{draft\.minimumAvailability\}/);
  assert.match(tab, /<VocabularySelect\s+value=\{draft\.seriesType\}/, "a null or unknown series type no longer shows as standard");
  assert.match(tab, /<VocabularySelect\s+value=\{draft\.monitorNewItems\}/);
  assert.doesNotMatch(tab, /draft\.seriesType \?\? "standard"/);
});

test("the move-files confirm takes focus on its first choice, and Cancel gives it back to Save", () => {
  const tab = src("settings-tab.tsx");
  assert.match(
    tab,
    /useEffect\(\(\) => \{\s*if \(confirmMove\) moveChoiceRef\.current\?\.focus\(\);\s*else if \(refocusSave\.current\) \{\s*refocusSave\.current = false;\s*saveRef\.current\?\.focus\(\);\s*\}\s*\}, \[confirmMove\]\);/,
  );
  assert.match(tab, /firstChoiceRef=\{moveChoiceRef\}\s*onChoose=\{\(moveFiles\) => void save\(moveFiles\)\}/);
  assert.match(tab, /<button ref=\{firstChoiceRef\} type="button" onClick=\{\(\) => onChoose\(true\)\}/);
  const confirm = tab.slice(tab.indexOf("<MoveConfirm"), tab.indexOf("/>", tab.indexOf("<MoveConfirm")));
  assert.match(confirm, /onCancel=\{\(\) => \{\s*refocusSave\.current = true;\s*setConfirmMove\(false\);\s*\}\}/, "Cancel gives focus back");
  assert.match(tab, /<Button ref=\{saveRef\} size="sm" onClick=\{\(\) => void save\(\)\}/);
});

// ── the Add dialog ──────────────────────────────────────────────────────────

test("the Add dialog retries a failed choices read, and says why Submit is off when nothing can be picked", () => {
  const dialog = src("add-dialog.tsx");
  const failed = dialog.slice(dialog.indexOf("if (loadError) {"), dialog.indexOf("if (!choices) {"));
  assert.match(failed, /<Button variant="ghost" size="sm" onClick=\{\(\) => void loadChoices\(\)\}><RefreshCw \/> \{t\("adminArr\.common\.retry"\)\}<\/Button>/);
  assert.match(dialog, /const loadChoices = useCallback\(async \(\) => \{\s*setLoadError\(""\);[\s\S]*?const res = await action\.run\("choices", /, "a retry clears the error (the spinner comes back) and supersedes an older read");
  assert.match(dialog, /if \(!res\) return;/);
  assert.match(dialog, /useEffect\(\(\) => \{\s*void loadChoices\(\);/);
  assert.match(dialog, /const noRoot = !choices\.rootFolders\.some\(\(r\) => r\.accessible\);/);
  assert.match(dialog, /\{noRoot && <span className="block">\{t\("adminArr\.add\.noRootFolder", \{ name: instanceLabel \}\)\}<\/span>\}/);
  assert.match(dialog, /\{noProfile && <span className="block">\{t\("adminArr\.add\.noQualityProfile", \{ name: instanceLabel \}\)\}<\/span>\}/);
  assert.match(dialog, /const tRef = useTRef\(\);/, "the shared translator ref, not a private copy");
});

// ── the Add button after an add ─────────────────────────────────────────────

test("after an add — or finding the title already there — the button becomes Manage, focused; an add with no arr id says it was added", () => {
  const dialog = src("add-dialog.tsx");
  // Already on the instance: the choices read says so, and the parent hears its id.
  assert.match(dialog, /if \(res\.data\.presentArrId !== null\) onAdded\(res\.data\.presentArrId\);/);
  // Every add's answer reaches the parent, an id or null — never dropped.
  assert.match(dialog, /onAdded\(typeof arrId === "number" && Number\.isSafeInteger\(arrId\) && arrId > 0 \? arrId : null\);/);
  assert.match(dialog, /const onAdded = useCallback\(\(arrId: number \| null\) => setOnInstance\(\{ arrId \}\), \[\]\);/);
  assert.match(dialog, /onAdded=\{onAdded\} \/>/);
  const button = dialog.slice(dialog.indexOf("export function ArrAddButton"));
  assert.match(button, /if \(onInstance !== null && !open\) \{\s*if \(onInstance\.arrId !== null\) \{\s*return <ManageTitleButton [^>]*target=\{\{ arrId: onInstance\.arrId \}\}[^>]*autoFocus \/>;\s*\}[\s\S]*?return <AddedNote instanceLabel=\{instanceLabel\} \/>;/);
  assert.match(dialog, /function AddedNote\([\s\S]*?useEffect\(\(\) => \{\s*ref\.current\?\.focus\(\);\s*\}, \[\]\);[\s\S]*?tabIndex=\{-1\} role="status"/);
  const manage = src("title-manager.tsx");
  assert.match(manage, /useEffect\(\(\) => \{\s*if \(autoFocus\) triggerRef\.current\?\.focus\(\);\s*\}, \[autoFocus\]\);/);
  assert.equal([...manage.matchAll(/ref=\{triggerRef\}/g)].length, 2, "both variants of the button");
});

test("the Add dialog's picks are the arr's own words: a select's value is kept only when it is one", () => {
  const dialog = src("add-dialog.tsx");
  assert.match(dialog, /availability: MinimumAvailability;/);
  assert.match(dialog, /seriesType: SeriesType;/);
  assert.match(dialog, /onChange=\{\(e\) => \{ if \(oneOf\(MINIMUM_AVAILABILITIES, e\.target\.value\)\) set\("availability", e\.target\.value\); \}\}/);
  assert.match(dialog, /onChange=\{\(e\) => \{ if \(oneOf\(SERIES_TYPES, e\.target\.value\)\) set\("seriesType", e\.target\.value\); \}\}/);
  assert.match(dialog, /onChange=\{\(e\) => \{ if \(oneOf\(SONARR_ADD_MONITOR, e\.target\.value\)\) set\("monitor", e\.target\.value\); \}\}/);
  assert.doesNotMatch(dialog, /as SonarrAddMonitor/);
});

test("a Settings save whose re-read failed keeps showing what it saved until the manager's re-read lands", () => {
  const tab = src("settings-tab.tsx");
  const save = tab.slice(tab.indexOf("async function save("), tab.indexOf("// The current values stay selectable"));
  assert.match(save, /const sent = draft;/);
  assert.match(save, /setLanded\(res\.data\.title === null \? \{ on: title, draft: sent \} : null\);\s*setEdits\(\{\}\);/);
  assert.match(tab, /const base = formBase\(title, reported, landed\);/);
});
