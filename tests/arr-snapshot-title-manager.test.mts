// "Instant, then live" in the admin title manager (src/components/admin/arr-title/):
// on open, the title, a season's episodes, the files and the history each paint
// the snapshot the server kept for exactly that read (src/lib/arr-snapshot.ts),
// then the live read replaces it.
//
// What matters:
// - each snapshot URL IS its live read's URL (one builder) — the server keys a
//   snapshot on path + query, so a second spelling would never find it;
// - the Settings form holds the admin's EDITS over the title: a title snapshot
//   only fills an EMPTY dialog, the open-time live read that follows REBASES
//   the form like a background re-read (no remount, edits kept), and Save
//   waits until it has — no save is ever diffed against a snapshot;
// - a snapshot never lands over rows already shown, a superseded read, or a
//   write in flight (flips, file selections, delete/rename, command watches);
// - markLive() runs only for an ACCEPTED live answer (after the sequence check);
// - the stale note is rendered.
//
// The rules are pure (snapshot-rules.ts, unit-tested); the components are .tsx
// the unit loader can't import, so their wiring is pinned structurally.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  episodeSnapshotMayPaint,
  liveTitleLanding,
  snapshotMayPaint,
  titleReadPath,
} from "../src/components/admin/arr-title/snapshot-rules.ts";

const read = (f: string) => readFileSync(new URL(`../src/components/admin/arr-title/${f}`, import.meta.url), "utf8");
const MANAGER = read("title-manager.tsx");
// The manager's read of its title.
const LOAD = read("use-title-load.ts");
const SETTINGS = read("settings-tab.tsx");
const SEASONS = read("seasons-tab.tsx");
// The Seasons tab's episode lists.
const EPISODES = read("use-episode-lists.ts");
const FILES = read("files-tab.tsx");
const HISTORY = read("history-tab.tsx");

/** The source of `const <name> = useCallback(` … through its deps line. */
function callbackBody(src: string, name: string): string {
  const startAt = src.indexOf(`const ${name} = useCallback(`);
  assert.ok(startAt >= 0, `${name} is a useCallback`);
  const end = src.indexOf("\n  }, [", startAt);
  assert.ok(end > startAt, `${name} has a deps line`);
  return src.slice(startAt, src.indexOf("\n", end + 1));
}

// ---------------------------------------------------------------- pure rules

test("titleReadPath: one URL per target, by TMDB id or by the arr's own id", () => {
  assert.equal(titleReadPath("radarr", "", { tmdbId: 603 }), "/api/admin/arr/title?service=radarr&instance=&tmdbId=603");
  assert.equal(titleReadPath("sonarr", "4k", { arrId: 12 }), "/api/admin/arr/title?service=sonarr&instance=4k&id=12");
  // A slug is encoded, never spliced in raw.
  assert.equal(titleReadPath("sonarr", "a&b", { arrId: 1 }), "/api/admin/arr/title?service=sonarr&instance=a%26b&id=1");
});

test("liveTitleLanding: only an open-time read with NO snapshot painted replaces (and remounts Settings)", () => {
  assert.equal(liveTitleLanding(true, false), "replace");
  // A painted snapshot may already carry the admin's edits: rebase, like a background re-read.
  assert.equal(liveTitleLanding(true, true), "rebase");
  assert.equal(liveTitleLanding(false, false), "rebase");
  assert.equal(liveTitleLanding(false, true), "rebase");
});

test("snapshotMayPaint: only an empty view, never during a write", () => {
  assert.equal(snapshotMayPaint(false, false), true);
  assert.equal(snapshotMayPaint(true, false), false);
  assert.equal(snapshotMayPaint(false, true), false);
  assert.equal(snapshotMayPaint(true, true), false);
});

