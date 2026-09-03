// Review 2026-09, package P30 (finding f4): the hand-run scripts/check-schema.mjs
// carried a private copy of the admin check-schema route's EXPECTED column table
// and silently drifted — it lacked the guardrail-32/35 identity columns
// (serverInstance / arrInstance), jellyfinItemIds, deactivatedAt and purgedAt, so
// it exited 0 on a database that GET /api/admin/check-schema reported as broken.
// It was deleted; the route is the single maintained copy (and is in the OpenAPI
// spec). This pin keeps a second EXPECTED table from reappearing under scripts/.
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

const ROOT = new URL("..", import.meta.url).pathname;

test("scripts/check-schema.mjs stays deleted — the admin route is the only schema checker", () => {
  assert.equal(existsSync(join(ROOT, "scripts/check-schema.mjs")), false);
});

test("no script under scripts/ carries its own information_schema column-expectation table", () => {
  const offenders: string[] = [];
  for (const name of readdirSync(join(ROOT, "scripts"))) {
    if (!/\.(mjs|mts|ts|js)$/.test(name)) continue;
    const src = readFileSync(join(ROOT, "scripts", name), "utf8");
    if (src.includes("information_schema.columns") && /\bconst EXPECTED\b/.test(src)) {
      offenders.push(name);
    }
  }
  assert.deepEqual(offenders, []);
});

test("the maintained route's EXPECTED table names the multi-instance identity columns", () => {
  const src = readFileSync(join(ROOT, "src/app/api/admin/check-schema/route.ts"), "utf8");
  for (const table of ["PlexLibraryItem", "JellyfinLibraryItem", "PlayHistory", "ActiveSession", "MediaServerUser"]) {
    assert.match(src, new RegExp(`${table}:\\s*\\[[^\\]]*"serverInstance"`), `${table} lacks serverInstance`);
  }
  for (const table of ["MediaRequest", "RadarrWantedItem", "SonarrWantedItem", "RadarrAvailableItem", "SonarrAvailableItem"]) {
    assert.match(src, new RegExp(`${table}:\\s*\\[[^\\]]*"arrInstance"`), `${table} lacks arrInstance`);
  }
});
