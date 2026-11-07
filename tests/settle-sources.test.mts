// settleSources (src/lib/settle-sources.ts): the home rails' fan-out. A source
// that rejects degrades to [] and is logged under its OWN name. The web home
// page used to drop every rejection silently (an outage showed empty rails and
// left no server-side trace), and the JSON route matched names to results by
// position, so a reorder of either list mislabelled the log line.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { settleSources } from "../src/lib/settle-sources.ts";

function captureErrors(): { lines: string[]; restore: () => void } {
  const lines: string[] = [];
  const original = console.error;
  console.error = (...args: unknown[]) => { lines.push(args.map(String).join(" ")); };
  return { lines, restore: () => { console.error = original; } };
}

test("a rejected source degrades to [] and is logged under its own name; the rest keep their values", async () => {
  const log = captureErrors();
  try {
    const out = await settleSources("home", {
      trending: Promise.resolve([1, 2]),
      "popular-tv": Promise.reject(new Error("TMDB 401")),
      "for-you": Promise.resolve([3]),
      "recently-added": Promise.reject("pool timeout"),
    });
    assert.deepEqual(out, { trending: [1, 2], "popular-tv": [], "for-you": [3], "recently-added": [] });
    assert.deepEqual(log.lines, [
      "[home] source popular-tv failed: TMDB 401",
      "[home] source recently-added failed: pool timeout",
    ]);
  } finally {
    log.restore();
  }
});

test("all sources fulfilled: nothing is logged (guardrail 7)", async () => {
  const log = captureErrors();
  try {
    const out = await settleSources("home", { a: Promise.resolve(["x"]), b: Promise.resolve([]) });
    assert.deepEqual(out, { a: ["x"], b: [] });
    assert.deepEqual(log.lines, []);
  } finally {
    log.restore();
  }
});

test("the web home page and GET /api/home both fan out through settleSources", () => {
  for (const p of ["src/app/(app)/page.tsx", "src/app/api/home/route.ts"]) {
    const src = readFileSync(new URL(`../${p}`, import.meta.url), "utf8");
    assert.match(src, /settleSources\("home", \{/, `${p} must log each rejected rail source`);
    assert.doesNotMatch(src, /Promise\.allSettled\(/, `${p} must not settle the rails positionally again`);
  }
});