test("episodeSnapshotMayPaint: the newest unanswered (or failed) read of the season, over an empty list, no write in flight", () => {
  const base = { seq: 2, newest: 2, answered: 1, failed: false, shown: 0, writing: false };
  assert.equal(episodeSnapshotMayPaint(base), true);
  assert.equal(episodeSnapshotMayPaint({ ...base, answered: undefined }), true, "first read of a season");
  assert.equal(episodeSnapshotMayPaint({ ...base, newest: 3 }), false, "a newer read superseded this one");
  assert.equal(episodeSnapshotMayPaint({ ...base, answered: 2 }), false, "the live answer already landed");
  assert.equal(episodeSnapshotMayPaint({ ...base, answered: 2, failed: true }), true, "the live read failed: the last good list, marked stale");
  assert.equal(episodeSnapshotMayPaint({ ...base, answered: 2, failed: true, shown: 3 }), false, "a failed re-read keeps the rows it had");
  assert.equal(episodeSnapshotMayPaint({ ...base, newest: 3, failed: true }), false);
  assert.equal(episodeSnapshotMayPaint({ ...base, shown: 4 }), false, "rows are already shown (a flip's optimistic rows included)");
  assert.equal(episodeSnapshotMayPaint({ ...base, writing: true }), false, "a flip or search is in flight");
});

// ---------------------------------------------------------------- the title

