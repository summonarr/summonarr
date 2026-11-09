import test from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { XACT_LOCK_1001_KEYS } from "../src/lib/advisory-lock.ts";

function sourceFiles(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) sourceFiles(full, out);
    else if (/\.(ts|tsx)$/.test(name)) out.push(full);
  }
  return out;
}

test("every (1001, n) transaction lock in src is registered, and the registered keys are distinct", () => {
  const registered = Object.values(XACT_LOCK_1001_KEYS) as number[];
  assert.equal(new Set(registered).size, registered.length, "no two names share a key");
  const used = new Set<number>();
  for (const file of sourceFiles(new URL("../src", import.meta.url).pathname)) {
    for (const m of readFileSync(file, "utf8").matchAll(/pg_advisory_xact_lock\(\s*1001\s*,\s*(\d+)\s*\)/g)) {
      used.add(Number(m[1]));
    }
  }
  assert.deepEqual([...used].sort(), [...registered].sort(), "the literals in src are exactly the registered keys");
});
