// "Instant, then live" on Admin → Missing: each (service, mode) list paints the
// snapshot the server kept for exactly its read while it has no live answer,
// then the live answer replaces it. The reads and the snapshot live in
// src/components/admin/use-missing-reports.ts, the rows' searches and the bulk
// run in use-bulk-search.ts, the view in missing-report.tsx. The unit loader
// can't import them (client hooks, .tsx), so the wiring is pinned structurally.
//
// What matters:
// - the snapshot URL IS the live URL (one builder): the server keys a snapshot
//   on path + query, so another spelling paints another list — or never finds one;
// - once a list holds a live answer its snapshot url is null: a Refresh is live,
//   never a snapshot;
// - markLive() runs only for an ACCEPTED live answer (after the sequence check),
//   and only when that answer is for the view on screen;
// - painting a snapshot sets the report alone, and never over a live answer,
//   during a bulk run on that list, its confirmation, or a row search in flight;
// - the first live answer replaces at most a snapshot and keeps what the admin
//   ticked or searched on it; only a reload of a LIVE list resets the rows;
// - the stale note is rendered.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const read = (p: string) => readFileSync(new URL(`../src/components/admin/${p}`, import.meta.url), "utf8");
const HOOK = read("use-missing-reports.ts");
const BULK = read("use-bulk-search.ts");
// The view: missing-report.tsx and the pieces around its list.
const PAGE = read("missing-report.tsx") + read("missing-report-parts.tsx");

/** The source of `const load = useCallback(` … through its deps line. */
function loadBody(): string {
  const startAt = HOOK.indexOf("const load = useCallback(");
  assert.ok(startAt >= 0, "load is a useCallback");
  const end = HOOK.indexOf("\n  }, [t, onLiveReplaced]);", startAt);
  assert.ok(end > startAt, "load has its deps line");
  return HOOK.slice(startAt, end);
}

/** The body of `const name = useCallback(` through its deps line. */
function callbackBody(src: string, head: string, deps: string): string {
  const startAt = src.indexOf(head);
  assert.ok(startAt >= 0, `${head} exists`);
  const end = src.indexOf(`\n  }, ${deps});`, startAt);
  assert.ok(end > startAt, `${head} has the deps ${deps}`);
  return src.slice(startAt, end);
}

function count(src: string, re: RegExp): number {
  return [...src.matchAll(re)].length;
}

/** The source without its comments — for counting calls, not mentions. */
function code(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
}

