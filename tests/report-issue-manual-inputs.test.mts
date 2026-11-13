// ReportIssueButton's manual-vs-select season/episode predicate.
//
// The component is a "use client" .tsx file that the test loader cannot import
// (JSX plus icon/dialog imports). So the test cuts the one pure helper out of
// the source text, strips its types with the TypeScript compiler, and runs it
// on its own.
//
// What it pins (review-2026-09 fix f96): for a TV title that is NOT in any
// visible library, /api/tv-availability answers 200 `{ source: null, seasons: [] }`.
// `availabilityFailed` stays false and the season list is empty, so the manual
// number inputs must stay on screen while the dialog is `submitting`, not only
// while it is `open`. Checking `open` alone swapped them for an empty, disabled
// <select> during every submit, then flipped back on a server error.

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

// ── season/episode picks across scope changes and seeded opens ───────────────
// Two more pure helpers cut out the same way. keepSeasonEpisode is what a
// scope change runs (withScope, from the scope select's onChange): it used to
// reset every change to the first season (Season 3 picked under SEASON became Season 1 under EPISODE) and
// clear the manual inputs. withSeedOptions keeps a watch-history seed the
// library lists don't contain selectable instead of swapping it for the first
// season's first episode.

type SeasonInfo = { seasonNumber: number; episodes: number[] };
type Pick = { season: number | null; episode: number | null };

function loadHelper<T>(name: string): T {
  const m = new RegExp(`function ${name}\\([\\s\\S]*?\\n\\}\\n`).exec(source);
  assert.ok(m, `${name} helper must exist in report-issue-button.tsx`);
  const js = ts.transpileModule(m[0], {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext },
  }).outputText;
  return new Function(`${js}\nreturn ${name};`)() as T;
}

const keepSeasonEpisode = loadHelper<(s: SeasonInfo[], season: number | null, episode: number | null) => Pick>("keepSeasonEpisode");
const withSeedOptions = loadHelper<(s: SeasonInfo[], season: number | null, episode: number | null) => SeasonInfo[]>("withSeedOptions");

const LIST: SeasonInfo[] = [
  { seasonNumber: 1, episodes: [1, 2, 3] },
  { seasonNumber: 3, episodes: [4, 5] },
];

test("a scope change keeps a season the list still holds, and its episode when listed", () => {
  assert.deepEqual(keepSeasonEpisode(LIST, 3, null), { season: 3, episode: 4 }, "the episode is seeded, never null");
  assert.deepEqual(keepSeasonEpisode(LIST, 3, 5), { season: 3, episode: 5 });
  assert.deepEqual(keepSeasonEpisode(LIST, 3, 9), { season: 3, episode: 4 }, "an unlisted episode falls back to the season's first");
});

test("a season the list doesn't hold falls back to the first season and ITS first episode", () => {
  assert.deepEqual(keepSeasonEpisode(LIST, 7, 5), { season: 1, episode: 1 });
  assert.deepEqual(keepSeasonEpisode(LIST, null, null), { season: 1, episode: 1 });
  assert.deepEqual(keepSeasonEpisode([], 3, 4), { season: null, episode: null });
});

test("the episode is never null while the chosen season has episodes", () => {
  for (const season of [null, 1, 3, 7]) {
    for (const episode of [null, 1, 4, 99]) {
      const pick = keepSeasonEpisode(LIST, season, episode);
      const chosen = LIST.find((s) => s.seasonNumber === pick.season);
      assert.ok(chosen && chosen.episodes.includes(pick.episode as number), `${season}/${episode} → ${JSON.stringify(pick)}`);
    }
  }
});

type Form = {
  issueType: string; scope: "FULL" | "SEASON" | "EPISODE"; note: string;
  selectedSeason: number | null; selectedEpisode: number | null; manualSeason: string; manualEpisode: string;
};

// withScope calls keepSeasonEpisode, so both are lifted into one module.
function loadWithScope(): (form: Form, seasons: SeasonInfo[], scope: Form["scope"]) => Form {
  const parts = ["keepSeasonEpisode", "withScope"].map((name) => {
    const m = new RegExp(`function ${name}\\([\\s\\S]*?\\n\\}\\n`).exec(source);
    assert.ok(m, `${name} helper must exist in report-issue-button.tsx`);
    return m[0];
  });
  const js = ts.transpileModule(parts.join("\n"), {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext },
  }).outputText;
  return new Function(`${js}\nreturn withScope;`)() as ReturnType<typeof loadWithScope>;
}
const withScope = loadWithScope();

const FORM: Form = {
  issueType: "BAD_VIDEO", scope: "SEASON", note: "", selectedSeason: 3, selectedEpisode: null, manualSeason: "3", manualEpisode: "",
};

test("a scope change re-validates the pick through keepSeasonEpisode and keeps the manual inputs", () => {
  const next = withScope(FORM, LIST, "EPISODE");
  assert.equal(next.scope, "EPISODE");
  assert.equal(next.selectedSeason, 3, "Season 3 under SEASON stays Season 3 under EPISODE");
  assert.equal(next.selectedEpisode, 4, "the episode is seeded, never null");
  assert.equal(next.manualSeason, "3", "the manual inputs keep their values");
  assert.equal(withScope(FORM, LIST, "SEASON"), FORM, "the same scope changes nothing");
});

