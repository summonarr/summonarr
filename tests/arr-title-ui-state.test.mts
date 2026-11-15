// The admin title manager's state discipline and its request-list host: the
// v0.34.0+ audit's, pinned. The refresh hold is the pure
// src/lib/refresh-gate.ts; the wiring it can't see is pinned structurally
// (node:test has no client render harness).
//
// What is pinned:
// The open-time reset (state, edits, tab, the open-time read) runs at
//         OPEN only — a host re-rendering with another initialTab (the request
//         list's follows the row's live status) must not re-run it and throw
//         away unsaved Settings edits without asking.
// The discard banner goes once there is nothing to discard (saved,
//         reset); left up, closeVerdict read it as answered and the next close
//         of a fresh edit skipped the question.
// A write's answer (Settings save, season/episode flip) drops every
//         read still in flight — it may predate the write — and reads again
//         when one was, instead of letting the older read land over it
//         (use-title-load.ts).
// The request list holds its live refresh while a row's manager is
//         open (a refresh can drop the row and the dialog with it), and runs
//         it once the last one closes.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRefreshGate } from "../src/lib/refresh-gate.ts";

const read = (path: string) => readFileSync(new URL(`../src/${path}`, import.meta.url), "utf8");
const manager = () => read("components/admin/arr-title/title-manager.tsx");
const titleLoad = () => read("components/admin/arr-title/use-title-load.ts");
const list = () => read("components/admin/admin-request-list.tsx");

/** The source of the ArrTitleManager component (before ManageTitleButton). */
function managerBody(): string {
  const src = manager();
  return src.slice(src.indexOf("export function ArrTitleManager"), src.indexOf("export function ManageTitleButton"));
}

// ── the refresh gate ─────────────────────────────────────────────────

test("with no dialog open a refresh runs at once", () => {
  const gate = createRefreshGate();
  assert.equal(gate.request(), true);
  assert.equal(gate.request(), true);
  assert.equal(gate.closed(), false, "an unmatched close has nothing deferred to run");
});

test("a refresh wanted while a dialog is open waits, and runs once when it closes", () => {
  const gate = createRefreshGate();
  gate.opened();
  assert.equal(gate.request(), false, "deferred");
  assert.equal(gate.request(), false, "still deferred — one refresh, not two");
  assert.equal(gate.closed(), true, "the deferred refresh runs on close");
  assert.equal(gate.closed(), false, "…once");
  assert.equal(gate.request(), true, "and the gate is open again");
});

test("a dialog closing with nothing deferred runs nothing", () => {
  const gate = createRefreshGate();
  gate.opened();
  assert.equal(gate.closed(), false);
});

test("two dialogs — the refresh waits for the LAST close", () => {
  const gate = createRefreshGate();
  gate.opened();
  gate.opened();
  assert.equal(gate.request(), false);
  assert.equal(gate.closed(), false, "one is still open");
  assert.equal(gate.request(), false, "still held");
  assert.equal(gate.closed(), true);
});

test("an unmatched close never makes the next open read as closed", () => {
  const gate = createRefreshGate();
  gate.closed();
  gate.closed();
  gate.opened();
  assert.equal(gate.request(), false, "the dialog that just opened holds the refresh");
  assert.equal(gate.closed(), true);
});

