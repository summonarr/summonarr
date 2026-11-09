// The Plex PIN return page (/auth/plex/done): the stashed redirect state is
// checked before use, and both PIN polls are bounded in wall-clock time with a
// per-request timeout. The rules live in src/lib/client/plex-redirect-auth.ts
// and are tested directly; the page is a .tsx client component the loader
// cannot import, so its wiring is pinned at the source level.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  PIN_POLL_WINDOW_MS,
  SETTINGS_POLL_REQUEST_TIMEOUT_MS,
  parsePlexRedirectAuth,
  plexPinPollStep,
  pollDeadline,
  requestTimeoutSignal,
} from "../src/lib/client/plex-redirect-auth.ts";

const PAGE = readFileSync(join(process.cwd(), "src/app/auth/plex/done/page.tsx"), "utf-8");

test("parsePlexRedirectAuth accepts exactly what the login and Plex connect forms write", () => {
  // login-form.tsx also stores deviceMeta, and siteUrl may be empty.
  const login = {
    flow: "login", pinId: 4242, clientId: "abcdef01-2345", rememberMe: false,
    callbackUrl: "/requests", siteUrl: "", state: "s1", deviceMeta: { platform: "Chrome" },
  };
  assert.deepEqual(parsePlexRedirectAuth(JSON.stringify(login)), {
    flow: "login", pinId: 4242, clientId: "abcdef01-2345", rememberMe: false,
    callbackUrl: "/requests", siteUrl: "", state: "s1",
  });
  assert.deepEqual(
    parsePlexRedirectAuth(JSON.stringify({ flow: "settings", pinId: 7, state: "s2" })),
    { flow: "settings", pinId: 7, state: "s2" },
  );
});

test("parsePlexRedirectAuth refuses anything else, so the page falls back to /login instead of throwing", () => {
  for (const raw of [
    "{nope",
    "null",
    "42",
    "[]",
    JSON.stringify({ flow: "other", pinId: 1, state: "s" }),
    JSON.stringify({ flow: "settings", pinId: "1", state: "s" }),
    JSON.stringify({ flow: "settings", pinId: 1.5, state: "s" }),
    JSON.stringify({ flow: "settings", pinId: 1, state: 5 }),
    JSON.stringify({ flow: "login", pinId: 1, clientId: "c", callbackUrl: "/", siteUrl: "", state: "s" }),
    JSON.stringify({ flow: "login", pinId: 1, clientId: 9, rememberMe: true, callbackUrl: "/", siteUrl: "", state: "s" }),
  ]) {
    assert.equal(parsePlexRedirectAuth(raw), null, raw);
  }
});

test("plexPinPollStep: 2xx is read, 404/410 end the wait at once, 429 backs off, anything else retries", () => {
  assert.deepEqual(plexPinPollStep(200, null), { kind: "read" });
  assert.deepEqual(plexPinPollStep(404, null), { kind: "expired" });
  assert.deepEqual(plexPinPollStep(410, null), { kind: "expired" });
  assert.deepEqual(plexPinPollStep(429, "7"), { kind: "wait", delayMs: 7_000 });
  assert.deepEqual(plexPinPollStep(429, "3600"), { kind: "wait", delayMs: 30_000 }, "a huge Retry-After is capped");
  assert.deepEqual(plexPinPollStep(429, null), { kind: "wait", delayMs: 5_000 });
  assert.deepEqual(plexPinPollStep(429, "soon"), { kind: "wait", delayMs: 5_000 });
  assert.deepEqual(plexPinPollStep(503, null), { kind: "wait", delayMs: 1_000 });
});

test("requestTimeoutSignal aborts after its timeout", async () => {
  const signal = requestTimeoutSignal(5);
  assert.equal(signal.aborted, false);
  await new Promise<void>((resolve) => signal.addEventListener("abort", () => resolve(), { once: true }));
  assert.equal(signal.aborted, true);
});

test("pollDeadline counts the window down from when it was started", () => {
  const d = pollDeadline(60_000);
  const left = d.remaining();
  assert.ok(left > 59_000 && left <= 60_000, String(left));
  assert.ok(pollDeadline(0).remaining() <= 0, "an empty window is already over");
});

test("the settings poll's per-request timeout outlasts the route's own 15s plex.tv timeout", () => {
  assert.ok(SETTINGS_POLL_REQUEST_TIMEOUT_MS > 15_000);
  assert.equal(PIN_POLL_WINDOW_MS, 120_000);
});