test("the scope select runs withScope in its change handler, not a render-time reset", () => {
  assert.match(source, /onChange=\{\(e\) => setForm\(\(f\) => withScope\(f, tvSeasons, e\.target\.value as IssueScope\)\)\}/);
  assert.doesNotMatch(source, /prevScope/);
});

test("the dialog's X stays usable while the library loads; only a submit holds it", () => {
  assert.match(source, /<DialogHeader title=\{title\} closeDisabled=\{isSubmitting\} t=\{t\} \/>/);
});

test("a seeded season/episode the library lists miss joins the options and stays selected", () => {
  const merged = withSeedOptions(LIST, 5, 3);
  assert.deepEqual(merged.map((s) => s.seasonNumber), [1, 3, 5], "sorted by season");
  assert.deepEqual(merged.find((s) => s.seasonNumber === 5)?.episodes, [3]);
  assert.deepEqual(keepSeasonEpisode(merged, 5, 3), { season: 5, episode: 3 });

  // Season listed, episode not: the episode joins that season, sorted.
  const withEp = withSeedOptions(LIST, 3, 1);
  assert.deepEqual(withEp.find((s) => s.seasonNumber === 3)?.episodes, [1, 4, 5]);
  assert.deepEqual(keepSeasonEpisode(withEp, 3, 1), { season: 3, episode: 1 });
});

test("without a seed (or with an empty list) the options are the library's own", () => {
  assert.equal(withSeedOptions(LIST, null, null), LIST);
  assert.equal(withSeedOptions(LIST, 1, 2), LIST, "an already-listed seed changes nothing");
  // Not in any library: the list stays empty so the (seeded) manual inputs show.
  assert.deepEqual(withSeedOptions([], 5, 3), []);
  assert.deepEqual(keepSeasonEpisode(withSeedOptions(LIST, null, null), null, null), { season: 1, episode: 1 });
});

// ── openDialog writes only for the current open ──────────────────────────────
function openDialogText(): string {
  const start = source.indexOf("async function openDialog()");
  const end = source.indexOf("function closeDialog()", start);
  assert.ok(start > 0 && end > start, "openDialog not found");
  return source.slice(start, end);
}

test("openDialog writes the availability lists or picks only for the current open", () => {
  // The load runs under one useAsyncAction key: a newer open replaces it and a
  // close aborts it, and run() then resolves undefined — checked before any write.
  const body = openDialogText();
  assert.match(body, /const res = await action\.run\("open", /);
  const guard = body.indexOf("if (!res) return;");
  const listWrite = body.indexOf("setLists({ seasons");
  const failWrite = body.indexOf("failed: true");
  assert.ok(guard > 0 && listWrite > guard && failWrite > guard, "a stale answer is dropped before any write");
  const close = source.slice(source.indexOf("function closeDialog()"), source.indexOf("async function handleSubmit"));
  assert.match(close, /action\.abort\("open"\)/, "closing the dialog drops the load in flight");
});

test("openDialog clears the previous open's lists and source label", () => {
  const body = openDialogText();
  assert.match(body, /setLists\(NO_LISTS\);/);
  assert.ok(body.indexOf("setLists(NO_LISTS)") < body.indexOf("await action.run("), "cleared before the reload");
  assert.match(source, /const NO_LISTS: LibraryLists = \{ seasons: \[\], source: null, failed: false \};/);
});

// The server files a season or episode only by a number of 1 or more, so a
// watched special (S0E3) must not open on a "Season 0" pick it answers 400 for.
const seededScope = loadHelper<(isTV: boolean, scope: string | undefined, season: number | null | undefined, episode: number | null | undefined) => string>("seededScope");
const reportableSeasons = loadHelper<(s: SeasonInfo[]) => SeasonInfo[]>("reportableSeasons");

test("a seeded special opens on the whole show; ordinary seeds keep their scope", () => {
  assert.equal(seededScope(true, "EPISODE", 0, 3), "FULL");
  assert.equal(seededScope(true, "SEASON", 0, null), "FULL");
  assert.equal(seededScope(true, "EPISODE", 2, 0), "SEASON");
  assert.equal(seededScope(true, "EPISODE", 2, 5), "EPISODE");
  assert.equal(seededScope(true, "SEASON", 2, undefined), "SEASON");
  assert.equal(seededScope(true, undefined, null, null), "FULL");
  assert.equal(seededScope(false, "EPISODE", 2, 5), "FULL", "a movie is always the whole title");
});

test("the season lists offer only what the server accepts", () => {
  assert.deepEqual(
    reportableSeasons([{ seasonNumber: 0, episodes: [1, 2] }, { seasonNumber: 1, episodes: [0, 1, 2] }, { seasonNumber: 2, episodes: [1] }]),
    [{ seasonNumber: 1, episodes: [1, 2] }, { seasonNumber: 2, episodes: [1] }],
  );
});
