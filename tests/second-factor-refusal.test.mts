// How the password change and the account close read a refused change behind
// the second-factor step-up (src/components/profile/second-factor-refusal.ts).
import { test } from "node:test";
import assert from "node:assert/strict";
import { nextServerAsk, readSecondFactorRefusal, standingServerMethods } from "../src/components/profile/second-factor-refusal.ts";

const t = (key: string, vars?: Record<string, string | number>) => (vars ? `${key} ${JSON.stringify(vars)}` : key);
const res = (status: number, retryAfter: string | null = null) => ({ status, headers: { get: () => retryAfter } });

test("a second factor asked for with none sent asks for a code here, and records the methods", () => {
  const r = readSecondFactorRefusal(res(400), { error: "x", secondFactorRequired: true, methods: ["totp", "webauthn", 7] }, false, t, "fallback");
  assert.deepEqual(r, { methods: ["totp", "webauthn"], message: "profile.mfa.stepUp.codeRequired" });
});

test("asked without a method list is told apart from not asked", () => {
  assert.equal(readSecondFactorRefusal(res(400), { secondFactorRequired: true }, false, t, "f").methods, "unlisted");
  assert.equal(readSecondFactorRefusal(res(400), { error: "Wrong password" }, false, t, "f").methods, null);
});

test("a proof that was sent and refused shows the server's reason", () => {
  const r = readSecondFactorRefusal(res(400), { error: "That code is not valid.", secondFactorRequired: true }, true, t, "f");
  assert.equal(r.message, "That code is not valid.");
});

test("a two-factor lockout (429, no Retry-After) shows its own explanation", () => {
  assert.equal(readSecondFactorRefusal(res(429), { error: "Locked for 15 minutes." }, true, t, "f").message, "Locked for 15 minutes.");
});

test("a rate limit with Retry-After names the wait", () => {
  assert.equal(readSecondFactorRefusal(res(429, "30"), { error: "slow down" }, false, t, "f").message, 'shared.rateLimited.seconds {"seconds":30}');
});

test("a step-up refusal's sentence wins over its slug; anything unreadable gets the fallback", () => {
  assert.equal(readSecondFactorRefusal(res(401), { error: "session-too-old", message: "Sign in again first." }, false, t, "f").message, "Sign in again first.");
  assert.equal(readSecondFactorRefusal(res(500), null, false, t, "fallback").message, "fallback");
  assert.equal(readSecondFactorRefusal(res(400), { error: { issues: [] } }, false, t, "fallback").message, "fallback", "a non-string error is never rendered");
});

// A refused code latched "the server wants a second factor" for the life of the
// page: after two-factor was turned off the field stayed, and setting it up
// again asked for a code the account could no longer produce.
test("the server's ask stands only while the account's two-factor state is the one it was made under", () => {
  const whileOn = nextServerAsk(null, "unlisted", true);
  assert.deepEqual(standingServerMethods(whileOn, true), []);
  assert.equal(standingServerMethods(whileOn, false), null, "two-factor turned off since: nothing to ask for");
  // Turned on in another tab: the page knew "off" and still does, so the ask stands.
  const elsewhere = nextServerAsk(null, ["totp", "webauthn"], false);
  assert.deepEqual(standingServerMethods(elsewhere, false), ["totp", "webauthn"]);
  // An ask without a list keeps a standing list, and never one made under another state.
  assert.deepEqual(nextServerAsk(elsewhere, "unlisted", false), { methods: ["totp", "webauthn"], whenEnabled: false });
  assert.deepEqual(nextServerAsk(elsewhere, "unlisted", true), { methods: [], whenEnabled: true });
  assert.equal(nextServerAsk(elsewhere, null, false), elsewhere, "a refusal that asked for nothing changes nothing");
  assert.equal(standingServerMethods(null, true), null);
});

test("the step-up hook reads the server's ask through the standing rule only", async () => {
  const { readFileSync } = await import("node:fs");
  const hook = readFileSync(new URL("../src/components/profile/use-second-factor-step-up.ts", import.meta.url), "utf8");
  assert.match(hook, /const serverMethods = standingServerMethods\(serverAsk, knownEnabled\);/);
  assert.match(hook, /setServerAsk\(\(ask\) => nextServerAsk\(ask, refusal\.methods, knownEnabled\)\);/);
  assert.doesNotMatch(hook, /setServerMethods/);
});