test("done page: the stashed state goes through the shape guard, never a bare cast", () => {
  assert.match(PAGE, /parsePlexRedirectAuth\(stored\)/);
  assert.doesNotMatch(PAGE, /as RedirectAuth/);
  assert.match(PAGE, /if \(!auth\) \{\s*window\.location\.replace\(withBasePath\("\/login"\)\);/);
});

test("done page: both PIN polls and the final sign-in carry a timeout, and the polls share one wall-clock window", () => {
  assert.equal((PAGE.match(/signal: anySignal\(signal, requestTimeoutSignal\(/g) ?? []).length, 3);
  assert.match(PAGE, /signal: anySignal\(signal, requestTimeoutSignal\(SIGN_IN_REQUEST_TIMEOUT_MS\)\)/);
  assert.equal((PAGE.match(/await pollWindow\(signal, async \(\) => \{/g) ?? []).length, 2);
  // The one loop is deadline-bound and stops the moment the page goes away.
  assert.equal((PAGE.match(/const deadline = pollDeadline\(PIN_POLL_WINDOW_MS\);/g) ?? []).length, 1);
  assert.equal((PAGE.match(/while \(deadline\.remaining\(\) > 0 && !signal\.aborted\)/g) ?? []).length, 1);
  assert.equal((PAGE.match(/await abortableSleep\(Math\.min\(delayMs, deadline\.remaining\(\)\), signal\);/g) ?? []).length, 1);
  assert.doesNotMatch(PAGE, /i < 120/, "an iteration count alone does not bound the wait");
});

test("done page: the login poll checks the status before reading the body, and maps an expired PIN to its message", () => {
  const login = PAGE.slice(PAGE.indexOf("async function completeLogin"), PAGE.indexOf("async function completeSettings"));
  const stepAt = login.indexOf("plexPinPollStep(r.status");
  const jsonAt = login.indexOf("r.json()");
  assert.ok(stepAt > 0 && jsonAt > stepAt, "the status decides before any body is parsed");
  assert.match(login, /step\.kind === "expired"\) \{[\s\S]*?expired = true;\s*return \{ stop: true \};/);
  assert.match(login, /if \(expired\) \{\s*fail\(t\("auth\.plexDone\.error\.expired"\)\);\s*return;/);
});

test("done page: a real unmount aborts the running flow, a Strict Mode remount keeps it, and an aborted flow never navigates", () => {
  assert.match(PAGE, /if \(flow\) flow\.abortTimer = setTimeout\(\(\) => flow\.ctrl\.abort\(\), 0\);/);
  assert.match(PAGE, /if \(startedRef\.current\) \{\s*if \(flowRef\.current\) clearTimeout\(flowRef\.current\.abortTimer\);\s*return cleanup;/);
  assert.match(PAGE, /void completeLogin\(auth, ctrl\.signal\);/);
  assert.match(PAGE, /void completeSettings\(ctrl\.signal\);/);
  const login = PAGE.slice(PAGE.indexOf("async function completeLogin"), PAGE.indexOf("async function completeSettings"));
  assert.match(login, /if \(signal\.aborted\) return;\s*window\.location\.href = plexSignInDestination\(auth, window\.location\.origin\);/);
  const settings = PAGE.slice(PAGE.indexOf("async function completeSettings"), PAGE.indexOf("const startedRef"));
  assert.match(settings, /if \(signal\.aborted\) return;\s*if \(!connected\)/);
});

test("done page: the settings poll reads its answer through settingsPollStep, never an unchecked body", () => {
  const settings = PAGE.slice(PAGE.indexOf("async function completeSettings"), PAGE.indexOf("const startedRef"));
  assert.match(settings, /settingsPollStep\(r\.status, r\.headers\.get\("retry-after"\), r\.headers\.get\("content-type"\), serverErrors\)/);
  assert.match(settings, /isConnectedBody\(await r\.json\(\)\.catch\(\(\) => null\)\)/);
  assert.doesNotMatch(PAGE, /const d: \{ status\?: string \} = await r\.json\(\)/);
  // The plex.tv headers come from the shared builder.
  assert.match(PAGE, /headers: plexClientHeaders\(auth\.clientId\),/);
  assert.doesNotMatch(PAGE, /"X-Plex-Product"/);
});
