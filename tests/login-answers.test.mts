// How the login page reads the sign-in routes' answers (src/lib/client/login-answers.ts):
//   - a failed sign-in shows the route's own reason unless it is a plain 401
//     refusal, and an error with no reason says the server failed — never
//     "wrong password" for an outage;
//   - a QuickConnect poll answer: 410 is "expired" (not a timeout), 429 waits
//     and keeps polling (the code the user typed stays valid), 400/503 and the
//     disabled marker end the run, other failures are retried;
//   - the Plex PIN and the two-factor challenge are checked, never cast.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  initialMfaMethod,
  parseMfaChallenge,
  QC_DISABLED_CODE,
  QC_FAILURE_BACKOFF_MS,
  QC_RATE_LIMIT_BACKOFF_MS,
  readPlexPin,
  readQuickConnectPoll,
  signInFailureFrom,
  signInFailureMessage,
} from "../src/lib/client/login-answers.ts";

const t = (key: string, vars?: Record<string, string | number>) => (vars ? `${key} ${JSON.stringify(vars)}` : key);
const FALLBACK = "provider says: invalid";

test("sign-in failure: a 401 is the provider's own refusal wording", () => {
  const res = signInFailureFrom(401, { error: "Invalid credentials" });
  assert.equal(signInFailureMessage(res, FALLBACK, t), FALLBACK);
});

test("sign-in failure: any other refusal with a reason shows the route's reason", () => {
  assert.equal(signInFailureMessage(signInFailureFrom(400, { error: "Unknown server" }), FALLBACK, t), "Unknown server");
  assert.equal(signInFailureMessage(signInFailureFrom(503, { error: "Not configured" }), FALLBACK, t), "Not configured");
});

test("sign-in failure: an error with no reason (a 500, a proxy's HTML 502) says the server failed", () => {
  assert.equal(signInFailureMessage(signInFailureFrom(500, null), FALLBACK, t), "auth.login.error.serverUnavailable");
  assert.equal(signInFailureMessage(signInFailureFrom(502, "<html>"), FALLBACK, t), "auth.login.error.serverUnavailable");
  assert.equal(signInFailureMessage(signInFailureFrom(400, {}), FALLBACK, t), FALLBACK, "a reason-less 4xx keeps the fallback");
});

test("sign-in failure: offline, rate-limited and disabled keep their own messages", () => {
  assert.equal(signInFailureMessage({ ok: false, offline: true }, FALLBACK, t), "auth.login.error.network");
  const limited = { status: 429, headers: { get: (n: string) => (n === "Retry-After" ? "30" : null) } };
  assert.equal(signInFailureMessage({ ok: false, status: 429, rateLimited: limited }, FALLBACK, t), 'shared.rateLimited.seconds {"seconds":30}');
  assert.equal(signInFailureMessage(signInFailureFrom(403, { error: "Disabled" }), FALLBACK, t), "Disabled");
  assert.equal(signInFailureMessage(signInFailureFrom(403, null), FALLBACK, t), "auth.login.error.signInFailed");
});

test("sign-in failure: a two-factor challenge is not a failure to report (guardrail 6d)", () => {
  const res = signInFailureFrom(401, { mfaRequired: true, mfaToken: "tok", methods: ["totp", "sms"] });
  assert.deepEqual(res.mfa, { mfaToken: "tok", methods: ["totp"], webauthn: undefined });
  assert.equal(parseMfaChallenge({ mfaRequired: "yes", mfaToken: "tok", methods: [] }), null);
  assert.equal(parseMfaChallenge(null), null);
});

test("second factor: opens on a code, else a passkey, else recovery", () => {
  assert.equal(initialMfaMethod(["webauthn", "totp", "recovery"]), "totp");
  assert.equal(initialMfaMethod(["recovery", "webauthn"]), "webauthn");
  assert.equal(initialMfaMethod(["recovery"]), "recovery");
  assert.equal(initialMfaMethod([]), "recovery");
});

