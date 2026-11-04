// POST /api/admin/watch-sync refuses a NEW pair whose Plex account OR Jellyfin
// user is inactive, matching the GET list (which hides inactive identities).
// runWatchSync deliberately checks only the Jellyfin side for EXISTING pairs:
// nothing re-activates a Plex identity, so its flag can be stale.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(fileURLToPath(import.meta.url), "../..");
const CODE = readFileSync(join(ROOT, "src/app/api/admin/watch-sync/route.ts"), "utf8")
  .split("\n").map((l) => l.replace(/\/\/.*$/, "")).join("\n");

test("pair create refuses an inactive identity on either side", () => {
  const guard = /if \(!plex \|\| plex\.source !== "plex" \|\| !plex\.active \|\| !jellyfin \|\| jellyfin\.source !== "jellyfin" \|\| !jellyfin\.active\) \{\s*return NextResponse\.json\(\{ error: t\("apiAdmin\.watchSync\.pairInvalid"\) \}, \{ status: 400 \}\);/;
  assert.match(CODE, guard);
});
