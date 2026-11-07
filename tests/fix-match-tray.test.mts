// The fix-match job tray (src/components/admin/fix-match-tray.tsx), pinned
// structurally (no .tsx harness).
//
// Why: a non-OK read of the jobs feed (a 500 from auth or the DB) set the tray
// to an empty list, which also switched its poll off — jobs still running on
// the server (for many minutes) vanished, and their outcome was never shown.
// And reads can overlap (the 6 s poll and a job-start event): a slow older
// answer landing last rolled a finished job back to "running", or switched the
// poll off under a job that had just started.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const src = readFileSync(new URL("../src/components/admin/fix-match-tray.tsx", import.meta.url), "utf8");
const refresh = src.slice(src.indexOf("const refresh = useCallback("), src.indexOf("}, []);", src.indexOf("const refresh = useCallback(")));

test("a failed read of the feed keeps the tray and its poll: only a sign-out empties it", () => {
  assert.match(refresh, /if \(res\.status === 401 \|\| res\.status === 403\) \{\s*(\/\/[^\n]*\n\s*)*next = \[\];/);
  assert.match(refresh, /if \(!res\.ok\) return;/, "any other failure returns before touching state");
  assert.match(refresh, /if \(!Array\.isArray\(body\.jobs\)\) return;/, "an answer without a job list is not an empty one");
  assert.doesNotMatch(refresh, /\?\? \[\]/, "never defaults a failed read to no jobs");
});

test("only the latest read lands", () => {
  assert.match(refresh, /const id = \+\+seq\.current;/);
  assert.match(refresh, /if \(!alive\.current \|\| id !== seq\.current\) return;\s*setJobs\(next\);/);
});

test("each job names its server instance", () => {
  assert.match(src, /mediaInstanceLabel\(j\.server === "jellyfin" \? "jellyfin" : "plex", j\.serverInstance \?\? ""\)/);
});