test("QuickConnect poll: 200 is authenticated or pending; a 200 that isn't the route's answer is retried", () => {
  assert.deepEqual(readQuickConnectPoll(200, { authenticated: true }, null), { kind: "authenticated" });
  assert.deepEqual(readQuickConnectPoll(200, { authenticated: false }, null), { kind: "pending" });
  assert.deepEqual(readQuickConnectPoll(200, { authenticated: "true" }, null), { kind: "retry", message: null });
  assert.deepEqual(readQuickConnectPoll(200, null, null), { kind: "retry", message: null });
});

test("QuickConnect poll: 410 is an expired code with the server's reason, not a timeout", () => {
  assert.deepEqual(readQuickConnectPoll(410, { error: "Session expired" }, null), { kind: "expired", message: "Session expired" });
  assert.deepEqual(readQuickConnectPoll(410, null, null), { kind: "expired", message: null });
});

test("QuickConnect poll: 429 waits (Retry-After when sent) and keeps polling", () => {
  assert.deepEqual(readQuickConnectPoll(429, { error: "Too many" }, "7"), { kind: "rateLimited", waitMs: 7000 });
  assert.deepEqual(readQuickConnectPoll(429, null, null), { kind: "rateLimited", waitMs: QC_RATE_LIMIT_BACKOFF_MS });
  assert.deepEqual(readQuickConnectPoll(429, null, "soon"), { kind: "rateLimited", waitMs: QC_RATE_LIMIT_BACKOFF_MS });
});

test("QuickConnect poll: a 503 marked retry (the route is busy) waits and keeps polling, uncounted", () => {
  assert.deepEqual(readQuickConnectPoll(503, { error: "Busy", retry: true }, null), { kind: "busy", waitMs: QC_FAILURE_BACKOFF_MS });
  assert.deepEqual(readQuickConnectPoll(503, { error: "Busy", retry: "true" }, null), { kind: "terminal", message: "Busy" });
  const route = readFileSync("src/app/api/auth/jellyfin/quickconnect/route.ts", "utf8");
  for (const key of ["busy", "serverBusy", "tooManyPolls"]) {
    assert.match(route, new RegExp(`t\\("apiAuth\\.quickConnect\\.${key}"\\), retry: true \\}, \\{ status: 503 \\}`), key);
  }
  assert.doesNotMatch(route, /notConfigured"\), retry/, "not configured stays final");
  const hook = readFileSync("src/app/login/use-quick-connect.ts", "utf8");
  assert.match(hook, /case "busy":\n\s*await sleep\(Math\.min\(answer\.waitMs, deadline - Date\.now\(\)\), signal\);\n\s*break;/);
});

test("QuickConnect poll: 400, 503 and the disabled marker end the run; other failures are retried", () => {
  assert.deepEqual(readQuickConnectPoll(400, { error: "Bad server" }, null), { kind: "terminal", message: "Bad server" });
  assert.deepEqual(readQuickConnectPoll(503, null, null), { kind: "terminal", message: null });
  assert.deepEqual(readQuickConnectPoll(503, { error: "Not configured" }, null), { kind: "terminal", message: "Not configured" });
  assert.deepEqual(readQuickConnectPoll(502, { error: "Disabled", code: QC_DISABLED_CODE }, null), { kind: "terminal", message: "Disabled" });
  assert.deepEqual(readQuickConnectPoll(502, { error: "Jellyfin down" }, null), { kind: "retry", message: "Jellyfin down" });
  assert.deepEqual(readQuickConnectPoll(504, "<html>", null), { kind: "retry", message: null });
});

test("Plex PIN: only an integer pin and a non-empty code pass", () => {
  assert.deepEqual(readPlexPin({ pinId: 123, code: "abcd", extra: 1 }), { pinId: 123, code: "abcd" });
  assert.equal(readPlexPin({ pinId: "123", code: "abcd" }), null);
  assert.equal(readPlexPin({ pinId: 1.5, code: "abcd" }), null);
  assert.equal(readPlexPin({ pinId: 123 }), null);
  assert.equal(readPlexPin({ pinId: 123, code: "" }), null);
  assert.equal(readPlexPin(null), null);
});
