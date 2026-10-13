// "Instant, then live" on Admin → Calendar (src/components/admin/arr-calendar.tsx):
// opening a window paints the snapshot the server kept for exactly that
// window's read, then the live read replaces it. The page is a .tsx the unit
// loader can't import, so its wiring is pinned structurally.
//
// What matters:
// - the snapshot URL IS the live URL (one builder): the server keys a snapshot
//   on path + query, so a different spelling would paint another window's
//   report — or never find one;
// - a snapshot is stored as a report FOR the window, so the page's
//   "drawn only for the window it was read for" rule covers it too;
// - markLive() runs only for an ACCEPTED live answer (after the sequence check
//   and after the follow-today redirect), and through the current url's
//   callback (load lists it in its deps);
// - applying a snapshot touches nothing but the report: not errors, not
//   searches, not "today";
// - the stale note is rendered.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const SRC = readFileSync(new URL("../src/components/admin/arr-calendar.tsx", import.meta.url), "utf8");

/** The source of `const <name> = useCallback(` … through its deps line. */
function callbackBody(name: string): string {
  const startAt = SRC.indexOf(`const ${name} = useCallback(`);
  assert.ok(startAt >= 0, `${name} is a useCallback`);
  const end = SRC.indexOf("\n  }, [", startAt);
  assert.ok(end > startAt, `${name} has a deps line`);
  return SRC.slice(startAt, SRC.indexOf("\n", end + 1));
}

test("one builder for the calendar read: the live fetch and the snapshot read use it", () => {
  // The endpoint is spelled once in code (a string or template literal), inside the builder.
  assert.equal([...SRC.matchAll(/[`"']\/api\/admin\/arr\/calendar/g)].length, 1);
  assert.match(
    SRC,
    /function calendarReadUrl\(from: number, withUnmonitored: boolean\): string \{\s*const q = new URLSearchParams\(\{ start: new Date\(from\)\.toISOString\(\), end: new Date\(addDays\(from, CALENDAR_DAYS\)\)\.toISOString\(\) \}\);\s*if \(withUnmonitored\) q\.set\("unmonitored", "1"\);\s*return withBasePath\(`\/api\/admin\/arr\/calendar\?\$\{q\.toString\(\)\}`\);\s*\}/,
  );
  // Live: the load's own window.
  assert.match(callbackBody("load"), /await fetch\(calendarReadUrl\(from, withUnmonitored\)\);/);
  assert.equal([...SRC.matchAll(/\bfetch\(calendarReadUrl\(/g)].length, 1);
  // Snapshot: the current window — the same (start, unmonitored) the load effect passes — or null with nothing to read.
  assert.match(
    SRC,
    /const readUrl = useMemo\(\s*\(\) => \(start !== null && instances\.length > 0 \? calendarReadUrl\(start, unmonitored\) : null\),\s*\[start, unmonitored, instances\.length\],\s*\);/,
  );
  assert.match(SRC, /if \(start !== null && instances\.length > 0\) void load\(start, unmonitored\);/);
  assert.match(SRC, /const snap = useArrSnapshot<Report>\(readUrl, applySnapshot\);/);
  // Hooks run before the "nothing configured" early return.
  assert.ok(SRC.indexOf("useArrSnapshot<Report>(") < SRC.indexOf("if (instances.length === 0) {"));
});

test("a snapshot is stored as the current window's report, and nothing else changes", () => {
  const apply = callbackBody("applySnapshot");
  assert.match(apply, /if \(start === null\) return false;\s*setLoaded\(\{ start, unmonitored, report: data \}\);\s*\}, \[start, unmonitored\]\);/);
  for (const forbidden of ["setError", "setSearches", "setClock", "setLoading", "setStart", "markLive"]) {
    assert.ok(!apply.includes(forbidden), `applySnapshot must not call ${forbidden}`);
  }
  // Still the one window rule for drawing a report, live or snapshot.
  assert.match(SRC, /const report = loaded !== null && start !== null && loaded\.start === start && loaded\.unmonitored === unmonitored \? loaded\.report : null;/);
});

test("markLive runs only for an accepted live answer, through the current url's callback", () => {
  const load = callbackBody("load");
  assert.equal([...load.matchAll(/markLive\(\)/g)].length, 1, "one call");
  assert.equal([...SRC.matchAll(/markLive\(\)/g)].length, 1, "and only in load");
  const sequence = load.indexOf("if (id !== seq.current) return;");
  const failed = load.indexOf("if (!res.ok || !data) {");
  const redirect = load.search(/setStart\(current\);\s*return;/);
  const accepted = load.indexOf("setLoaded({ start: from, unmonitored: withUnmonitored, report: data });");
  const mark = load.indexOf("markLive()");
  assert.ok(sequence > 0 && failed > sequence && redirect > failed && accepted > redirect, "load's order is sequence → failure → redirect → accept");
  assert.ok(mark > accepted, "after the accepted report, never before the sequence check, a failure or the follow-today redirect");
  assert.ok(load.indexOf("} catch {") > mark, "inside the try's accepted branch");
  // load sees the current url's markLive, not the first render's.
  assert.match(load, /\}, \[t, markLive\]\);$/);
  assert.match(SRC, /const \{ markLive \} = snap;/);
});

test("'today' follows the newest LIVE report, never a snapshot's older clock", () => {
  assert.match(SRC, /const nowIso = clock \?\? today;/);
  assert.doesNotMatch(SRC, /loaded\?\.report\.now/);
  assert.equal([...SRC.matchAll(/setClock\(/g)].length, 1);
  assert.match(callbackBody("load"), /setLoaded\(\{ start: from, unmonitored: withUnmonitored, report: data \}\);\s*setClock\(data\.now\);/);
});

test("the stale note is rendered with the page's live-loading flag", () => {
  assert.match(SRC, /import \{ ArrSnapshotNote \} from "@\/components\/admin\/arr-snapshot-note";/);
  assert.match(SRC, /<ArrSnapshotNote at=\{snap\.staleAt\} refreshing=\{loading\} \/>/);
});
