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
  titleTargetKey,
  titleTargetOfKey,
} from "../src/components/admin/arr-title/snapshot-rules.ts";

const read = (f: string) => readFileSync(new URL(`../src/components/admin/arr-title/${f}`, import.meta.url), "utf8");
const MANAGER = read("title-manager.tsx");
const SETTINGS = read("settings-tab.tsx");
const SEASONS = read("seasons-tab.tsx");
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

test("titleTargetKey / titleTargetOfKey round-trip both target kinds", () => {
  for (const target of [{ tmdbId: 603 }, { arrId: 12 }] as const) {
    assert.deepEqual(titleTargetOfKey(titleTargetKey(target)), target);
  }
  assert.equal(titleTargetKey({ tmdbId: 7 }), "tmdb:7");
  assert.equal(titleTargetKey({ arrId: 7 }), "arr:7");
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
  assert.ok(!/[`"']\/api\/admin\/arr\/title\?/.test(MANAGER), "no hand-built title URL in the manager");
  assert.match(MANAGER, /const openPath = open \? titleReadPath\(service, instance, titleTargetOfKey\(targetKey\)\) : null;/);
  assert.match(MANAGER, /const snap = useArrSnapshot<TitleState>\(openPath === null \? null : withBasePath\(openPath\), applyTitleSnapshot\);/);
  // The open-time live read: the same target from the same key.
  assert.match(MANAGER, /void load\(titleTargetOfKey\(targetKey\), true\);/);
  assert.match(callbackBody(MANAGER, "load"), /await arrApi<TitleState>\(titleReadPath\(service, instance, by\), undefined, fallback\);/);
  assert.match(MANAGER, /const targetKey = titleTargetKey\(target\);/);
});

test("title: the live answer rebases over a painted snapshot and marks live only once accepted", () => {
  const load = callbackBody(MANAGER, "load");
  const seqCheck = load.indexOf("if (seq !== loadSeq.current) return;");
  const okAt = load.indexOf("if (res.ok) {");
  const elseAt = load.indexOf("} else {", okAt);
  const live = load.indexOf("markTitleLive.current();");
  assert.ok(seqCheck > 0 && okAt > seqCheck && live > okAt && live < elseAt, "markTitleLive() inside the accepted ok branch, after the sequence check");
  assert.equal([...MANAGER.matchAll(/markTitleLive\.current\(\)/g)].length, 1);
  // The ref follows the hook's callback for the url now open.
  assert.match(MANAGER, /const markTitleLive = useRef\(snap\.markLive\);\s*useEffect\(\(\) => \{\s*markTitleLive\.current = snap\.markLive;\s*\}\);/);
  assert.match(load, /const landing = liveTitleLanding\(initial, snapshotPainted\.current\);/);
  assert.match(load, /setState\(\(prev\) => \(prev && landing === "rebase" \? \{ \.\.\.res\.data, title: mergeTitle\(prev\.title, res\.data\.title\) \} : res\.data\)\);/);
  // Only a replace remounts the Settings form.
  assert.match(load, /if \(landing === "replace"\) setVersion\(\(v\) => v \+ 1\);/);
  assert.equal([...MANAGER.matchAll(/setVersion\(/g)].length, 1);
  assert.match(load, /\}, \[service, instance, tRef\]\);/);
  // Every open starts with nothing painted, before its live read.
  const reset = MANAGER.indexOf("snapshotPainted.current = false;");
  assert.ok(reset > 0 && reset < MANAGER.indexOf("void load(titleTargetOfKey(targetKey), true);"));
});

test("title: a snapshot only fills an empty dialog and touches nothing else", () => {
  const apply = callbackBody(MANAGER, "applyTitleSnapshot");
  assert.match(apply, /setState\(\(prev\) => \(snapshotMayPaint\(prev !== null, false\) \? data : prev\)\);/);
  assert.match(apply, /snapshotPainted\.current = true;/);
  for (const forbidden of ["setVersion", "setLoadError", "setError", "setNotice", "setTab", "setVisited", "setSettingsDirty", "setSettingsSaving", "setConfirmDiscard", "setWatchKey", "stopWatches", "markTitleLive", "setBusy"]) {
    assert.ok(!apply.includes(forbidden), `applyTitleSnapshot must not call ${forbidden}`);
  }
  assert.match(apply, /\}, \[\]\);$/);
});

test("title: Settings keeps edits across the rebase and Save waits for the live read", () => {
  assert.match(MANAGER, /<SettingsTab\s+key=\{version\}/);
  assert.match(MANAGER, /baseIsSnapshot=\{snap\.staleAt !== null\}/);
  assert.match(SETTINGS, /<Button size="sm" onClick=\{\(\) => void save\(\)\} disabled=\{!dirty \|\| saving \|\| confirmMove \|\| baseIsSnapshot\}>/);
  assert.match(SETTINGS, /baseIsSnapshot = false,/);
});

test("title: the stale note sits under the action row, refreshing until the live read answers or fails", () => {
  assert.match(MANAGER, /<ArrSnapshotNote at=\{snap\.staleAt\} refreshing=\{loadError === ""\} \/>/);
  // Under the action row, above the status line.
  const note = MANAGER.indexOf("<ArrSnapshotNote");
  assert.ok(note > MANAGER.indexOf("<OpenInArrLink") && note < MANAGER.indexOf("{error || loadError ? ("));
});

// ---------------------------------------------------------------- episodes

test("episodes: one URL per season read, a snapshot only on an empty list, gated per read", () => {
  const load = callbackBody(SEASONS, "loadEpisodes");
  assert.match(load, /const path = `\/api\/admin\/arr\/title\/episodes\?\$\{titleQuery\(titleRef, \{ season: n \}\)\}`;/);
  assert.match(load, /readArrSnapshot<EpisodesAnswer>\(withBasePath\(path\)\)/);
  assert.match(load, /await arrApi<EpisodesAnswer>\(path, undefined, /);
  assert.equal([...SEASONS.matchAll(/\/api\/admin\/arr\/title\/episodes\?/g)].length, 1, "the read URL is built once");
  // Only a season shown for the first time asks for its snapshot.
  const firstOnly = load.indexOf("if (!listsRef.current[n]?.episodes.length) {");
  assert.ok(firstOnly > 0 && firstOnly < load.indexOf("readArrSnapshot<"), "the snapshot read sits behind the empty-list check");
  assert.match(
    load,
    /episodeSnapshotMayPaint\(\{\s*seq,\s*newest: listSeq\.current\[n\],\s*answered: doneSeq\.current\[n\],\s*failed: \(cur\?\.error \?\? ""\) !== "",\s*shown: cur\?\.episodes\.length \?\? 0,\s*writing: busyRef\.current !== null,\s*\}\);\s*if \(!paint\) return l;/,
  );
  // A live answer clears the mark; a failed one keeps the snapshot marked.
  assert.match(load, /episodes: res\.data\.episodes, loadedAt: Date\.parse\(res\.data\.now\) \|\| 0, staleAt: null \}/);
  assert.match(load, /error: res\.error, episodes: l\[n\]\?\.episodes \?\? \[\], loadedAt: l\[n\]\?\.loadedAt \?\? 0, staleAt: l\[n\]\?\.staleAt \?\? null \}/);
  // The snapshot only ever sets the list; never busy or the tab's error.
  const paintAt = load.indexOf("readArrSnapshot<");
  const snapBlock = load.slice(paintAt, load.indexOf("const res = await arrApi"));
  for (const forbidden of ["setBusy", "setError", "setExpanded", "onTitle", "markSeen"]) {
    assert.ok(!snapBlock.includes(forbidden), `the episode snapshot must not call ${forbidden}`);
  }
  assert.match(SEASONS, /<ArrSnapshotNote at=\{list\?\.staleAt \?\? null\} refreshing=\{list\?\.loading \?\? false\} \/>/);
  // The refs the late snapshot reads follow every render.
  assert.match(SEASONS, /useEffect\(\(\) => \{\s*listsRef\.current = lists;\s*busyRef\.current = busy;\s*\}\);/);
});

// ---------------------------------------------------------------- files + history

for (const [name, src, setter, field, writing] of [
  ["files", FILES, "setFiles", "files", "busyRef.current !== null"],
  ["history", HISTORY, "setEvents", "events", "false"],
] as const) {
  test(`${name}: one URL for the live read and its snapshot, markLive only on an accepted answer`, () => {
    assert.match(src, new RegExp(`const readPath = useMemo\\(\\(\\) => \`/api/admin/arr/title/${name}\\?\\$\\{titleQuery\\(titleRef\\)\\}\`, \\[titleRef\\]\\);`));
    assert.match(src, new RegExp(`const snap = useArrSnapshot<\\{ ${field}: [A-Za-z]+\\[\\] \\}>\\(withBasePath\\(readPath\\), applySnapshot\\);`));
    const load = callbackBody(src, "load");
    assert.match(load, /await arrApi<[^>]+>\(readPath, undefined, /);
    const okAt = load.indexOf("if (res.ok) {");
    const live = load.indexOf("markLive();");
    assert.ok(okAt > 0 && live > okAt && live < load.indexOf("} else {", okAt), "markLive() inside the ok branch");
    assert.match(load, /\}, \[readPath, tRef, markLive\]\);/);
  });

  test(`${name}: a snapshot only fills an empty list, and touches nothing else`, () => {
    const apply = callbackBody(src, "applySnapshot");
    assert.match(apply, new RegExp(`${setter}\\(\\(prev\\) => \\(snapshotMayPaint\\(prev !== null, ${writing.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\) \\? data\\.${field} : prev\\)\\);`));
    for (const forbidden of ["setError", "setSelected", "setConfirmDelete", "setRenames", "setRenameSelected", "setNotice", "setBusy", "setLoadFailed", "setLoading", "markLive", "watch("]) {
      assert.ok(!apply.includes(forbidden), `${name} applySnapshot must not call ${forbidden}`);
    }
    assert.match(apply, /\}, \[\]\);$/);
  });
}

test("files and history render the stale note", () => {
  assert.match(FILES, /<ArrSnapshotNote at=\{snap\.staleAt\} refreshing=\{reads > 0\} \/>/);
  assert.match(callbackBody(FILES, "load"), /readsOut\.current\+\+;\s*setReads\(readsOut\.current\);[\s\S]*readsOut\.current--;\s*setReads\(readsOut\.current\);/);
  assert.match(HISTORY, /<ArrSnapshotNote at=\{snap\.staleAt\} refreshing=\{loading\} \/>/);
  // The delete path is untouched: it still names the files route itself.
  assert.match(FILES, /const res = await runDelete\(`\/api\/admin\/arr\/title\/files\?\$\{titleQuery\(titleRef\)\}`, \[\.\.\.selected\]/);
});