test("one builder for a list's read: the live load and the snapshot read use it, with the same (service, mode)", () => {
  // The listing endpoint is spelled once in code, inside the builder (the episodes and search routes are other paths).
  assert.equal(count(HOOK + PAGE + BULK, /[`"']\/api\/admin\/missing\?/g), 1);
  assert.match(
    HOOK,
    /const missingListUrl = \(svc: Service, m: Mode\) => withBasePath\(`\/api\/admin\/missing\?service=\$\{svc\}&mode=\$\{m\}`\);/,
  );
  assert.doesNotMatch(PAGE + BULK, /missingListUrl|useArrSnapshot/, "the reads and the snapshot are the hook's alone");
  // Live.
  assert.match(loadBody(), /const res = await fetchJson\(missingListUrl\(svc, m\), \{/);
  assert.equal(count(HOOK, /\bfetchJson\(missingListUrl\(/g), 1);
  // The view's first load and its snapshot read name the same list.
  assert.match(HOOK, /if \(needsLoad\) void load\(service, mode\);/);
  assert.match(
    HOOK,
    /const snapshotUrl = configured\[service\] && !liveKeys\.has\(current\) \? missingListUrl\(service, mode\) : null;/,
  );
  assert.match(HOOK, /const snap = useArrSnapshot<unknown>\(snapshotUrl, \(data\) => \{/);
  assert.equal(count(HOOK, /useArrSnapshot</g), 1);
  assert.match(HOOK, /const current: ReportKey = `\$\{service\}:\$\{mode\}`;/);
  // The page shows the view the hook reads: it hands in its own tab and mode
  // and takes `current` back rather than spelling it again.
  assert.match(
    PAGE,
    /const \{ current, reports, errors, loadingKeys, loadingHere, load, staleAt \} = useMissingReports\(\{\s*service,\s*mode,\s*configured,\s*listIdle,\s*onLiveReplaced: resetRows,\s*\}\);/,
  );
  assert.doesNotMatch(PAGE, /const current\b/);
});

test("markLive runs for an accepted live answer of the view on screen, and the list is recorded live before its report is set", () => {
  const body = loadBody();
  const accepted = body.indexOf("const data = asListReport(res.data);");
  assert.ok(accepted >= 0 && body.indexOf("if (superseded()) return;") < accepted, "the accepted branch follows the sequence check");
  assert.ok(body.indexOf("if (!res.ok) {") < accepted, "and the failure's return: only a checked report is accepted");
  const add = body.indexOf("liveRef.current.add(k);");
  const mark = body.indexOf("if (viewRef.current === k) markLiveRef.current();");
  const set = body.indexOf("setReports((r) => ({ ...r, [k]: data }));");
  assert.ok(accepted < add && add < mark && mark < set, "live mark → markLive → report, all after the sequence check");
  assert.match(body.slice(add, set), /liveRef\.current\.add\(k\);\s*setLiveKeys\(new Set\(liveRef\.current\)\);\s*if \(viewRef\.current === k\)/);
  // Nowhere else: not for an error, a network failure or a superseded load.
  assert.equal(count(HOOK, /markLiveRef\.current\(\)/g), 1);
  assert.equal(count(HOOK, /liveRef\.current\.add\(/g), 1);
  assert.equal(count(HOOK + PAGE + BULK, /\.markLive\(\)/g), 0, "markLive is only reached through the ref set from the current render");
  assert.doesNotMatch(PAGE + BULK, /liveRef|markLiveRef|setReports|setLoadingKeys/, "nothing outside the hook writes a list's read state");
  // The ref follows the committed view and its markLive.
  assert.match(HOOK, /useEffect\(\(\) => \{\s*viewRef\.current = current;\s*markLiveRef\.current = snap\.markLive;\s*\}\);/);
});

test("the first live answer keeps what was ticked or searched on the snapshot; only a reload of a live list resets the rows", () => {
  const body = loadBody();
  const has = body.indexOf("const replacesLive = liveRef.current.has(k);");
  assert.ok(has >= 0 && has < body.indexOf("liveRef.current.add(k);"), "read before this answer marks the list live");
  // The reset is reached from one place: a live answer replacing a live one.
  assert.match(body, /if \(replacesLive\) onLiveReplaced\(k\);/);
  assert.equal(count(code(HOOK), /onLiveReplaced\(/g), 1, "the hook calls onLiveReplaced only there");
  // The page's reset is its rows' (resetList) plus its expanded episode lists.
  const rows = callbackBody(PAGE, "const resetRows = useCallback((k: ReportKey) => {", "[resetList, episodeLoads]");
  for (const r of ["resetList(k);", "setExpanded(", "setEpisodes(", "episodeLoads.abort();"]) assert.ok(rows.includes(r), `${r} resets in resetRows`);
  assert.equal(count(code(PAGE), /\bresetRows\b/g), 2, "resetRows is defined and handed to the hook as onLiveReplaced — called nowhere else");
  assert.equal(count(code(PAGE), /\bresetList\(/g), 1, "resetList runs only inside resetRows");
  assert.equal(count(PAGE, /setExpanded\(\(prev\) => new Set\(\[\.\.\.prev\]\.filter/g), 1, "the expanded rows reset only there");
  assert.equal(count(PAGE, /setEpisodes\(\(s\) => Object\.fromEntries/g), 1, "the episode lists reset only there");
  // The bulk side: the row's searches, its ticks and its last run's result.
  const list = callbackBody(BULK, "const resetList = useCallback((k: ReportKey) => {", "[updateSearches]");
  for (const r of ["updateSearches(", "setSelected(", "setBulkResult("]) assert.ok(list.includes(r), `${r} resets in resetList`);
  assert.equal(count(code(BULK), /\bresetList\(/g), 0, "the bulk hook never calls its reset itself");
  assert.equal(count(BULK, /setBulkResult\(\(r\) => \(r\?\.key === k \? null : r\)\)/g), 1, "the last run's result clears only there");
});

test("the reset load depends on is stable, so the view's first load runs once", () => {
  // load's identity feeds the needsLoad effect: a reset made anew each render
  // would re-run it on every render.
  assert.match(HOOK, /useEffect\(\(\) => \{\s*if \(needsLoad\) void load\(service, mode\);\s*\}, \[needsLoad, service, mode, load\]\);/);
  callbackBody(PAGE, "const resetRows = useCallback(", "[resetList, episodeLoads]");
  callbackBody(BULK, "const resetList = useCallback(", "[updateSearches]");
  callbackBody(BULK, "const updateSearches = useCallback(", "[]");
});

test("a snapshot sets the report alone, and never over a live answer or while the admin has something going on that list", () => {
  assert.match(
    HOOK,
    /useArrSnapshot<unknown>\(snapshotUrl, \(data\) => \{\s*if \(!snapshotMayPaint\(current\)\) return false;\s*(?:\/\/[^\n]*\n\s*)*const checked = check\(MISSING_REPORT, data\);\s*if \(!checked\.ok\) return false;\s*setReports\(\(r\) => \(\{ \.\.\.r, \[current\]: asListReport\(checked\.value\) \}\)\);\s*\}\);/,
    "a kept answer is checked like a live one, and one the page can't read is not painted",
  );
  const start = HOOK.indexOf("const snapshotMayPaint = (k: ReportKey) =>");
  assert.ok(start >= 0);
  const guard = HOOK.slice(start, HOOK.indexOf(";\n", start));
  assert.match(guard, /!liveRef\.current\.has\(k\) && listIdle\(k\)$/, "never over a live answer, nor while the list is busy");
  // The page hands the bulk hook's own idle rule straight in.
  assert.match(PAGE, /const \{[^}]*\blistIdle\b[^}]*\} = run;/);
  const idleAt = BULK.indexOf("const listIdle = (k: ReportKey) =>");
  assert.ok(idleAt >= 0);
  const idle = BULK.slice(idleAt, BULK.indexOf(";\n", idleAt));
  assert.match(idle, /!\(bulkAbort\.current !== null && \(bulk === null \|\| bulk\.key === k\)\)/, "never during a bulk run on this list");
  assert.match(idle, /confirming\?\.key !== k/, "never under the bulk confirmation");
  assert.match(idle, /!Object\.entries\(searchesRef\.current\)\.some\(\(\[key, st\]\) => st\.busy && key\.startsWith\(`\$\{k\}\|`\)\)/, "never while a row search is in flight");
  for (const part of [guard, idle]) {
    for (const forbidden of ["setErrors", "setSelected", "updateSearches", "setBulk", "setConfirming", "setExpanded", "setEpisodes", "setLoadingKeys", "onLiveReplaced", "resetList"]) {
      assert.ok(!part.includes(forbidden), `the paint guard must not call ${forbidden}`);
    }
  }
});

test("the stale note sits by the page's status line, refreshing while this list's live load is out", () => {
  assert.equal(count(PAGE, /<ArrSnapshotNote at=\{staleAt\} refreshing=\{loadingHere\} \/>/g), 1);
  assert.match(HOOK, /return \{ current, reports, errors, loadingKeys, loadingHere, load, staleAt: snap\.staleAt \};/);
  assert.match(HOOK, /const loadingHere = loadingKeys\.has\(current\);/);
});
