// The /auth/plex/done page's settings-connect poll rules, its cancellation
// helpers and its post-sign-in destination (src/lib/client/plex-done-flow.ts),
// plus the shared Plex client headers (src/lib/plex-client-headers.ts).
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  SETTINGS_POLL_MAX_SERVER_ERRORS,
  abortableSleep,
  anySignal,
  isConnectedBody,
  plexSignInDestination,
  sameOriginHref,
  settingsPollStep,
} from "../src/lib/client/plex-done-flow.ts";
import { plexClientHeaders } from "../src/lib/plex-client-headers.ts";

const JSON_TYPE = "application/json; charset=utf-8";

test("settingsPollStep: a refused connect fails at once; only a JSON 2xx is read", () => {
  for (const status of [400, 401, 403, 422]) assert.deepEqual(settingsPollStep(status, null, JSON_TYPE, 0), { kind: "fail" });
  assert.deepEqual(settingsPollStep(200, null, JSON_TYPE, 0), { kind: "read" });
  // A proxy's HTML page on a 2xx is not an answer.
  assert.deepEqual(settingsPollStep(200, null, "text/html", 0), { kind: "wait", delayMs: 1_000 });
  assert.deepEqual(settingsPollStep(200, null, null, 0), { kind: "wait", delayMs: 1_000 });
});

test("settingsPollStep: 429 honours Retry-After, a run of 5xx ends in a server error instead of a timeout", () => {
  assert.deepEqual(settingsPollStep(429, "7", null, 0), { kind: "wait", delayMs: 7_000 });
  assert.deepEqual(settingsPollStep(502, null, "text/html", 1), { kind: "wait", delayMs: 1_000 });
  assert.deepEqual(settingsPollStep(502, null, "text/html", SETTINGS_POLL_MAX_SERVER_ERRORS - 1), { kind: "wait", delayMs: 1_000 });
  assert.deepEqual(settingsPollStep(502, null, "text/html", SETTINGS_POLL_MAX_SERVER_ERRORS), { kind: "serverError" });
  assert.deepEqual(settingsPollStep(404, null, null, 0), { kind: "wait", delayMs: 1_000 }, "the app's own 404 is retried, not read as plex.tv's expired PIN");
});

test("isConnectedBody accepts only { status: \"connected\" }", () => {
  assert.equal(isConnectedBody({ status: "connected", email: "a@b" }), true);
  for (const junk of [null, undefined, "connected", { status: "pending" }, { status: 1 }, []]) assert.equal(isConnectedBody(junk), false);
});

test("anySignal aborts when any input aborts; abortableSleep resolves early on abort", async () => {
  const a = new AbortController();
  const b = new AbortController();
  const both = anySignal(a.signal, b.signal);
  assert.equal(both.aborted, false);
  b.abort();
  assert.equal(both.aborted, true);

  const ctrl = new AbortController();
  const started = Date.now();
  const sleeping = abortableSleep(60_000, ctrl.signal);
  ctrl.abort();
  await sleeping;
  assert.ok(Date.now() - started < 5_000, "the sleep ended with the abort");
  await abortableSleep(60_000, ctrl.signal); // already aborted: resolves at once
});

test("sameOriginHref keeps only http(s) URLs on this origin", () => {
  const origin = "https://app.example";
  assert.equal(sameOriginHref("/requests", origin), "https://app.example/requests");
  assert.equal(sameOriginHref("https://app.example/x", origin), "https://app.example/x");
  for (const bad of ["https://evil.example/x", "javascript:alert(1)", "//evil.example/x", "", null, undefined]) {
    assert.equal(sameOriginHref(bad, origin), null, String(bad));
  }
});

test("plexSignInDestination: a deep link wins over siteUrl, siteUrl over the root, never another origin", () => {
  const origin = "https://app.example";
  assert.equal(plexSignInDestination({ callbackUrl: "/movies", siteUrl: "https://app.example/" }, origin), "https://app.example/movies");
  assert.equal(plexSignInDestination({ callbackUrl: "/", siteUrl: "https://app.example/home" }, origin), "https://app.example/home");
  assert.equal(plexSignInDestination({ callbackUrl: "/", siteUrl: "https://evil.example/" }, origin), "/");
  assert.equal(plexSignInDestination({ callbackUrl: "//evil.example/x", siteUrl: "" }, origin), "/");
});

test("plexClientHeaders: the identification set, with the web device by default", () => {
  assert.deepEqual(plexClientHeaders("cid"), {
    "X-Plex-Client-Identifier": "cid",
    "X-Plex-Product": "Summonarr",
    "X-Plex-Version": "1.0",
    "X-Plex-Model": "hosted",
    "X-Plex-Device": "Web",
    "X-Plex-Device-Name": "Summonarr",
    "X-Plex-Platform": "Web",
    Accept: "application/json",
  });
  assert.equal(plexClientHeaders("cid", { platform: "iOS", device: "iPhone", model: "app" })["X-Plex-Platform"], "iOS");
});
