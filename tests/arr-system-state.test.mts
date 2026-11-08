// Admin → Arr System, the pure half of its tabs (src/components/admin/arr-system-state.ts):
// what a provider test or save leaves behind, per provider in its instance's
// indexer or client section, and when a verdict still describes what is on
// screen.
//
// - Test All replaces every row's verdict of its kind (a row it didn't test
//   loses an older one) but never a row's override or held prompt, and keeps a
//   summary; its refusal drops the summary and keeps the rows.
// - A single test's answer clears the kind's Test All verdicts; its refusal
//   leaves them.
// - A save's outcome always drops a held prompt; a refusal keeps the provider
//   the arr says it now holds.
// - Reload drops only the overrides and prompts that were there at the click.
// - A verdict shows only beside the provider (or list) it was given for.
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  activeCommandNames, cardKey, dropHeld, failureView, heldBack, listSignature, providerSignature, pruneAfterReload, saved, saveFailed,
  sectionKey, sectionOf, singleTestAnswered, singleTestFailed, testAllAnswered, testAllFailed, updateSection, visibleSummary,
  visibleVerdict, type SectionState, type Sections,
} from "../src/components/admin/arr-system-state.ts";
import type { ArrCommandRow, ProviderTestResult } from "../src/lib/arr-system.ts";

type P = { id: number; enable: boolean };
const ok = (id: number): ProviderTestResult => ({ id, ok: true, warning: false, messages: [] });
const bad = (id: number): ProviderTestResult => ({ id, ok: false, warning: false, messages: ["no"] });
const unclear = (id: number): ProviderTestResult => ({ id, ok: false, warning: false, messages: ["?"], uncertain: true });
const sigs = new Map([[1, "s1"], [2, "s2"], [3, "s3"]]);

const base = (): SectionState<P> => ({
  rows: {
    1: { result: { view: bad(1), against: "s1" }, override: { id: 1, enable: false } },
    2: { held: { change: { enable: true }, messages: ["slow"] } },
    3: { result: { view: ok(3), against: "s3" } },
  },
});

test("keys: a card per instance, a section per kind on it", () => {
  assert.equal(cardKey("sonarr", "4k"), "sonarr:4k");
  assert.equal(sectionKey(cardKey("radarr", ""), "downloadClient"), "radarr::downloadClient");
});

test("Test All replaces every verdict of its kind, keeps overrides and held prompts, and counts the answer", () => {
  const next = testAllAnswered(base(), [ok(1), unclear(2)], sigs, "list");
  assert.deepEqual(next.rows[1], { override: { id: 1, enable: false }, result: { view: ok(1), against: "s1" } });
  assert.deepEqual(next.rows[2], { held: { change: { enable: true }, messages: ["slow"] }, result: { view: unclear(2), against: "s2" } });
  assert.equal(next.rows[3], undefined, "a row it didn't test loses its older verdict");
  assert.deepEqual(next.summary, { working: 1, count: 2, uncertain: 1, against: "list" });
  assert.equal(next.all, undefined);
});

test("a refused Test All says so for the kind, drops the older summary, and leaves the rows", () => {
  const withSummary = { ...base(), summary: { working: 1, count: 1, uncertain: 0, against: "list" } };
  const next = testAllFailed(withSummary, failureView("Radarr is unreachable", false), "list");
  assert.equal(next.summary, undefined);
  assert.deepEqual(next.all, { view: { ok: false, warning: false, messages: ["Radarr is unreachable"] }, against: "list" });
  assert.deepEqual(next.rows, base().rows);
});

test("a single test's answer clears the kind's Test All verdicts; its refusal leaves them", () => {
  const withAll: SectionState<P> = { ...base(), summary: { working: 1, count: 1, uncertain: 0, against: "l" }, all: { view: failureView("x", false), against: "l" } };
  const answered = singleTestAnswered(withAll, [bad(3)], sigs);
  assert.equal(answered.summary, undefined);
  assert.equal(answered.all, undefined);
  assert.deepEqual(answered.rows[3], { result: { view: bad(3), against: "s3" } });
  assert.deepEqual(answered.rows[1], base().rows[1], "other rows untouched");
  const refused = singleTestFailed(withAll, 3, failureView("still", true), "s3");
  assert.deepEqual(refused.summary, withAll.summary);
  assert.deepEqual(refused.all, withAll.all);
  assert.deepEqual(refused.rows[3], { result: { view: { ok: false, warning: false, messages: ["still"], pending: true }, against: "s3" } });
});

