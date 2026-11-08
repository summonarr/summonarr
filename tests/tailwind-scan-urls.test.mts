// Tailwind v4 finds its classes by scanning every project file it can see —
// comments, tests and scripts included — and emits CSS for any token that
// parses as a class. An arbitrary url background written with a placeholder
// (a comment showing the shape with an ellipsis) became a real background-image
// rule pointing at that ellipsis, which the CSS bundler then tried to resolve as
// a module: `next build` failed with "Can't resolve". Only an absolute
// path, a full URL, a data URL or a var() resolves; anything else must not be
// spelled out as a class anywhere Tailwind scans.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

const ROOT = process.cwd();
const SCANNED_DIRS = ["src", "scripts", "tests", "docs"];
const SKIP_DIRS = new Set(["node_modules", ".next", ".git", "generated"]);
const TEXT = /\.(?:[cm]?[jt]sx?|mts|css|md|mdx|html|json)$/;

function walk(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    if (SKIP_DIRS.has(e.name)) return [];
    const p = join(dir, e.name);
    return e.isDirectory() ? walk(p) : TEXT.test(e.name) ? [p] : [];
  });
}

test("no scanned file spells out an arbitrary url class the CSS bundler can't resolve", () => {
  const files = [
    ...SCANNED_DIRS.flatMap((d) => walk(join(ROOT, d))),
    ...readdirSync(ROOT).filter((f) => f.endsWith(".md")).map((f) => join(ROOT, f)),
  ];
  const offenders: string[] = [];
  for (const file of files) {
    if (file === join(ROOT, "tests", "tailwind-scan-urls.test.mts")) continue;
    readFileSync(file, "utf-8").split("\n").forEach((line, i) => {
      for (const m of line.matchAll(/\[url\(([^)\]]*)/g)) {
        if (!/^(?:\/|https?:\/\/|data:|var\()/.test(m[1])) offenders.push(`${file.slice(ROOT.length + 1)}:${i + 1}`);
      }
    });
  }
  assert.deepEqual(offenders, [], "describe the class in words, or use an absolute path / full URL");
});
