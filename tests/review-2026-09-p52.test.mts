import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";

// Review 2026-09 / f65: `ActivityFilterBar` used to follow every `router.push`
// with a `router.refresh()`. The activity + stats pages are `force-dynamic`
// and read searchParams, and Next's router-cache `staleTimes.dynamic` defaults
// to 0 (no `staleTimes` override in next.config.ts), so the push alone already
// fetches a fresh RSC render — the refresh re-rendered the heaviest admin page
// a second time per filter/tab click and refetched the shared layouts on top.
// This pin fails if the pair is reintroduced.
const FILE = path.resolve(process.cwd(), "src/components/admin/activity-filter-bar.tsx");

function stripComments(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:"'`])\/\/.*$/gm, "$1");
}

test("activity-filter-bar never follows router.push with router.refresh (f65)", () => {
  const src = stripComments(readFileSync(FILE, "utf8"));
  assert.doesNotMatch(src, /router\.refresh\s*\(/, "router.refresh() reintroduced — the push already re-renders a dynamic page");
  // Sanity: the navigation itself is still there (the pin must not pass by the file going empty).
  assert.ok((src.match(/router\.push\s*\(/g) ?? []).length >= 3, "expected the three router.push call sites to remain");
});

test("next.config.ts does not override staleTimes (the premise of the f65 pin)", () => {
  const cfg = stripComments(readFileSync(path.resolve(process.cwd(), "next.config.ts"), "utf8"));
  assert.doesNotMatch(cfg, /staleTimes/, "staleTimes configured — re-evaluate whether the filter bar needs an explicit refresh");
});