test("the request list refreshes only through the gate, and its rows' managers report to it", () => {
  const src = list();
  assert.equal(src.match(/router\.refresh\(\)/g)?.length, 1, "one router.refresh() — the gated one");
  assert.match(src, /function refreshList\(\) \{\s*if \(refreshGate\.request\(\)\) router\.refresh\(\);\s*\}/);
  assert.match(src, /const \[refreshGate\] = useState\(createRefreshGate\);/, "one gate for the list's lifetime");
  const timer = src.slice(src.indexOf("function scheduleRefresh() {"), src.indexOf("useLiveEvents("));
  assert.match(timer, /setTimeout\(\(\) => \{\s*refreshTimerRef\.current = null;\s*refreshList\(\);\s*\}, 500\);/, "the live refresh goes through the gate");
  const batch = src.slice(src.indexOf("async function batchAction"), src.indexOf("const totalPages"));
  assert.match(batch, /refreshNow\(\);/, "so does the batch action's own refresh");
  assert.match(src, /function refreshNow\(\) \{[\s\S]*?refreshList\(\);\s*\}/, "which goes through the gate too");
  assert.match(
    src,
    /function onManagerActive\(open: boolean\) \{\s*if \(open\) return refreshGate\.opened\(\);\s*if \(refreshGate\.closed\(\) && !unmountedRef\.current\) scheduleRefresh\(\);\s*\}/,
    "the last close runs the held refresh — never while the list itself unmounts",
  );
  assert.match(src, /unmountedRef\.current = false;\s*return \(\) => \{\s*unmountedRef\.current = true;/);
  const button = src.slice(src.indexOf("<ManageTitleButton"), src.indexOf("/>", src.indexOf("<ManageTitleButton")));
  assert.match(button, /onActiveChange=\{onManagerActive\}/);
});

test("ManageTitleButton reports open, and close — also an unmount while open", () => {
  const src = manager();
  const button = src.slice(src.indexOf("export function ManageTitleButton"), src.indexOf("export function ArrManageButton"));
  assert.match(button, /onActiveChange\?: \(open: boolean\) => void;/);
  assert.match(button, /const activeRef = useRef\(onActiveChange\);\s*useEffect\(\(\) => \{\s*activeRef\.current = onActiveChange;\s*\}\);/, "the latest callback — a new function per render is not a close");
  assert.match(
    button,
    /useEffect\(\(\) => \{\s*if \(!open\) return;\s*activeRef\.current\?\.\(true\);\s*const active = activeRef;\s*return \(\) => active\.current\?\.\(false\);\s*\}, \[open\]\);/,
    "the cleanup reports the close, so an unmount can't leave the list holding its refresh forever",
  );
  // The removal hand-off (tests/arr-manage-links.test.mts) is untouched.
  assert.match(button, /onOpenChange=\{changeOpen\}/);
});

// ── the tab is chosen at open time only ──────────────────────────────

test("the open-time reset does not re-run on an initialTab change", () => {
  const body = managerBody();
  const start = body.indexOf("useEffect(() => {\n    if (!open) return;");
  assert.ok(start > 0, "the open-time effect");
  const effect = body.slice(start, body.indexOf("]);", start) + 3);
  assert.match(effect, /\}, \[open, target, commands, stopWatches\]\);$/);
  assert.doesNotMatch(effect.slice(effect.lastIndexOf("}, [")), /firstTab/, "firstTab is not a dependency");
  assert.match(effect, /const openTab = firstTabRef\.current;/, "it reads the tab through the ref");
  assert.match(effect, /setTab\(openTab\);\s*setVisited\(new Set\(\["settings", openTab\]\)\);/);
  const refSync = body.indexOf("useEffect(() => {\n    firstTabRef.current = firstTab;\n  });");
  assert.ok(refSync > 0 && refSync < start, "the ref is synced by an effect declared BEFORE the open effect — current in the commit that opens");
  assert.match(body, /const firstTabRef = useRef\(firstTab\);/);
  // The title's own open-time read and reset (use-title-load.ts) key on the same target, by value.
  assert.match(titleLoad(), /\}, \[open, target, load, action\]\);/);
  assert.match(body, /const target = useStableTarget\(targetProp\);/);
});

test("every open starts clean: no line, prompt, release picker or command of the title before", () => {
  const body = managerBody();
  const start = body.indexOf("useEffect(() => {\n    if (!open) return;");
  const effect = body.slice(start, body.indexOf("]);", start) + 3);
  for (const reset of ['setNotice("");', 'setPartialNote("");', 'setError("");', "setRelease(null);", "setConfirmDiscard(false);", "setRemoved(false);", "setWatchKey(null);"]) {
    assert.ok(effect.includes(reset), reset);
  }
  // Closing (or a new target) drops the command bar's POSTs — no busy button or notice carries over.
  assert.match(effect, /return \(\) => \{\s*commands\.abort\(\);\s*stopWatches\(\);\s*\};/);
  assert.match(body, /const busy = commands\.busy\("search"\) \? "search" : commands\.busy\("refresh"\) \? "refresh" : null;/);
});

