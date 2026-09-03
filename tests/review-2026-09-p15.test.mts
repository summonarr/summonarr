// Review 2026-09, package P15 — structural pins for src/app/(app)/settings/page.tsx.
//
// The settings page is a server component that imports .tsx, so it cannot be
// loaded by the node:test runner (see the loader note in CLAUDE.md). These
// pins read the source instead, the same way tests/bitrate.test.mts scans for
// an antipattern, so each fix can be mutation-tested: revert it and the pin
// names the regression.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

const PAGE = new URL("../src/app/(app)/settings/page.tsx", import.meta.url);
const src = readFileSync(PAGE, "utf8");

test("f27: the cron last-run audit fallback is one LIMIT-1 findFirst per target, not a client-side distinct", () => {
  // Prisma 7's query compiler implements `distinct` in Node — that shape pulled
  // every audit row for the 11 cron targets (one per orchestrator run, kept a
  // year) into the process on each System-tab render.
  // (The in-source comment names the old shape, so match the call, not the string.)
  assert.doesNotMatch(src, /prisma\.auditLog\.findMany\(\{[^}]*\}[\s\S]{0,200}?distinct:/);
  assert.doesNotMatch(src, /prisma\.auditLog\.findMany\(/);
  assert.match(
    src,
    /cronTargets\.map\(\s*\(target\)\s*=>\s*prisma\.auditLog\.findFirst\(\{\s*where:\s*\{\s*target\s*\}/,
  );
  // findFirst can return null per target — the fallback loop must skip those.
  assert.match(src, /for \(const r of lastRuns\) \{\s*if \(!r\) continue;/);
});

test("f28: no second setting.findUnique read for values ALL_KEYS already loaded into cfg", () => {
  for (const key of ["plexAdminToken", "jellyfinUrl", "jellyfinApiKey"]) {
    assert.match(src, new RegExp(`"${key}"`), `${key} must stay in ALL_KEYS`);
    assert.doesNotMatch(
      src,
      new RegExp(`setting\\.findUnique\\(\\{\\s*where:\\s*\\{\\s*key:\\s*"${key}"`),
      `${key} is read once via findMany; a findUnique re-read is redundant`,
    );
  }
  assert.match(src, /getPlexAccounts\(cfg\.plexServerUrl, cfg\.plexAdminToken\)/);
  assert.match(src, /getJellyfinUserCount\(cfg\.jellyfinUrl, cfg\.jellyfinApiKey\)/);
});

test("f29: an unparseable `at` in a cron:lastRun row is skipped instead of becoming an Invalid Date", () => {
  // parseCronLastRun passes `at` through verbatim (tests/cron-auth.test.mts pins
  // that), and toISOString() on an Invalid Date throws — which took the whole
  // System tab down on one corrupted Setting row.
  assert.throws(() => new Date("not-a-date").toISOString(), RangeError);
  assert.doesNotMatch(src, /new Date\(parsed\.at\)/);
  assert.match(
    src,
    /const atMs = Date\.parse\(parsed\.at\);\s*if \(!Number\.isFinite\(atMs\)\) continue;\s*lastRunMap\.set\(target, \{\s*createdAt: new Date\(atMs\)/,
  );
});
