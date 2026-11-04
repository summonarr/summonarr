// The admin title manager's state discipline and its request-list host: the
// v0.34.0+ audit's C053 (F075–F078), pinned. The refresh hold is the pure
// src/lib/refresh-gate.ts; the wiring it can't see is pinned structurally
// (node:test has no client render harness).
//
// What is pinned:
//   F075  The open-time reset (state, edits, tab, the open-time read) runs at
//         OPEN only — a host re-rendering with another initialTab (the request
//         list's follows the row's live status) must not re-run it and throw
//         away unsaved Settings edits without asking.
//   F076  The discard banner goes once there is nothing to discard (saved,
//         reset); left up, closeVerdict read it as answered and the next close
//         of a fresh edit skipped the question.
//   F077  A write's answer (Settings save, season/episode flip) drops every
//         read still in flight — it may predate the write — and reads again
//         when one was, instead of letting the older read land over it.
//   F078  The request list holds its live refresh while a row's manager is
//         open (a refresh can drop the row and the dialog with it), and runs
//         it once the last one closes.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRefreshGate } from "../src/lib/refresh-gate.ts";

const read = (path: string) => readFileSync(new URL(`../src/${path}`, import.meta.url), "utf8");
const manager = () => read("components/admin/arr-title/title-manager.tsx");
const list = () => read("components/admin/admin-request-list.tsx");

/** The source of the ArrTitleManager component (before ManageTitleButton). */
function managerBody(): string {
  const src = manager();
  return src.slice(src.indexOf("export function ArrTitleManager"), src.indexOf("export function ManageTitleButton"));
}

// ── F078: the refresh gate ─────────────────────────────────────────────────

test("F078: with no dialog open a refresh runs at once", () => {
  const gate = createRefreshGate();
  assert.equal(gate.request(), true);
  assert.equal(gate.request(), true);
  assert.equal(gate.closed(), false, "an unmatched close has nothing deferred to run");
});

test("F078: a refresh wanted while a dialog is open waits, and runs once when it closes", () => {
  const gate = createRefreshGate();
  gate.opened();
  assert.equal(gate.request(), false, "deferred");
  assert.equal(gate.request(), false, "still deferred — one refresh, not two");
  assert.equal(gate.closed(), true, "the deferred refresh runs on close");
  assert.equal(gate.closed(), false, "…once");
  assert.equal(gate.request(), true, "and the gate is open again");
});

test("F078: a dialog closing with nothing deferred runs nothing", () => {
  const gate = createRefreshGate();
  gate.opened();
  assert.equal(gate.closed(), false);
});

test("F078: two dialogs — the refresh waits for the LAST close", () => {
  const gate = createRefreshGate();
  gate.opened();
  gate.opened();
  assert.equal(gate.request(), false);
  assert.equal(gate.closed(), false, "one is still open");
  assert.equal(gate.request(), false, "still held");
  assert.equal(gate.closed(), true);
});

test("F078: an unmatched close never makes the next open read as closed", () => {
  const gate = createRefreshGate();
  gate.closed();
  gate.closed();
  gate.opened();
  assert.equal(gate.request(), false, "the dialog that just opened holds the refresh");
  assert.equal(gate.closed(), true);
});