test("title: the snapshot URL is the open-time live read's URL (one builder)", () => {
  // The endpoint is spelled only by the builder.
  for (const src of [MANAGER, LOAD]) assert.ok(!/[`"']\/api\/admin\/arr\/title\?/.test(src), "no hand-built title URL in the manager");
  assert.match(LOAD, /const openPath = open \? titleReadPath\(service, instance, target\) : null;/);
  assert.match(LOAD, /const snap = useArrSnapshot<unknown>\(openPath === null \? null : withBasePath\(openPath\), applyTitleSnapshot\);/);
  // The open-time live read: the same target.
  assert.match(LOAD, /void load\(target, true\);/);
  assert.match(callbackBody(LOAD, "load"), /arrApi\(titleReadPath\(service, instance, by\), \{ schema: TITLE_STATE, signal \}, tRef\.current\("adminArr\.manage\.loadFailed"\)\)/);
  // The target by its value: a parent re-render hands a new object.
  assert.match(MANAGER, /const target = useStableTarget\(targetProp\);/);
  assert.match(LOAD, /return useMemo\(\(\) => \(kind === "tmdb" \? \{ tmdbId: id \} : \{ arrId: id \}\), \[kind, id\]\);/);
});

test("title: the live answer rebases over a painted snapshot and marks live only once accepted", () => {
  const load = callbackBody(LOAD, "load");
  const dropped = load.indexOf("if (!res) return;");
  const okAt = load.indexOf("if (res.ok) {");
  const elseAt = load.indexOf("} else {", okAt);
  const live = load.indexOf("markLive();");
  assert.ok(dropped > 0 && okAt > dropped && live > okAt && live < elseAt, "markLive() inside the accepted ok branch, after a superseded read returned");
  assert.equal([...LOAD.matchAll(/markLive\(\);/g)].length, 1);
  // The url's own callback, carried by load's deps: no ref one render behind.
  assert.match(LOAD, /const \{ markLive \} = snap;/);
  assert.match(load, /const landing = liveTitleLanding\(initial, snapshotPainted\.current\);/);
  assert.match(load, /setState\(\(prev\) => \(prev && landing === "rebase" \? \{ \.\.\.res\.data, title: mergeTitle\(prev\.title, res\.data\.title\) \} : res\.data\)\);/);
  // Only a replace remounts the Settings form.
  assert.match(load, /if \(landing === "replace"\) setVersion\(\(v\) => v \+ 1\);/);
  assert.equal([...LOAD.matchAll(/setVersion\(/g)].length, 1);
  assert.match(load, /\}, \[action, service, instance, tRef, markLive\]\);/);
  // Every open starts with nothing painted, before its live read.
  const reset = LOAD.indexOf("snapshotPainted.current = false;");
  assert.ok(reset > 0 && reset < LOAD.indexOf("void load(target, true);"));
});

test("title: a snapshot only fills an empty dialog, once it passes the title's shape check, and touches nothing else", () => {
  const at = LOAD.indexOf("const applyTitleSnapshot = (data: unknown) => {");
  assert.ok(at > 0);
  const apply = LOAD.slice(at, LOAD.indexOf("\n  };", at));
  assert.match(apply, /const parsed = check\(TITLE_STATE, data\);\s*if \(!parsed\.ok \|\| !snapshotMayPaint\(state !== null, false\)\) return false;/);
  assert.match(apply, /snapshotPainted\.current = true;\s*setState\(parsed\.value\);\s*return true;/);
  for (const forbidden of ["setVersion", "setLoadError", "setError", "setNotice", "setTab", "setVisited", "setSettingsDirty", "setSettingsSaving", "setConfirmDiscard", "setWatchKey", "stopWatches", "markLive", "setBusy"]) {
    assert.ok(!apply.includes(forbidden), `applyTitleSnapshot must not call ${forbidden}`);
  }
});

test("title: Settings keeps edits across the rebase and Save waits for the live read", () => {
  assert.match(MANAGER, /<SettingsTab\s+key=\{version\}/);
  assert.match(MANAGER, /baseIsSnapshot=\{staleAt !== null\}/);
  assert.match(LOAD, /staleAt: snap\.staleAt,/);
  assert.match(SETTINGS, /<Button ref=\{saveRef\} size="sm" onClick=\{\(\) => void save\(\)\} disabled=\{!dirty \|\| saving \|\| confirmMove \|\| baseIsSnapshot\}>/);
  assert.match(SETTINGS, /baseIsSnapshot = false,/);
});

test("title: the stale note sits under the action row, refreshing until the live read answers or fails", () => {
  assert.match(MANAGER, /<ArrSnapshotNote at=\{staleAt\} refreshing=\{loadError === ""\} \/>/);
  // Under the action row, above the status line.
  const note = MANAGER.indexOf("<ArrSnapshotNote");
  assert.ok(note > MANAGER.indexOf("<CommandBar") && note < MANAGER.indexOf("<StatusLine"));
});

// ---------------------------------------------------------------- episodes

test("episodes: one URL per season read, a checked snapshot only on an empty list, gated per read", () => {
  const load = callbackBody(EPISODES, "loadEpisodes");
  assert.match(load, /const path = `\/api\/admin\/arr\/title\/episodes\?\$\{titleQuery\(titleRef, \{ season: n \}\)\}`;/);
  assert.match(load, /readArrSnapshot<unknown>\(withBasePath\(path\)\)/);
  assert.match(load, /const parsed = snap \? check\(EPISODES_ANSWER, snap\.data\) : null;\s*if \(!snap \|\| !parsed\?\.ok\) return;/, "a snapshot that isn't an episode list is refused");
  assert.match(load, /await arrApi\(path, \{ schema: EPISODES_ANSWER \}, /);
  assert.equal([...(SEASONS + EPISODES).matchAll(/\/api\/admin\/arr\/title\/episodes\?/g)].length, 1, "the read URL is built once");
  // Only a season shown for the first time asks for its snapshot.
  const firstOnly = load.indexOf("if (!listsRef.current[n]?.episodes.length) {");
  assert.ok(firstOnly > 0 && firstOnly < load.indexOf("readArrSnapshot<"), "the snapshot read sits behind the empty-list check");
  assert.match(
    load,
    /episodeSnapshotMayPaint\(\{\s*seq,\s*newest: listSeq\.current\[n\],\s*answered: doneSeq\.current\[n\],\s*failed: \(cur\?\.error \?\? ""\) !== "",\s*shown: cur\?\.episodes\.length \?\? 0,\s*writing: writing\(\),\s*\}\);\s*if \(!paint\) return l;/,
  );
  // A live answer clears the mark; a failed one keeps the snapshot marked.
  assert.match(load, /episodes: res\.data\.episodes, loadedAt: Date\.parse\(res\.data\.now\) \|\| 0, staleAt: null \}/);
  assert.match(load, /error: res\.error, episodes: l\[n\]\?\.episodes \?\? \[\], loadedAt: l\[n\]\?\.loadedAt \?\? 0, staleAt: l\[n\]\?\.staleAt \?\? null \}/);
  // The snapshot only ever sets the list; never the tab's busy state or error.
  const paintAt = load.indexOf("readArrSnapshot<");
  const snapBlock = load.slice(paintAt, load.indexOf("const res = await arrApi"));
  for (const forbidden of ["setBusy", "setError", "setExpanded", "onTitle", "markSeen", "action."]) {
    assert.ok(!snapBlock.includes(forbidden), `the episode snapshot must not call ${forbidden}`);
  }
  assert.match(SEASONS, /<ArrSnapshotNote at=\{list\?\.staleAt \?\? null\} refreshing=\{list\?\.loading \?\? false\} \/>/);
  // What the late snapshot reads: the lists as last rendered, and the tab's writes live.
  assert.match(EPISODES, /useEffect\(\(\) => \{\s*listsRef\.current = lists;\s*\}\);/);
  assert.match(SEASONS, /const writing = useCallback\(\(\) => action\.anyBusy, \[action\]\);/);
});

// ---------------------------------------------------------------- files + history

for (const [name, src, setter, schema, writing] of [
  ["files", FILES, "setFiles", "FILES_ANSWER", "writing()"],
  ["history", HISTORY, "setEvents", "EVENTS_ANSWER", "false"],
] as const) {
  test(`${name}: one URL for the live read and its snapshot, markLive only on an accepted answer`, () => {
    assert.match(src, new RegExp(`const readPath = useMemo\\(\\(\\) => \`/api/admin/arr/title/${name}\\?\\$\\{titleQuery\\(titleRef\\)\\}\`, \\[titleRef\\]\\);`));
    assert.match(src, /const snap = useArrSnapshot<unknown>\(withBasePath\(readPath\), applySnapshot\);/);
    const load = callbackBody(src, "load");
    assert.match(load, new RegExp(`arrApi\\(readPath, \\{ schema: ${schema}, signal \\}, `));
    const okAt = load.indexOf("if (res.ok) {");
    const live = load.indexOf("markLive();");
    assert.ok(okAt > 0 && live > okAt && live < load.indexOf("} else {", okAt), "markLive() inside the ok branch");
    assert.match(load, /\}, \[action, readPath, tRef, markLive\]\);/);
  });

  test(`${name}: a checked snapshot only fills an empty list, and touches nothing else`, () => {
    const at = src.indexOf("const applySnapshot = (data: unknown) => {");
    assert.ok(at > 0);
    const apply = src.slice(at, src.indexOf("\n  };", at));
    assert.match(apply, new RegExp(`const parsed = check\\(${schema}, data\\);\\s*if \\(!parsed\\.ok \\|\\| !snapshotMayPaint\\(${name === "files" ? "files" : "events"} !== null, ${writing.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\)\\) return false;\\s*${setter}\\(parsed\\.value\\.${name === "files" ? "files" : "events"}\\);\\s*return true;`));
    for (const forbidden of ["setError", "setLoadError", "setActionError", "setSelected", "setConfirmDelete", "setRenames", "setRenameSelected", "setNotice", "markLive", "watch(", "action.run"]) {
      assert.ok(!apply.includes(forbidden), `${name} applySnapshot must not call ${forbidden}`);
    }
  });
}

