// The Library cleanup page's client rules (src/components/admin/library-cleanup-report.ts)
// and the wiring the page can't be mounted to test (library-cleanup.tsx, -parts.tsx).
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const { CleanupReportSchema, parseRuleNumber, ruleNumberText, selectedOutsideView } = await import("../src/components/admin/library-cleanup-report.ts");
const { check } = await import("../src/lib/validate.ts");
const { cleanupNumberInBounds } = await import("../src/lib/library-cleanup.ts");

const read = (p: string) => readFileSync(new URL(`../${p}`, import.meta.url), "utf8");

const settings = {
  unwatchedEnabled: true, unwatchedDays: 365, neverWatchedEnabled: false, neverWatchedDays: 90,
  votesEnabled: false, votesMin: 3, minAgeDays: 30, recentRequestDays: 14, excludeAiring: true, requireUpstreamCheck: false,
};
const row = {
  tmdbId: 1, mediaType: "MOVIE", title: "A", posterPath: null, year: "2001", servers: ["plex"], addedAt: null, lastPlayedAt: null,
  playCount: 0, votes: 0, idleDays: 400, arr: [{ service: "radarr", instance: "", sizeOnDisk: 10 }], sizeOnDisk: 10,
  matched: ["unwatched"], excludedBy: [], candidate: true,
};
const report = {
  settings, playHistoryTracked: true, historyStart: null, rows: [row], libraryTitles: 1, arrErrors: [],
  protected: [], protectedTotal: 0, totals: { candidates: 1, held: 0, reclaimableBytes: 10 },
};

test("the report is checked before the page reads it: its shape passes, another shape fails", () => {
  const ok = check(CleanupReportSchema, report);
  assert.equal(ok.ok, true);
  assert.equal(check(CleanupReportSchema, { error: "Unauthorized" }).ok, false, "an error body with a 200");
  assert.equal(check(CleanupReportSchema, { ...report, rows: "nope" }).ok, false);
  assert.equal(check(CleanupReportSchema, { ...report, rows: [{ ...row, matched: ["deleteEverything"] }] }).ok, false, "a rule the page doesn't know");
  const older = check(CleanupReportSchema, { ...report, protectedTotal: undefined });
  assert.equal(older.ok, true, "an older server sends no protectedTotal");
});

test("a cleared rule number stays empty and invalid while it is retyped — never a silent 0", () => {
  assert.ok(Number.isNaN(parseRuleNumber("")));
  assert.ok(Number.isNaN(parseRuleNumber("  ")));
  assert.equal(ruleNumberText(parseRuleNumber("")), "", "the field shows nothing, not 0");
  assert.equal(cleanupNumberInBounds("minAgeDays", parseRuleNumber("")), false, "even where 0 is allowed, a cleared field can't be saved");
  assert.equal(parseRuleNumber("30"), 30);
  assert.equal(parseRuleNumber("12.7"), 12);
  assert.equal(ruleNumberText(30), 30);
  const parts = read("src/components/admin/library-cleanup-parts.tsx");
  assert.match(parts, /value=\{ruleNumberText\(draft\[field\]\)\}/);
  assert.match(read("src/components/admin/library-cleanup.tsx"), /\[field\]: parseRuleNumber\(v\)/);
  assert.doesNotMatch(read("src/components/admin/library-cleanup.tsx"), /v === "" \? 0/);
});

test("the delete button says how many selected titles the filters hide", () => {
  assert.equal(selectedOutsideView(new Set(["MOVIE:1", "TV:2", "MOVIE:3"]), new Set(["MOVIE:1"])), 2);
  assert.equal(selectedOutsideView(new Set(["MOVIE:1"]), new Set(["MOVIE:1", "TV:2"])), 0);
  const page = read("src/components/admin/library-cleanup.tsx");
  assert.match(page, /const hiddenSelected = useMemo\(\(\) => selectedOutsideView\(selected, new Set\(visible\.map\(keyOf\)\)\), \[selected, visible\]\);/);
  const parts = read("src/components/admin/library-cleanup-parts.tsx");
  assert.match(parts, /\{hiddenSelected > 0 && \(\s*<span role="status"[^>]*>\s*\{t\("adminManage\.cleanup\.selectedHidden", \{ count: hiddenSelected \}\)\}/);
});

test("the URL follows the view after a pause, and a refused replaceState never reaches the error boundary", () => {
  const page = read("src/components/admin/library-cleanup.tsx");
  const start = page.indexOf("function useViewInUrl(");
  assert.ok(start > 0);
  const hook = page.slice(start, page.indexOf("\n}\n", start));
  assert.match(hook, /const timer = setTimeout\(\(\) => \{/);
  assert.match(hook, /try \{\s*window\.history\.replaceState\(/);
  assert.match(hook, /return \(\) => clearTimeout\(timer\);/, "a newer change cancels the pending write");
  assert.equal(page.match(/window\.history\.replaceState\(/g)?.length, 1, "no other, unguarded write");
  assert.match(page, /useViewInUrl\(vs\);/);
});

test("the table follows a deferred copy of the view, and the derived lists are memoized", () => {
  const page = read("src/components/admin/library-cleanup.tsx");
  assert.match(page, /const viewForRows = useDeferredValue\(vs\);/);
  assert.match(page, /filterCleanupRows\(report\.rows, viewForRows\), viewForRows\.sort, viewForRows\.dir\)/);
  assert.match(page, /\[report, viewForRows\],/);
  assert.match(page, /const selectedRows = useMemo\(/);
});