test("F078: the request list refreshes only through the gate, and its rows' managers report to it", () => {
  const src = list();
  assert.equal(src.match(/router\.refresh\(\)/g)?.length, 1, "one router.refresh() — the gated one");
  assert.match(src, /function refreshList\(\) \{\s*if \(refreshGate\.request\(\)\) router\.refresh\(\);\s*\}/);
  assert.match(src, /const \[refreshGate\] = useState\(createRefreshGate\);/, "one gate for the list's lifetime");
  const timer = src.slice(src.indexOf("function scheduleRefresh() {"), src.indexOf("useLiveEvents("));
  assert.match(timer, /setTimeout\(\(\) => \{\s*refreshTimerRef\.current = null;\s*refreshList\(\);\s*\}, 500\);/, "the live refresh goes through the gate");
  const batch = src.slice(src.indexOf("async function batchAction"), src.indexOf("const totalPages"));
  assert.match(batch, /refreshList\(\);/, "so does the batch action's own refresh");
  assert.match(
    src,
    /function onManagerActive\(open: boolean\) \{\s*if \(open\) return refreshGate\.opened\(\);\s*if \(refreshGate\.closed\(\) && !unmountedRef\.current\) scheduleRefresh\(\);\s*\}/,
    "the last close runs the held refresh — never while the list itself unmounts",
  );
  assert.match(src, /unmountedRef\.current = false;\s*return \(\) => \{\s*unmountedRef\.current = true;/);
  const button = src.slice(src.indexOf("<ManageTitleButton"), src.indexOf("/>", src.indexOf("<ManageTitleButton")));
  assert.match(button, /onActiveChange=\{onManagerActive\}/);
});

test("F078: ManageTitleButton reports open, and close — also an unmount while open", () => {
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

// ── F075: the tab is chosen at open time only ──────────────────────────────

test("F075: the open-time reset does not re-run on an initialTab change", () => {
  const body = managerBody();
  const start = body.indexOf("useEffect(() => {\n    if (!open) return;");
  assert.ok(start > 0, "the open-time effect");
  const effect = body.slice(start, body.indexOf("]);", start) + 3);
  assert.match(effect, /\}, \[open, targetKey, load, stopWatches\]\);$/);
  assert.doesNotMatch(effect.slice(effect.lastIndexOf("}, [")), /firstTab/, "firstTab is not a dependency");
  assert.match(effect, /const openTab = firstTabRef\.current;/, "it reads the tab through the ref");
  assert.match(effect, /setTab\(openTab\);\s*setVisited\(new Set\(\["settings", openTab\]\)\);/);
  const refSync = body.indexOf("useEffect(() => {\n    firstTabRef.current = firstTab;\n  });");
  assert.ok(refSync > 0 && refSync < start, "the ref is synced by an effect declared BEFORE the open effect — current in the commit that opens");
  assert.match(body, /const firstTabRef = useRef\(firstTab\);/);
});

// ── F076: the banner goes with the edits ───────────────────────────────────

test("F076: nothing left unsaved clears the discard banner", () => {
  const body = managerBody();
  assert.match(
    body,
    /const onDirtyChange = useCallback\(\(dirty: boolean\) => \{\s*setSettingsDirty\(dirty\);\s*if \(!dirty\) setConfirmDiscard\(false\);\s*\}, \[\]\);/,
    "stable (SettingsTab's effect depends on it) and clears the banner",
  );
  assert.match(body, /onDirtyChange=\{onDirtyChange\}/);
  assert.doesNotMatch(body, /onDirtyChange=\{setSettingsDirty\}/);
});

// ── F077: a write's answer outranks a read still in flight ─────────────────

test("F077: every read is counted while in flight; a write's answer drops it and reads again", () => {
  const body = managerBody();
  const load = body.slice(body.indexOf("const load = useCallback("), body.indexOf("}, [service, instance, tRef]);"));
  assert.match(load, /loadsInFlight\.current\+\+;\s*const res = await arrApi<TitleState>\([^;]*\);\s*loadsInFlight\.current--;\s*if \(seq !== loadSeq\.current\) return;/, "counted down before the staleness check — a dropped read is no longer in flight");
  const supersede = body.slice(body.indexOf("function supersedeReads(): boolean {"));
  assert.match(supersede, /^function supersedeReads\(\): boolean \{\s*const overlapped = loadsInFlight\.current > 0;\s*loadSeq\.current\+\+;\s*return overlapped;\s*\}/);
  for (const handler of ["onSaved={(next) => {", "onTitle={(next) => {"]) {
    const i = body.indexOf(handler);
    assert.ok(i > 0, handler);
    const h = body.slice(i, body.indexOf("}}", i));
    assert.match(
      h,
      /if \(!next\) return reload\(\);\s*const reread = supersedeReads\(\);\s*setState\(\(s\) => \(s \? \{ \.\.\.s, title: mergeTitle\(s\.title, next\) \} : s\)\);\s*if \(reread\) reload\(\);/,
      `${handler} drops older reads BEFORE its title goes in, then reads again if one was in flight`,
    );
  }
});
