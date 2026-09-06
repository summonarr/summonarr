// ReportIssueButton's manual-vs-select season/episode predicate.
//
// The component is a "use client" .tsx (JSX + icon/dialog imports the test
// loader cannot resolve), so the pure helper is extracted from the source text
// and type-stripped with the classic TypeScript compiler already in the tree,
// then evaluated on its own. This pins the review-2026-09 f96 fix: for a TV
// title that is NOT in any visible library, /api/tv-availability answers 200
// `{ source: null, seasons: [] }` — `availabilityFailed` stays false and the
// season list is empty — so the manual NumberInputs must stay mounted while
// the dialog is `submitting`, not only while it is `open`. Keying on `open`
// alone swapped them for an empty, disabled <select> for the length of every
// submit and flipped back on a server error.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
// The classic TS 6 that `next build` loads (see CLAUDE.md, Commands) — same
// as tests/client-render-purity.test.mts.
const ts = require("typescript") as typeof import("typescript");

const here = path.dirname(fileURLToPath(import.meta.url));
const SOURCE = path.join(here, "..", "src", "components", "media", "report-issue-button.tsx");
const source = readFileSync(SOURCE, "utf8");

type DialogState = "idle" | "loading" | "open" | "submitting" | "submitted" | "error";
type Predicate = (isTV: boolean, availabilityFailed: boolean, dialogState: DialogState, seasonCount: number) => boolean;

function loadPredicate(): Predicate {
  const m = /function shouldUseManualInputs\([\s\S]*?\n\}\n/.exec(source);
  assert.ok(m, "shouldUseManualInputs helper must exist in report-issue-button.tsx");
  const js = ts.transpileModule(m[0], {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext },
  }).outputText;
  const fn = new Function(`${js}\nreturn shouldUseManualInputs;`)() as Predicate;
  assert.equal(typeof fn, "function");
  return fn;
}

const shouldUseManualInputs = loadPredicate();

test("component derives useManualInputs from the extracted helper (no inline `open`-only predicate)", () => {
  assert.match(
    source,
    /const useManualInputs = shouldUseManualInputs\(isTV, availabilityFailed, dialogState, tvSeasons\.length\);/,
  );
  assert.doesNotMatch(source, /dialogState === "open" && tvSeasons\.length === 0/);
});

test("not-in-library show keeps manual inputs across the whole submit (open AND submitting)", () => {
  assert.equal(shouldUseManualInputs(true, false, "open", 0), true);
  assert.equal(shouldUseManualInputs(true, false, "submitting", 0), true, "f96: must not swap to an empty <select> while submitting");
});

test("a library-backed show (seasons > 0) uses the selects in both form states", () => {
  assert.equal(shouldUseManualInputs(true, false, "open", 3), false);
  assert.equal(shouldUseManualInputs(true, false, "submitting", 3), false);
});

test("loading / idle / submitted / error never select manual inputs on an empty list", () => {
  for (const state of ["idle", "loading", "submitted", "error"] as const) {
    assert.equal(shouldUseManualInputs(true, false, state, 0), false, state);
  }
});

test("availabilityFailed always forces manual inputs for TV, regardless of state or list", () => {
  for (const state of ["idle", "loading", "open", "submitting", "submitted", "error"] as const) {
    assert.equal(shouldUseManualInputs(true, true, state, 0), true, state);
    assert.equal(shouldUseManualInputs(true, true, state, 5), true, state);
  }
});

test("movies never use manual inputs", () => {
  assert.equal(shouldUseManualInputs(false, true, "open", 0), false);
  assert.equal(shouldUseManualInputs(false, false, "submitting", 0), false);
});
