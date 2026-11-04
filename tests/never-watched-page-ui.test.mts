// Audit fixes (nw-upstream) on the never-watched page component — structural
// pins, because the test loader can't render a .tsx. The rules behind each are
// pure and pinned in tests/never-watched.test.mts; these pin that the page USES
// them instead of a private copy:
//   C017  "Check now" runs as a background job (POST { async: true }, polled),
//         counted polls only — no setInterval, no clock in the render (16).
//   C068  the note counts unread AND unhealthy servers (upstreamCheckCounts).
//   C069  the chip goes through upstreamChipKey ("okUnmeasured" has no %).
//   C016  the "unchecked" banner names only servers that HOLD titles.
//   C065  the Titles-only type/eligible filters are never sent from Seasons.
//   C071  a reload that lands past the last page steps back (lastValidPage).
//   C159  "incomplete" has a chip string; every HEALTH_KEYS entry exists in en.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const src = readFileSync(new URL("../src/components/admin/never-watched-report.tsx", import.meta.url), "utf8");
const en = JSON.parse(readFileSync(new URL("../src/lib/i18n/messages/en/adminManage.json", import.meta.url), "utf8")) as Record<string, string>;
const enApi = JSON.parse(readFileSync(new URL("../src/lib/i18n/messages/en/apiAdmin.json", import.meta.url), "utf8")) as Record<string, string>;

test("C017: Check now posts the refresh as a background job and polls it with a counted cap", () => {
  assert.match(src, /runReplaceFileJob\(fetch, withBasePath\("\/api\/admin\/never-watched\/refresh"\)/);
  assert.match(src, /maxPolls: CHECK_MAX_POLLS/);
  assert.match(src, /isAlive: \(\) => mounted\.current/);
  assert.doesNotMatch(src, /method: "POST" \}\);\s*\n\s*if \(!res\.ok\) \{\s*\n\s*setError\(await readApiError\(res, t\("adminManage\.neverWatched\.error\.check"\)/, "the old held-open POST is gone");
  assert.doesNotMatch(src, /setInterval\(/);
  assert.doesNotMatch(src, /Date\.now\(\)|new Date\(\)/, "guardrail 16");
  assert.ok(en["adminManage.neverWatched.checkStillRunning"], "out of polls says 'still running', never 'failed'");
  assert.ok(enApi["apiAdmin.neverWatched.refreshJobGone"]);
});

test("C068: the note counts unhealthy servers too, through the shared predicate", () => {
  assert.match(src, /const \{ unread, unhealthy \} = upstreamCheckCounts\(/);
  assert.doesNotMatch(src, /filter\(\(s\) => !s\.ok\)\.length/, "counting !ok alone called an unhealthy read 'checked'");
  assert.ok(en["adminManage.neverWatched.checkedSomeUnhealthy_one"] && en["adminManage.neverWatched.checkedSomeUnhealthy_other"]);
});

test("C069 + C159: the chip is keyed by upstreamChipKey, and every chip key exists in the English catalog", () => {
  assert.match(src, /const chip = upstreamChipKey\(u\);/);
  assert.match(src, /t\(HEALTH_KEYS\[chip\]/);
  const block = /const HEALTH_KEYS = \{([\s\S]*?)\} as const;/.exec(src)?.[1] ?? "";
  const keys = [...block.matchAll(/(\w+): "([^"]+)"/g)].map((m) => [m[1], m[2]] as const);
  assert.deepEqual(keys.map(([k]) => k).sort(), ["failed", "incomplete", "never", "ok", "okUnmeasured", "stale", "unreliable"]);
  for (const [, key] of keys) assert.ok(en[key], `missing English string ${key}`);
  assert.doesNotMatch(en["adminManage.neverWatched.upstream.okUnmeasured"], /pct|%/, "no agreement it never measured");
});

test("C016: the unchecked banner names only servers that hold titles", () => {
  assert.match(src, /data\.coverage\.filter\(\(c\) => c\.holds && c\.upstream\.health !== "ok"\)/);
});

test("C065: type and eligible are sent only from the Titles tab", () => {
  const load = /const load = useCallback\(async \(\) => \{([\s\S]*?)\n  \}, \[/.exec(src)?.[1] ?? "";
  assert.ok(load, "load() found");
  assert.doesNotMatch(load, /new URLSearchParams\(\{[^}]*\btype\b/, "type is not in the base params");
  assert.match(load, /if \(level === "title"\) \{\s*\n\s*params\.set\("type", type\);\s*\n\s*if \(eligibleOnly\) params\.set\("eligible", "1"\);/);
});

test("C071: a page that came back empty with rows left steps back to the last valid page", () => {
  assert.match(src, /const last = lastValidPage\(next\.total, limit\);\s*\n\s*if \(next\.rows\.length === 0 && next\.total > 0 && page > last\) \{\s*\n\s*setPage\(last\);/);
});
