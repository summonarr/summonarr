// The Trakt connect component (src/components/profile/trakt-connect.tsx) is a
// .tsx client component the unit loader can't import, so its wiring is pinned
// by a structural scan. Pinned:
//   - a poll answered "pending" goes back to the server's base interval, and a
//     failing server's back-off is capped, never doubled without end;
//   - polling stops once the code's lifetime (the start response's expiresIn)
//     has passed, and says "expired";
//   - a new connection re-reads /api/profile/trakt and takes both switches from
//     it (a reconnect after a disconnect starts from the server's defaults, not
//     the switches the page still showed), and a toggle takes both from the
//     PATCH answer.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const src = readFileSync(new URL("../src/components/profile/trakt-connect.tsx", import.meta.url), "utf8");

// The body of `case "<name>":` up to the next case/default.
function caseBody(name: string): string {
  const start = src.indexOf(`case "${name}":`);
  assert.ok(start >= 0, `case "${name}" exists`);
  const rest = src.slice(start + 1);
  const end = rest.search(/\n\s*(case "|default:)/);
  return rest.slice(0, end);
}

test("pending polls at the base interval; every back-off is capped", () => {
  assert.match(caseBody("pending"), /schedulePoll\(baseInterval\.current\)/);
  const backoffs = src.match(/schedulePoll\([^;]*intervalSeconds \* 2[^;]*\)/g) ?? [];
  assert.equal(backoffs.length, 2, "the HTTP-error and the thrown-fetch branches");
  for (const b of backoffs) assert.match(b, /Math\.min\(intervalSeconds \* 2, MAX_POLL_BACKOFF_SECONDS\)/);
});

// Counted, never a clock (guardrail 16): the code's lifetime is a budget each
// scheduled wait spends, so no Date.now() can reach a render path.
test("the code's lifetime bounds the polling", () => {
  assert.match(src, /pollBudgetMs\.current = expiresIn \* 1000;/);
  assert.match(src, /async function poll\([^)]*\) \{\s*if \(pollBudgetMs\.current <= 0\) \{\s*expire\(\);\s*return;/);
  assert.match(src, /Math\.max\(pollBudgetMs\.current, 0\)\);\s*pollBudgetMs\.current -= delayMs;/, "each wait is spent, and none goes past the expiry");
  assert.doesNotMatch(src, /Date\.now\(\)/, "no clock read in the component");
});

test("a new connection re-reads the switches; a toggle takes both from the PATCH answer", () => {
  assert.match(caseBody("connected"), /void reloadState\(\);/);
  const reload = src.slice(src.indexOf("async function reloadState()"));
  assert.match(reload.slice(0, 400), /fetch\(withBasePath\("\/api\/profile\/trakt"\)\)/);
  const apply = src.slice(src.indexOf("function applyState("), src.indexOf("async function reloadState()"));
  assert.match(apply, /setWatchlist\(/);
  assert.match(apply, /setHistory\(/);
  const toggle = src.slice(src.indexOf("async function toggle("));
  assert.match(toggle.slice(0, 1200), /applyState\(data\);/);
});

// The copy tick used an untracked setTimeout: a second click was cut short by
// the first timer, and the timer fired after unmount. The shared hook keeps one.
test("the device code's copy tick goes through the shared useCopyFeedback hook", () => {
  assert.match(src, /const \{ copied, copy \} = useCopyFeedback\(\);/);
  assert.match(src, /async function copyCode\(\) \{\s*if \(!device\) return;\s*await copy\(device\.userCode\);/);
  assert.doesNotMatch(src, /setTimeout\(\(\) => setCopied/, "no untracked reset timer");
});
