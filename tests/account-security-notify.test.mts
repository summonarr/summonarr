// Wording of the "app signed in" owner notice (src/lib/account-security-notify.ts).
// signInAndMintSession sends it for every NATIVE sign-in — a session nothing
// time-based ends (guardrail 6c) — so the owner learns which device signed in.
// tests/auth.test.mts pins the trigger and the rendered email; this pins the
// pure sentence: the device label is carried, a missing one reads as "unknown
// device", and it never lists linked accounts (that list is the compromise-
// response events' advice, not a sign-in's).
import { test } from "node:test";
import assert from "node:assert/strict";

process.env.TOKEN_ENCRYPTION_KEY = "ab".repeat(32);

const { accountSecurityMessage } = await import("../src/lib/account-security-notify.ts");

const t = (key: string, vars?: Record<string, string | number>) =>
  vars ? `${key}(${Object.entries(vars).map(([k, v]) => `${k}=${v}`).join(",")})` : key;
const linked = { discordId: "123456789012345678", traktUsername: "alice" };

test("app-signed-in names the device the session signed in on", () => {
  assert.equal(
    accountSecurityMessage(t, "app-signed-in", linked, { device: "Safari on iPhone" }),
    "notify.account.event.app-signed-in(device=Safari on iPhone)",
  );
});

test("app-signed-in with no (or a blank) device label says unknown device", () => {
  for (const device of [undefined, null, "", "   "]) {
    assert.equal(
      accountSecurityMessage(t, "app-signed-in", linked, { device }),
      "notify.account.event.app-signed-in(device=notify.account.unknownDevice)",
    );
  }
  assert.equal(
    accountSecurityMessage(t, "app-signed-in", linked),
    "notify.account.event.app-signed-in(device=notify.account.unknownDevice)",
  );
});
