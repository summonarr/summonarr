// Audit fix R2-nw#2: the never-watched report and the /admin/stats storage
// figure are READ paths — they resolve the delete route's targets with TMDB's
// tmdb→tvdb cross-reference from the CACHE only ("cached", CrossRefMode in
// library-cleanup-arr.ts), never a live TMDB call per unwatched show inside a
// GET or a page render. Only the delete route's re-judgement passes "fetch".
// Structural: the mode is a literal argument at each read call site.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const src = (p: string) => readFileSync(new URL(`../${p}`, import.meta.url), "utf8");
const calls = (text: string, fn: string) => {
  const out: string[] = [];
  for (let i = text.indexOf(`${fn}(`); i >= 0; i = text.indexOf(`${fn}(`, i + 1)) {
    // Skip the definition/import and a bare mention.
    const before = text.slice(Math.max(0, i - 20), i);
    if (/function\s+$|import\s*\{[^}]*$/.test(before)) continue;
    out.push(text.slice(i, text.indexOf(";", i)));
  }
  return out;
};

test("the never-watched report resolves targets and airing from the cache only (R2-nw#2)", () => {
  const text = src("src/lib/never-watched-report.ts");
  const load = calls(text, "loadCleanupTitles");
  assert.equal(load.length, 1, load.join("\n"));
  assert.match(load[0], /resolveTargets: needsTargets/);
  assert.match(load[0], /crossRef: "cached"/, load[0]);
  const airing = calls(text, "fillAiring");
  assert.equal(airing.length, 1, airing.join("\n"));
  assert.match(airing[0], /"cached"/, airing[0]);
  assert.doesNotMatch(text, /"fetch"/, "no read path here may wait on TMDB");
});

test("the /admin/stats storage figure resolves targets from the cache only (R2-nw#2)", () => {
  const text = src("src/lib/admin-stats-data.ts");
  const report = calls(text, "computeCleanupReport");
  assert.equal(report.length, 1, report.join("\n"));
  assert.match(report[0], /resolveTargets: true/);
  assert.match(report[0], /crossRef: "cached"/, report[0]);
  assert.doesNotMatch(text, /crossRef: "fetch"/);
});
