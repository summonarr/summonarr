// "Instant, then live" on Admin → Missing (src/components/admin/missing-report.tsx):
// each (service, mode) list paints the snapshot the server kept for exactly its
// read while it has no live answer, then the live answer replaces it. The page
// is a .tsx the unit loader can't import, so its wiring is pinned structurally.
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

const SRC = readFileSync(new URL("../src/components/admin/missing-report.tsx", import.meta.url), "utf8");

/** The source of `const load = useCallback(` … through its deps line. */
function loadBody(): string {
  const startAt = SRC.indexOf("const load = useCallback(");
  assert.ok(startAt >= 0, "load is a useCallback");
  const end = SRC.indexOf("\n  }, [t, updateSearches]);", startAt);
  assert.ok(end > startAt, "load has its deps line");
  return SRC.slice(startAt, end);
}

function count(re: RegExp): number {
  return [...SRC.matchAll(re)].length;
}

test("one builder for a list's read: the live load and the snapshot read use it, with the same (service, mode)", () => {
  // The listing endpoint is spelled once in code, inside the builder (the episodes and search routes are other paths).
  assert.equal(count(/[`"']\/api\/admin\/missing\?/g), 1);
  assert.match(
    SRC,
    /const missingListUrl = \(svc: Service, m: Mode\) => withBasePath\(`\/api\/admin\/missing\?service=\$\{svc\}&mode=\$\{m\}`\);/,
  );
  // Live.
  assert.match(loadBody(), /const res = await fetch\(missingListUrl\(svc, m\)\);/);
  assert.equal(count(/\bfetch\(missingListUrl\(/g), 1);
  // The view's first load and its snapshot read name the same list.
  assert.match(SRC, /if \(needsLoad\) void load\(service, mode\);/);
  assert.match(
    SRC,
    /const snapshotUrl = configured\[service\] && !liveKeys\.has\(current\) \? missingListUrl\(service, mode\) : null;/,
  );
  assert.match(SRC, /const snap = useArrSnapshot<Reports\[ReportKey\]>\(snapshotUrl, \(data\) => \{/);
  assert.equal(count(/useArrSnapshot</g), 1);
  assert.match(SRC, /const current: ReportKey = `\$\{service\}:\$\{mode\}`;/);
});

test("markLive runs for an accepted live answer of the view on screen, and the list is recorded live before its report is set", () => {
  const body = loadBody();
  const accepted = body.indexOf("const data = await res.json();\n      if (superseded()) return;");
  assert.ok(accepted >= 0, "the accepted branch follows the sequence check");
  const add = body.indexOf("liveRef.current.add(k);");
  const mark = body.indexOf("if (viewRef.current === k) markLiveRef.current();");
  const set = body.indexOf("setReports((r) => ({ ...r, [k]: data }));");
  assert.ok(accepted < add && add < mark && mark < set, "live mark → markLive → report, all after the sequence check");
  assert.match(body.slice(add, set), /liveRef\.current\.add\(k\);\s*setLiveKeys\(new Set\(liveRef\.current\)\);\s*if \(viewRef\.current === k\)/);
  // Nowhere else: not for an error, a network failure or a superseded load.
  assert.equal(count(/markLiveRef\.current\(\)/g), 1);
  assert.equal(count(/liveRef\.current\.add\(/g), 1);
  assert.equal(count(/\.markLive\(\)/g), 0, "markLive is only reached through the ref set from the current render");
  // The ref follows the committed view and its markLive.
  assert.match(SRC, /useEffect\(\(\) => \{\s*viewRef\.current = current;\s*markLiveRef\.current = snap\.markLive;\s*\}\);/);
});

test("the first live answer keeps what was ticked or searched on the snapshot; only a reload of a live list resets the rows", () => {
  const body = loadBody();
  const has = body.indexOf("const replacesLive = liveRef.current.has(k);");
  assert.ok(has >= 0 && has < body.indexOf("liveRef.current.add(k);"), "read before this answer marks the list live");
  const open = body.indexOf("if (replacesLive) {");
  assert.ok(open > 0);
  const close = body.indexOf("\n      }\n", open);
  const block = body.slice(open, close);
  const resets = ["updateSearches(", "setSelected(", "setBulkResult(", "setExpanded(", "setEpisodes("];
  for (const r of resets) {
    assert.ok(block.includes(r), `${r} resets only inside the replacesLive block`);
    assert.equal(body.split(r).length - 1, 1, `${r} appears once in load`);
  }
});

test("a snapshot sets the report alone, and never over a live answer or while the admin has something going on that list", () => {
  assert.match(
    SRC,
    /useArrSnapshot<Reports\[ReportKey\]>\(snapshotUrl, \(data\) => \{\s*if \(!snapshotMayPaint\(current\)\) return false;\s*setReports\(\(r\) => \(\{ \.\.\.r, \[current\]: data \}\)\);\s*\}\);/,
  );
  const start = SRC.indexOf("const snapshotMayPaint = (k: ReportKey) =>");
  assert.ok(start >= 0);
  const guard = SRC.slice(start, SRC.indexOf(";\n", start));
  assert.match(guard, /!liveRef\.current\.has\(k\)/, "never over a live answer");
  assert.match(guard, /!\(bulkAbort\.current !== null && \(bulk === null \|\| bulk\.key === k\)\)/, "never during a bulk run on this list");
  assert.match(guard, /confirming\?\.key !== k/, "never under the bulk confirmation");
  assert.match(guard, /!Object\.entries\(searchesRef\.current\)\.some\(\(\[key, st\]\) => st\.busy && key\.startsWith\(`\$\{k\}\|`\)\)/, "never while a row search is in flight");
  for (const forbidden of ["setErrors", "setSelected", "updateSearches", "setBulk", "setConfirming", "setExpanded", "setEpisodes", "setLoadingKeys"]) {
    assert.ok(!guard.includes(forbidden), `the paint guard must not call ${forbidden}`);
  }
});

test("the stale note sits by the page's status line, refreshing while this list's live load is out", () => {
  assert.equal(count(/<ArrSnapshotNote at=\{snap\.staleAt\} refreshing=\{loadingHere\} \/>/g), 1);
  assert.match(SRC, /const loadingHere = loadingKeys\.has\(current\);/);
});