test("a save's outcome always drops a held prompt; a refusal keeps what the arr says it holds", () => {
  const s = base();
  assert.deepEqual(saved(s, 2, { id: 2, enable: true }).rows[2], { override: { id: 2, enable: true } });
  assert.deepEqual(saved(s, 1, { id: 1, enable: true }).rows[1], { override: { id: 1, enable: true } }, "the old verdict goes");
  assert.deepEqual(heldBack(s, 1, { change: { enable: true }, messages: [] }).rows[1], { override: { id: 1, enable: false }, held: { change: { enable: true }, messages: [] } });
  const timedOut = saveFailed(s, 2, failureView("still", true), "s2", { id: 2, enable: true });
  assert.deepEqual(timedOut.rows[2], { override: { id: 2, enable: true }, result: { view: failureView("still", true), against: "s2" } });
  const refused = saveFailed(s, 1, failureView("no", false), "s1", null);
  assert.deepEqual(refused.rows[1].override, { id: 1, enable: false }, "no provider in the refusal: the row keeps its own");
  assert.deepEqual(dropHeld(s, 2).rows[2], undefined, "an emptied row goes");
  assert.equal(dropHeld(s, 3), s, "nothing held: unchanged");
});

test("Reload drops only the overrides and prompts that were there at the click", () => {
  const before: Sections<P> = { "radarr::indexer": base() };
  // A save answered while the reload was out: a NEW override on row 3, a new held prompt on row 1.
  let now = updateSection(before, "radarr::indexer", (s) => saved(s, 3, { id: 3, enable: true }));
  now = updateSection(now, "radarr::indexer", (s) => heldBack(s, 1, { change: { enable: true }, messages: ["new"] }));
  const pruned = sectionOf(pruneAfterReload(now, before), "radarr::indexer");
  assert.deepEqual(pruned.rows[1], { held: { change: { enable: true }, messages: ["new"] } }, "the old override goes; the new prompt stays");
  assert.equal(pruned.rows[2], undefined, "the prompt that was there at the click goes");
  assert.deepEqual(pruned.rows[3], { override: { id: 3, enable: true } }, "a newer override stays");
  assert.deepEqual(
    sectionOf(pruneAfterReload(before, before), "radarr::indexer").rows,
    { 1: { result: { view: bad(1), against: "s1" } }, 3: { result: { view: ok(3), against: "s3" } } },
    "verdicts are kept (a report that changes a provider hides its verdict instead)",
  );
});

test("a verdict shows only beside the provider — and a summary only over the list — it was given for", () => {
  const p = { id: 1, name: "I", enable: true };
  const against = providerSignature(p);
  const verdict = { view: ok(1), against };
  assert.deepEqual(visibleVerdict(verdict, providerSignature({ ...p })), ok(1));
  assert.equal(visibleVerdict(verdict, providerSignature({ ...p, enable: false })), undefined, "a report that changed it hides the verdict");
  assert.equal(visibleVerdict(undefined, against), undefined);
  const list = listSignature([p]);
  const summary = { working: 1, count: 1, uncertain: 0, against: list };
  assert.deepEqual(visibleSummary(summary, listSignature([{ ...p }])), summary);
  assert.equal(visibleSummary(summary, listSignature([p, { id: 2, name: "J", enable: true }])), undefined);
});

test("a card's running commands are its queued and started ones", () => {
  const row = (commandName: string, status: ArrCommandRow["status"]): ArrCommandRow =>
    ({ id: 1, name: commandName, commandName, status, trigger: "manual", queued: null, started: null, ended: null, durationSeconds: null, message: null });
  const names = activeCommandNames([row("RssSync", "started"), row("Backup", "queued"), row("RefreshMovie", "completed"), row("X", "failed")]);
  assert.deepEqual([...names].sort(), ["Backup", "RssSync"]);
});
