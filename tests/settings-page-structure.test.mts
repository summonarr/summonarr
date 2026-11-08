// Structural pins for the admin settings page: src/app/(app)/settings/page.tsx
// and the per-tab modules beside it in _tabs/.
//
// The page and its tabs are server components that import .tsx, so the
// node:test runner cannot load them (see the loader note in CLAUDE.md). These
// pins read the source instead, so each fix can be mutation-tested: revert it
// and the pin names the regression. The pure parts are tested directly in
// tests/settings-cron-jobs.test.mts and tests/settings-current-shares.test.mts.
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { test } from "node:test";

const DIR = new URL("../src/app/(app)/settings/", import.meta.url);
const read = (rel: string) => readFileSync(new URL(rel, DIR), "utf8");
const page = read("page.tsx");
const systemTab = read("_tabs/system-tab.tsx");
const systemData = read("_tabs/system-tab-data.ts");
const cronJobs = read("_tabs/cron-jobs.ts");
const shares = read("_tabs/current-shares.ts");
const tabFiles = readdirSync(new URL("_tabs/", DIR)).map((f) => read(`_tabs/${f}`));
const everything = [page, ...tabFiles].join("\n");

test("the cron last-run audit fallback is one LIMIT-1 findFirst per target, not a client-side distinct", () => {
  // Prisma 7's query compiler implements `distinct` in Node — that shape pulled
  // every audit row for the cron targets (one per orchestrator run, kept a
  // year) into the process on each System-tab render.
  assert.doesNotMatch(everything, /prisma\.auditLog\.findMany\(/);
  assert.match(
    systemData,
    /unrecorded\.map\(\s*\(target\)\s*=>\s*prisma\.auditLog\.findFirst\(\{\s*where:\s*\{\s*target\s*\}/,
  );
  // findFirst can return null per target — the fallback loop must skip those.
  assert.match(systemData, /for \(const r of lastRuns\) \{\s*if \(!r\) continue;/);
});

test("the audit-log fallback is read only for jobs with no usable ledger row, after the ledger", () => {
  assert.match(systemData, /const unrecorded = cronTargets\.filter\(\(target\) => !lastRunMap\.has\(target\)\);/);
  const ledger = systemData.indexOf("for (const s of lastRunSettings)");
  const fallback = systemData.indexOf("const unrecorded = ");
  assert.ok(ledger > 0 && fallback > ledger, "the ledger rows must be read into lastRunMap before the fallback is chosen");
  assert.doesNotMatch(systemData, /cronTargets\.map\(\s*\(target\)\s*=>\s*prisma\.auditLog/, "the audit log is read for every target again");
});

test("each cron job's target, endpoint and interval are declared once, in CRON_JOBS", () => {
  assert.match(systemData, /const cronTargets = CRON_JOBS\.map\(\(job\) => job\.target\);/);
  assert.match(cronJobs, /return CRON_JOBS\.map\(\(job\) => \{[\s\S]*?lastRuns\.get\(job\.target\)/);
  assert.doesNotMatch(everything, /const cronTargets = \[/);
});

test("each tab reads only the Setting rows it renders; the legacy path-strip prefixes are read by none", () => {
  // Every tab used to read and decrypt all ~150 settings, secrets included.
  assert.doesNotMatch(everything, /ALL_KEYS/);
  for (const tab of ["SITE", "MEDIA", "NOTIFICATIONS", "INTEGRATIONS", "SYSTEM"]) {
    assert.match(page, new RegExp(`return \\{ tab, cfg: await readSettings\\(${tab}_TAB_KEYS\\) \\};`), tab);
  }
  assert.match(page, /case "features": return \{ tab \};/, "the Features tab reads no setting row");
  assert.doesNotMatch(everything, /"plexPathStripPrefix"|"jellyfinPathStripPrefix"/);
  assert.match(read("_tabs/media-tab.tsx"), /"plexMoviePathStripPrefix"/);
});

test("the decrypt-failure banner is read after the tab's settings", () => {
  const load = page.indexOf("loadTab(tab)]);");
  const banner = page.indexOf("const decryptFailures = getSettingDecryptFailures();");
  assert.ok(load > 0 && banner > load);
});

test("the webhook URL base falls through a cleared Site URL and carries BASE_PATH", () => {
  // `cfg.siteUrl?.replace(...) ?? AUTH_URL` kept "" (a cleared Site URL) and
  // built relative URLs; AUTH_URL alone dropped BASE_PATH (tests/site-base-url).
  assert.doesNotMatch(everything, /cfg\.siteUrl\?\.replace\([^)]*\)\s*\?\?/);
  assert.match(read("_tabs/integrations-tab.tsx"), /const baseUrl = siteBaseUrl\(cfg\.siteUrl, process\.env\.AUTH_URL, process\.env\.BASE_PATH\);/);
  assert.match(read("_tabs/media-tab.tsx"), /siteUrl=\{cfg\.siteUrl \|\| process\.env\.AUTH_URL \|\| ""\}/);
});

test("the database counts are ONE named-column statement, and the share count streams behind Suspense", () => {
  // readDbCounts (tests/settings-db-counts.test.mts); no per-model count
  // fan-out left on this page.
  assert.match(systemTab, /readDbCounts\(new Date\(\)\)/);
  assert.doesNotMatch(everything, /prisma\.\w+\.count\(/);
  // The live Plex/Jellyfin share count is not awaited by the tab itself.
  assert.doesNotMatch(systemTab, /await countCurrentShares\(/);
  assert.match(systemTab, /const currentShares = countCurrentShares\(\)\.catch\(\(\) => null\);/);
  assert.match(systemTab, /<Suspense fallback="…">\s*<CurrentSharesValue count=\{currentShares\} locale=\{locale\} \/>\s*<\/Suspense>/);
});

test("the share count covers every syncable server, reading their credentials in one query", () => {
  assert.match(shares, /getSyncableMediaInstances\("plex"\), getSyncableMediaInstances\("jellyfin"\)/);
  assert.match(shares, /plexSettingKey\(i\.slug, "AdminToken"\)/);
  assert.match(shares, /jellyfinSettingKey\(i\.slug, "ApiKey"\)/);
  assert.equal((shares.match(/prisma\.setting\.findMany\(/g) ?? []).length, 1);
  assert.doesNotMatch(everything, /setting\.findUnique\(/);
});

test("an unparseable `at` in a cron:lastRun row is skipped instead of becoming an Invalid Date", () => {
  // parseCronLastRun passes `at` through verbatim (tests/cron-auth.test.mts pins
  // that), and toISOString() on an Invalid Date throws — which took the whole
  // System tab down on one corrupted Setting row.
  assert.throws(() => new Date("not-a-date").toISOString(), RangeError);
  assert.doesNotMatch(cronJobs, /new Date\(parsed\.at\)/);
  assert.match(cronJobs, /const atMs = Date\.parse\(parsed\.at\);\s*if \(!Number\.isFinite\(atMs\)\) return null;/);
});

test("no immediately-invoked function in the markup", () => {
  // `(() => { … })()}` / `(() => <X />)()}` inside a JSX expression.
  assert.doesNotMatch(everything, /\)\(\)\s*\}/);
});