test("files and history: only the newest read lands — a newer one aborts the one before", () => {
  for (const [name, src, setter] of [["files", FILES, "setFiles"], ["history", HISTORY, "setEvents"]] as const) {
    const load = callbackBody(src, "load");
    const run = load.indexOf('action.run("load", (signal) =>');
    const dropped = load.indexOf("if (!res) return;");
    assert.ok(run >= 0 && dropped > run, `${name}: every read under one key; a superseded one returns before anything lands`);
    assert.ok(dropped < load.indexOf(setter) && dropped < load.indexOf("markLive();") && dropped < load.indexOf("Error(res.error)"), `${name}: ${setter}, markLive and the error all wait for it`);
  }
  // The spinner is the newest read's: the action's own busy state.
  assert.match(HISTORY, /const loading = action\.busy\("load"\);/);
  assert.match(FILES, /<ArrSnapshotNote at=\{snap\.staleAt\} refreshing=\{action\.busy\("load"\)\} \/>/);
});

test("files and history render the stale note", () => {
  assert.match(HISTORY, /<ArrSnapshotNote at=\{snap\.staleAt\} refreshing=\{loading\} \/>/);
  // The delete names the same route and title as the read.
  assert.match(FILES, /runTitleFileDelete\(withBasePath\(readPath\), \[\.\.\.selected\], t\("adminArr\.files\.deleteFailed"\), \{ signal \}\)/);
});
