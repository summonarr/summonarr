// Structural pin: every page under /admin/activity enforces the Activity feature
// flag itself.
//
// Why: `feature.admin.activity` ("Show the /admin/activity page and nav link")
// was enforced on the overview, history and stats tabs only. The users, recently
// added, per-user, per-title and per-play pages never called requireFeature, so
// switching Activity off hid the nav link while every one of them stayed
// reachable by URL. nav-items.test.mts pins the TOP-LEVEL page of each gated nav
// href and cannot see sub-pages — and adding a sub-page is exactly how this
// shipped. So this walks the whole subtree instead of listing files.
//
// No DB, no network, no module graph — the same source-reading idiom as
// tests/app-page-auth-guard.test.mts.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join, relative, resolve } from "node:path";

const HERE = dirname(fileURLToPath(import.meta.url));
const ACTIVITY_DIR = resolve(HERE, "../src/app/(app)/admin/activity");
const GUARD = 'await requireFeature("feature.admin.activity");';

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) walk(full, out);
    else if (entry.name === "page.tsx") out.push(full);
  }
  return out;
}

const pages = walk(ACTIVITY_DIR);
const rel = (f: string) => relative(ACTIVITY_DIR, f);

// A commented-out guard must not count. Line comments are stripped only when the
// `//` starts a line or follows whitespace, so a URL inside a string survives.
function stripComments(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|\s)\/\/.*$/gm, "$1");
}

test("the walk finds every known activity page — a broken walk must not pass vacuously", () => {
  const found = new Set(pages.map(rel));
  for (const known of [
    "page.tsx",
    "history/page.tsx",
    "stats/page.tsx",
    "users/page.tsx",
    "recent/page.tsx",
    "user/[id]/page.tsx",
    "media/[tmdbId]/page.tsx",
    "play/[id]/page.tsx",
  ]) {
    assert.ok(found.has(known), `expected ${known} under admin/activity — the walk missed it`);
  }
});

test("every activity page calls requireFeature(\"feature.admin.activity\")", () => {
  for (const file of pages) {
    const code = stripComments(readFileSync(file, "utf8"));
    assert.ok(
      code.includes(GUARD),
      `admin/activity/${rel(file)} never enforces feature.admin.activity — switching Activity off leaves it reachable by URL`,
    );
  }
});

test("the gate is the page component's first await — nothing runs for a disabled page, not even the session read", () => {
  for (const file of pages) {
    const code = stripComments(readFileSync(file, "utf8"));
    const start = code.indexOf("export default async function");
    assert.notEqual(start, -1, `admin/activity/${rel(file)} has no async default-exported page component`);
    const firstAwait = code.slice(start).match(/\bawait\s[^;]*;/);
    assert.equal(
      firstAwait?.[0],
      GUARD,
      `admin/activity/${rel(file)}: the first await in the page is not the feature gate`,
    );
  }
});
