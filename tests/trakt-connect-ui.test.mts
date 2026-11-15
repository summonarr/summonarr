// The Trakt connect component (src/components/profile/trakt-connect.tsx) is a
// .tsx client component the unit loader can't import, so its wiring is pinned
// by a structural scan. Pinned:
//   - a poll answered "pending" goes back to the server's base interval, and a
//     failing server's back-off is capped, never doubled without end;
//   - polling stops once the code's lifetime (the start response's expiresIn)
//     has passed, and says "expired";
//   - nothing polls once the component has unmounted, even when the start
//     answer lands after it (use-trakt-device-poll.ts);
//   - a new connection re-reads /api/profile/trakt and takes both switches from
//     it (a reconnect after a disconnect starts from the server's defaults, not
//     the switches the page still showed), and a toggle takes both from the
//     PATCH answer.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  backoffSeconds,
  MAX_POLL_BACKOFF_SECONDS,
  readDeviceCode,
  readPollAnswer,
} from "../src/components/profile/trakt-device-poll.ts";

const src = readFileSync(new URL("../src/components/profile/trakt-connect.tsx", import.meta.url), "utf8");
const hook = readFileSync(new URL("../src/components/profile/use-trakt-device-poll.ts", import.meta.url), "utf8");

// The body of `case "<name>":` up to the next case/default.
function caseBody(text: string, name: string): string {
  const start = text.indexOf(`case "${name}":`);
  assert.ok(start >= 0, `case "${name}" exists`);
  const rest = text.slice(start + 1);
  const end = rest.search(/\n\s*(case "|default:)/);
  return rest.slice(0, end);
}

test("pending polls at the base interval; every back-off is capped", () => {
  assert.match(caseBody(hook, "pending"), /schedulePoll\(baseInterval\.current\)/);
  assert.match(caseBody(hook, "backoff"), /schedulePoll\(backoffSeconds\(intervalSeconds\)\)/);
  assert.equal(backoffSeconds(5), 10);
  assert.equal(backoffSeconds(40), MAX_POLL_BACKOFF_SECONDS);
  assert.equal(backoffSeconds(MAX_POLL_BACKOFF_SECONDS), MAX_POLL_BACKOFF_SECONDS);
});

test("a poll answer is read by status, then by state", () => {
  // No answer, rate limited, a server failure: transient, back off.
  for (const status of [0, 429, 500, 502]) assert.deepEqual(readPollAnswer(status, null), { kind: "backoff" });
  assert.deepEqual(readPollAnswer(400, { error: "Nope" }), { kind: "failed", error: "Nope" });
  // A non-string error is never shown.
  assert.deepEqual(readPollAnswer(400, { error: { code: 1 } }), { kind: "failed", error: "" });
  assert.deepEqual(readPollAnswer(200, { state: "pending" }), { kind: "pending" });
  assert.deepEqual(readPollAnswer(200, { state: "connected", username: "ana" }), { kind: "connected", username: "ana" });
  assert.deepEqual(readPollAnswer(200, { state: "connected", username: 7 }), { kind: "connected", username: null });
  assert.deepEqual(readPollAnswer(200, { state: "denied" }), { kind: "denied" });
  assert.deepEqual(readPollAnswer(200, { state: "conflict" }), { kind: "conflict" });
  assert.deepEqual(readPollAnswer(200, { state: "expired" }), { kind: "expired" });
  assert.deepEqual(readPollAnswer(200, null), { kind: "expired" });
});

test("the start answer's code needs both strings; interval and lifetime fall back", () => {
  assert.equal(readDeviceCode({ userCode: "ABC" }), null);
  assert.equal(readDeviceCode({ userCode: 1, verificationUrl: "https://trakt.tv/activate" }), null);
  assert.equal(readDeviceCode({ userCode: "ABC", verificationUrl: "javascript:alert(1)" }), null);
  assert.deepEqual(readDeviceCode({ userCode: "ABC", verificationUrl: "https://trakt.tv/activate", interval: -1, expiresIn: "x" }), {
    userCode: "ABC", verificationUrl: "https://trakt.tv/activate", interval: 5, expiresIn: 600,
  });
  assert.deepEqual(readDeviceCode({ userCode: "ABC", verificationUrl: "https://trakt.tv/activate", interval: 8, expiresIn: 900 }), {
    userCode: "ABC", verificationUrl: "https://trakt.tv/activate", interval: 8, expiresIn: 900,
  });
});

// Counted, never a clock (guardrail 16): the code's lifetime is a budget each
// scheduled wait spends, so no Date.now() can reach a render path.
test("the code's lifetime bounds the polling", () => {
  assert.match(hook, /pollBudgetMs\.current = expiresInSeconds \* 1000;/);
  assert.match(hook, /async function poll\([^)]*\) \{\s*if \(pollBudgetMs\.current <= 0\) \{\s*onEndRef\.current\(\{ kind: "expired" \}\);\s*return;/);
  assert.match(hook, /Math\.max\(pollBudgetMs\.current, 0\)\);\s*pollBudgetMs\.current -= delayMs;/, "each wait is spent, and none goes past the expiry");
  assert.doesNotMatch(src, /Date\.now\(\)/, "no clock read in the component");
  assert.doesNotMatch(hook, /Date\.now\(\)/, "no clock read in the poll loop");
});

// A Connect click whose answer arrived after the page went used to start a
// poll loop nothing could stop.
test("nothing polls after unmount, however late the start answer lands", () => {
  assert.match(hook, /function schedulePoll\([^)]*\) \{\s*stopPolling\(\);\s*if \(!mounted\.current\) return;/);
  assert.match(hook, /function begin\([^)]*\) \{\s*if \(!mounted\.current\) return;/);
  assert.match(hook, /return \(\) => \{\s*mounted\.current = false;\s*stopPolling\(\);/);
  const start = src.slice(src.indexOf("async function start("), src.indexOf("function cancel()"));
  assert.ok(start.indexOf("if (!poller.alive()) return;") >= 0, "start bails out after its await");
  assert.ok(start.indexOf("if (!poller.alive()) return;") < start.indexOf("poller.begin("));
  // An answer from a stopped run is dropped.
  assert.match(hook, /if \(pollGen\.current !== gen\) return;/);
});

test("a new connection re-reads the switches; a toggle takes both from the PATCH answer", () => {
  assert.match(caseBody(src, "connected"), /void reloadState\(\);/);
  const reload = src.slice(src.indexOf("async function reloadState()"));
  assert.match(reload.slice(0, 400), /fetchJson\(withBasePath\("\/api\/profile\/trakt"\)\)/);
  const apply = src.slice(src.indexOf("function applyState("), src.indexOf("async function reloadState()"));
  assert.match(apply, /setWatchlist\(/);
  assert.match(apply, /setHistory\(/);
  const toggle = src.slice(src.indexOf("async function toggle("));
  assert.match(toggle.slice(0, 1200), /applyState\(data\);/);
});

// The copy tick used an untracked setTimeout: a second click was cut short by
// the first timer, and the timer fired after unmount. The shared hook keeps one.
test("the device code's copy tick goes through the shared useCopyFeedback hook", () => {
  assert.match(src, /const \{ copied, failed, copy \} = useCopyFeedback\(\);/);
  assert.match(src, /async function copyCode\(\) \{\s*await copy\(device\.userCode\);/);
  assert.doesNotMatch(src, /setTimeout\(\(\) => setCopied/, "no untracked reset timer");
});

// A refused clipboard left the button as it was, with nothing said.
test("a failed copy says so, in the Trakt code panel, both two-factor copy buttons and the calendar feed URLs", () => {
  const tfa = readFileSync(new URL("../src/components/profile/two-factor.tsx", import.meta.url), "utf8");
  const cal = readFileSync(new URL("../src/components/profile/calendar-feed.tsx", import.meta.url), "utf8");
  for (const [name, text] of [["trakt-connect", src], ["two-factor", tfa], ["calendar-feed", cal]] as const) {
    assert.match(text, /const \{ copied, failed, copy \} = useCopyFeedback\(\);/, name);
    assert.match(text, /\{failed && <p role="alert"[^>]*>\{t\("profile\.common\.copyFailed"\)\}<\/p>\}/, name);
  }
  const locales = ["en", "es", "fr", "de", "pt", "it", "zh"];
  for (const l of locales) {
    const cat = JSON.parse(readFileSync(new URL(`../src/lib/i18n/messages/${l}/profile.json`, import.meta.url), "utf8")) as Record<string, string>;
    assert.ok(cat["profile.common.copyFailed"], l);
  }
});

// The confirm button was the one control a save in flight did not lock, so a
// switch's PATCH and the DELETE could race.
test("the confirm-Disconnect button is locked while anything is in flight", () => {
  assert.match(src, /<Button type="button" variant="destructive" disabled=\{busy !== null\} onClick=\{disconnect\}/);
});

// "Incorrect password." stayed in the prompt after a later try whose password
// was accepted and which failed for another reason.
test("a failure that is not a step-up refusal clears the prompt's password error", () => {
  const start = src.slice(src.indexOf("async function start("), src.indexOf("function cancel()"));
  assert.match(start, /if \(!code\) \{[^}]*?setStepUpError\(null\);\s*setError\(/);
  assert.match(start, /res\.status === 0\) \{[^}]*?setStepUpError\(null\);\s*setError\(/);
});