test("the discard banner takes focus on 'Keep editing', and gives it back where it was when it goes", () => {
  const body = managerBody();
  assert.match(
    body,
    /useEffect\(\(\) => \{\s*if \(confirmDiscard\) \{\s*keepEditingRef\.current\?\.focus\(\);\s*return;\s*\}\s*const back = discardReturn\.current;\s*discardReturn\.current = null;\s*if \(back\?\.isConnected\) back\.focus\(\);\s*\}, \[confirmDiscard\]\);/,
  );
  const leave = body.slice(body.indexOf("function leave(): boolean {"), body.indexOf("function requestClose("));
  assert.match(leave, /if \(!confirmDiscard && document\.activeElement instanceof HTMLElement\) discardReturn\.current = document\.activeElement;\s*setConfirmDiscard\(true\);/, "where focus was, kept before the banner takes it");
  assert.match(body, /keepRef=\{keepEditingRef\}/);
  assert.match(read("components/admin/arr-title/manager-parts.tsx"), /<Button ref=\{keepRef\} variant="ghost" size="sm" onClick=\{onKeep\}>/);
});

// ── the banner goes with the edits ───────────────────────────────────

test("nothing left unsaved clears the discard banner", () => {
  const body = managerBody();
  assert.match(
    body,
    /const onDirtyChange = useCallback\(\(dirty: boolean\) => \{\s*setSettingsDirty\(dirty\);\s*if \(!dirty\) setConfirmDiscard\(false\);\s*\}, \[\]\);/,
    "stable (SettingsTab's effect depends on it) and clears the banner",
  );
  assert.match(body, /onDirtyChange=\{onDirtyChange\}/);
  assert.doesNotMatch(body, /onDirtyChange=\{setSettingsDirty\}/);
});

// ── a write's answer outranks a read still in flight ─────────────────

test("a write's answer drops every read still out — and reads again when one was", () => {
  const load = titleLoad();
  // Every read is the "load" action: busy while out, aborted (and dropped) by a newer one.
  assert.match(load, /const res = await action\.run\("load", \(signal\) =>/);
  const supersede = load.slice(load.indexOf("const supersedeReads = useCallback("));
  assert.match(supersede, /^const supersedeReads = useCallback\(\(\): boolean => \{\s*const overlapped = action\.busy\("load"\);\s*action\.abort\("load"\);\s*return overlapped;\s*\}, \[action\]\);/);
  const apply = load.slice(load.indexOf("const applyWrite = useCallback("), load.indexOf("}, [reload, supersedeReads]);"));
  assert.match(
    apply,
    /if \(!next\) return reload\(\);\s*const reread = supersedeReads\(\);\s*setState\(\(s\) => \(s \? \{ \.\.\.s, title: mergeTitle\(s\.title, next\) \} : s\)\);\s*if \(reread\) reload\(\);/,
    "drops older reads BEFORE its title goes in, then reads again if one was in flight",
  );
  // Both writes' answers come through it: a Settings save and a season/episode flip.
  const body = managerBody();
  assert.match(body, /onSaved=\{applyWrite\}/);
  assert.match(body, /onTitle=\{applyWrite\}/);
});

// ── a failed open-time read can be retried ─────────────────────────────────

test("a failed open-time read offers Retry, which reads again as the open did", () => {
  const body = managerBody();
  const failed = body.slice(body.indexOf("loadError ? ("), body.indexOf(") : (", body.indexOf("loadError ? (")));
  assert.match(failed, /onClick=\{retry\}/);
  assert.match(failed, /\{t\("adminArr\.common\.retry"\)\}/);
  assert.match(
    titleLoad(),
    /retry: \(\) => \{\s*setLoadError\(""\);\s*if \(arrId !== null\) void load\(\{ arrId \}\);\s*else void load\(target, true\);\s*\},/,
    "with nothing shown it is the open-time read; with a title shown it rebases",
  );
});

test("a failed read over a title already shown has its own line and Retry, and never hides command feedback", () => {
  const body = managerBody();
  const shown = body.slice(body.indexOf("<ArrSnapshotNote at={staleAt}"));
  assert.match(shown, /\{loadError && \(\s*<p role="alert"[\s\S]*?\{loadError\}\s*<Button variant="ghost" size="sm" onClick=\{retry\}>/);
  assert.match(shown, /<StatusLine error=\{error\} /, "the command line shows the command's own error only");
  // Save still waits for a live base: only an accepted live answer marks it.
  assert.match(titleLoad(), /setLoadError\(""\);\s*markLive\(\);/);
  assert.match(body, /baseIsSnapshot=\{staleAt !== null\}/);
});
