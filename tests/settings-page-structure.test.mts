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
    /unrecorded\.map\(\s*\(target\)\s*=>\s*prisma\.auditLog\.findFirst\(\{\s*where:\s*\{\s*target\s*\}/,
  );
  // findFirst can return null per target — the fallback loop must skip those.
  assert.match(src, /for \(const r of lastRuns\) \{\s*if \(!r\) continue;/);
});

test("the audit-log fallback is read only for jobs with no usable ledger row, after the ledger", () => {
  // Every job records to the cron:lastRun ledger now, so the per-target audit
  // read is a fallback for a job that has never run since — not 19 reads a
  // render whose answers the ledger then overwrites.
  assert.match(src, /const unrecorded = cronTargets\.filter\(\(target\) => !lastRunMap\.has\(target\)\);/);
  const ledger = src.indexOf("for (const s of lastRunSettings)");
  const fallback = src.indexOf("const unrecorded = ");
  assert.ok(ledger > 0 && fallback > ledger, "the ledger rows must be read into lastRunMap before the fallback is chosen");
  assert.doesNotMatch(src, /cronTargets\.map\(\s*\(target\)\s*=>\s*prisma\.auditLog/, "the audit log is read for every target again");
});

test("each cron job's target, endpoint and interval are declared once, in CRON_JOBS", () => {
  assert.match(src, /const cronTargets = CRON_JOBS\.map\(\(job\) => job\.target\);/);
  assert.match(src, /return CRON_JOBS\.map\(\(job\) => \(\{[\s\S]*?\.\.\.lastRunInfo\(job\.target\),/);
  // No second, hand-written list of targets or rows.
  assert.doesNotMatch(src, /lastRunInfo\("/);
  assert.doesNotMatch(src, /const cronTargets = \[/);
});

test("ALL_KEYS no longer loads the unused legacy path-strip prefixes", () => {
  const keys = src.slice(src.indexOf("const ALL_KEYS = ["), src.indexOf("] as const;"));
  assert.ok(keys.length > 0);
  assert.doesNotMatch(keys, /"plexPathStripPrefix"|"jellyfinPathStripPrefix"/);
  assert.match(keys, /"plexMoviePathStripPrefix"/);
});

test("the webhook URL base falls through a cleared Site URL and carries BASE_PATH", () => {
  // `cfg.siteUrl?.replace(...) ?? AUTH_URL` kept "" (a cleared Site URL) and
  // built relative URLs; AUTH_URL alone dropped BASE_PATH (tests/site-base-url).
  assert.doesNotMatch(src, /cfg\.siteUrl\?\.replace\([^)]*\)\s*\?\?/);
  assert.match(src, /const baseUrl = siteBaseUrl\(cfg\.siteUrl, process\.env\.AUTH_URL, process\.env\.BASE_PATH\);/);
  assert.match(src, /siteUrl=\{cfg\.siteUrl \|\| process\.env\.AUTH_URL \|\| ""\}/);
});

test("the database counts are ONE named-column statement, and the share count streams behind Suspense", () => {
  // readDbCounts (tests/settings-db-counts.test.mts); no per-model count
  // fan-out left on this page.
  assert.match(src, /readDbCounts\(new Date\(\)\)/);
  assert.doesNotMatch(src, /prisma\.\w+\.count\(/);
  // The live Plex/Jellyfin share count is not awaited by the page itself.
  assert.doesNotMatch(src, /await Promise\.allSettled\(\[\s*\/\/ This server's members/);
  assert.match(src, /<Suspense fallback="…">\s*<CurrentSharesValue count=\{metrics\.currentShares\} locale=\{locale\} \/>\s*<\/Suspense>/);
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
  assert.match(src, /countPlexServerMembers\(cfg\.plexAdminToken, cfg\.plexServerUrl\)/);
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
