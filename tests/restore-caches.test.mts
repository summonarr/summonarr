// A committed restore must drop every process memo built from the restored
// tables. The module only calls invalidators, so the pin is structural: every
// function it imports is called inside invalidateCachesAfterRestore, and the
// memos that a restore is known to stale are among them.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const source = readFileSync(new URL("../src/lib/restore-caches.ts", import.meta.url), "utf8");

function importedNames(src: string): string[] {
  const names: string[] = [];
  for (const m of src.matchAll(/import\s*\{([^}]*)\}\s*from\s*"[^"]+";/g)) {
    for (const raw of m[1].split(",")) {
      const name = raw.trim().split(/\s+as\s+/).pop()?.trim();
      if (name) names.push(name);
    }
  }
  return names;
}

function bodyOf(src: string, fn: string): string {
  const start = src.indexOf(`export function ${fn}(`);
  assert.ok(start >= 0, `${fn} not found`);
  const open = src.indexOf("{", start);
  let depth = 0;
  for (let i = open; i < src.length; i++) {
    if (src[i] === "{") depth++;
    else if (src[i] === "}" && --depth === 0) return src.slice(open, i + 1);
  }
  throw new Error("unbalanced body");
}

test("invalidateCachesAfterRestore calls every invalidator it imports", () => {
  const body = bodyOf(source, "invalidateCachesAfterRestore");
  const names = importedNames(source);
  assert.ok(names.length > 5);
  for (const name of names) {
    assert.match(body, new RegExp(`\\b${name}\\(\\)`), `${name} is imported but never called`);
  }
});

test("a restore drops the play-history settings memo and the activity cache", () => {
  const body = bodyOf(source, "invalidateCachesAfterRestore");
  for (const name of ["invalidatePlayHistorySettings", "clearActivityCache", "invalidateStatsTimeZone", "invalidateSessionDurationsCache", "invalidateFeatureFlagCache"]) {
    assert.match(body, new RegExp(`\\b${name}\\(\\);`), `${name} missing`);
  }
});
