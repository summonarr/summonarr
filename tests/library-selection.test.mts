// The Plex and Jellyfin library pickers' saved selection
// (src/lib/client/library-selection.ts). A picker seeded its ticked boxes from
// the stored list and never checked them against the libraries the server lists
// now, so ids from a deleted library or an earlier server stayed selected: they
// had no checkbox, hid the "none selected = every library" hint, and were saved
// again. The sync reads any non-empty list as a strict filter, so a list of only
// such ids synced nothing.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { parseLibrarySelection, reconcileLibrarySelection } from "../src/lib/client/library-selection.ts";

const form = (name: string) =>
  readFileSync(new URL(`../src/components/settings/forms/${name}`, import.meta.url), "utf8");

test("the stored list parses to trimmed, non-empty ids", () => {
  assert.deepEqual(parseLibrarySelection(" 1, 2 ,,3 "), ["1", "2", "3"]);
  assert.deepEqual(parseLibrarySelection(""), []);
});

test("ids the server no longer lists are dropped; listed ones keep their order", () => {
  assert.deepEqual(reconcileLibrarySelection(["9", "2", "1"], ["1", "2", "3"]), ["2", "1"]);
  assert.deepEqual(reconcileLibrarySelection(new Set(["a", "b"]), ["b", "a"]), ["a", "b"]);
});

test("an all-stale selection becomes empty, which saves as \"\" (every library)", () => {
  const kept = reconcileLibrarySelection(["old-1", "old-2"], ["new-1"]);
  assert.deepEqual(kept, []);
  assert.equal(kept.join(","), "");
});

test("both pickers save and hint from the reconciled list, never the raw selection", () => {
  // One picker for both servers.
  const src = form("media-server-library.tsx");
  assert.match(src, /const effective = reconcileLibrarySelection\(selected, /);
  assert.match(src, /const value = effective\.join\(","\);/);
  assert.match(src, /await save\(\{ \[service === "plex" \? "plexLibraries" : "jellyfinLibraries"\]: value \}\)/);
  assert.match(src, /\{effective\.length === 0 && /, `the "none selected" hint`);
  assert.doesNotMatch(src, /Array\.from\(selected\)/);
  assert.doesNotMatch(src, /selected\.size === 0/);
});

test("a remounted picker starts from the last saved selection, not the page-load prop", () => {
  for (const [file, prop] of [["plex-connect-form.tsx", "initialPlexLibraries"], ["jellyfin-sync-form.tsx", "initialJellyfinLibraries"]] as const) {
    const src = form(file);
    assert.match(src, new RegExp(`const \\[savedLibraries, setSavedLibraries\\] = useState\\(${prop}\\);`), file);
    assert.match(src, /initialSelected=\{savedLibraries\}/, file);
    assert.match(src, /onSaved=\{setSavedLibraries\}/, file);
  }
});

test("the Jellyfin picker follows the SAVED config, like the Sync button (guardrail 36)", () => {
  const src = form("jellyfin-sync-form.tsx");
  assert.match(src, /\{configured && \(\s*<LibraryPicker\s+service="jellyfin"/);
  assert.doesNotMatch(src, /\{url && apiKey && \(\s*<LibraryPicker/);
});
