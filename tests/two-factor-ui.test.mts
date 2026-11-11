// The Profile → Two-factor section keeps ONE shared password field for every
// change (two-factor.tsx). After the server accepts a change, the password must
// be cleared: left in state and in the input, anyone at the unlocked tab could
// make the next change without retyping it — after 2FA is switched off that
// includes planting their own first factor, which needs the password alone
// (guardrails 6d, 6g). The component is a .tsx client module the unit loader
// can't import, so its handlers are pinned by a structural scan.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import {
  readCreationOptions,
  readRecoveryCodes,
  readTotpSetup,
  readTwoFactorState,
} from "../src/components/profile/two-factor-data.ts";

const src = readFileSync(new URL("../src/components/profile/two-factor.tsx", import.meta.url), "utf8");

// Every `const name = (...) => run(…)` / `stepUpRun(…)` handler body.
function handlers(): Map<string, { body: string; stepUp: boolean }> {
  const out = new Map<string, { body: string; stepUp: boolean }>();
  const re = /const (\w+) = \([^)]*\) => (run|stepUpRun)\(/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(src)) !== null) {
    const end = src.indexOf("\n  }", m.index);
    assert.ok(end > m.index, `handler ${m[1]} has a body`);
    out.set(m[1], { body: src.slice(m.index, end), stepUp: m[2] === "stepUpRun" });
  }
  return out;
}

test("every two-factor change goes through the one step-up prelude, which sends the password and clears the code first", () => {
  const all = handlers();
  // The seven password step-ups; confirmTotp sends only the setup code.
  assert.deepEqual(
    [...all].filter(([, h]) => h.stepUp).map(([name]) => name).sort(),
    ["addPasskey", "disableAll", "regenerateCodes", "removePasskey", "removeTotp", "renamePasskey", "startTotp"],
  );
  assert.equal(all.get("confirmTotp")?.stepUp, false);
  const start = src.indexOf("const stepUpRun = (");
  const prelude = src.slice(start, src.indexOf("\n  });\n", start));
  const needPw = prelude.indexOf("if (needPassword()) return;");
  const factor = prelude.indexOf("await secondFactorBody()");
  const send = prelude.indexOf("await fn({ password, ...sf })");
  assert.ok(needPw > 0 && factor > needPw && send > factor,
    "password, then second factor, then the request");
  // The second factor comes from the shared hook, which clears the single-use
  // code as it reads it, before any request is sent.
  const body = src.slice(src.indexOf("async function secondFactorBody()"), src.indexOf("const stepUpCall = ("));
  assert.match(body, /if \(!stepUpFactor\.needsSecondFactor\) return \{\};\s*const r = await stepUpFactor\.secondFactorProof\(\);/);
  const hook = readFileSync(new URL("../src/components/profile/use-second-factor-step-up.ts", import.meta.url), "utf8");
  assert.match(hook, /failedMessage: \(\) => failedMessage,\s*\}\);\s*setStepUpCode\(""\);\s*return r;/);
  assert.doesNotMatch(src, /buildSecondFactor/, "no private copy of the step-up flow");
  // No handler re-implements the prelude.
  for (const [name, h] of all) {
    assert.ok(!h.body.includes("secondFactorBody()"), `${name} uses the shared prelude`);
  }
});

test("every two-factor handler that sends the account password clears it once the server accepted the change", () => {
  for (const [name, h] of handlers()) {
    if (!h.stepUp) {
      assert.ok(!/setPassword\(""\)/.test(h.body), `${name} sends no password`);
      continue;
    }
    const sent = h.body.search(/\bstepUp\b[),]/);
    const cleared = h.body.indexOf('setPassword("")');
    assert.ok(sent > 0 && cleared > sent, `${name} must call setPassword("") after its password request succeeded`);
    // After the success check, not before it: a refused change keeps the field
    // so the user can correct a typo without retyping everything.
    const okCheck = h.body.indexOf(".ok) return setError(", sent);
    assert.ok(okCheck > 0 && cleared > okCheck, `${name} clears the password only on success`);
  }
});

test("enrolled passkeys stay listed (rename/remove) when WebAuthn is unavailable; only the add row is gated", () => {
  const section = src.slice(src.indexOf("function PasskeySection("), src.indexOf("function PasskeyRow("));
  const list = section.indexOf("{state.passkeys.map((p) =>");
  const gate = section.indexOf("{state.webauthnAvailable ? (");
  assert.ok(list > 0 && gate > list, "the passkey list renders before, and outside, the WebAuthn conditional");
  const jsx = section.slice(section.indexOf("return ("));
  assert.ok(!jsx.slice(0, jsx.indexOf("{state.passkeys.map((p) =>")).includes("webauthnAvailable"), "nothing gates the list on WebAuthn");
  const addRow = section.indexOf("onClick={onAdd}");
  assert.ok(addRow > gate, "adding a passkey stays behind the WebAuthn gate");
  assert.match(src, /<PasskeySection[\s\S]*?onAdd=\{addPasskey\}/);
});

test("a regenerate answer without the new codes is reported, not rendered as an empty list", () => {
  const body = handlers().get("regenerateCodes")?.body ?? "";
  const guard = body.indexOf("if (!issued) {");
  const show = body.indexOf("setCodes(issued)");
  assert.ok(body.indexOf("const issued = readRecoveryCodes(r.data);") > 0 && guard > 0 && show > guard);
});

test("an MFA answer is shape-checked before it renders or keys anything", () => {
  const state = readTwoFactorState({
    enabled: true,
    totpEnabled: false,
    passkeys: [
      { id: "a", name: "Phone", createdAt: "2026-01-01T00:00:00Z", lastUsedAt: null, backedUp: true },
      { id: "b", name: "Broken" },
      "junk",
    ],
    recoveryCodesRemaining: "x",
    webauthnAvailable: true,
  });
  assert.deepEqual(state.passkeys.map((p) => p.id), ["a"], "a row missing its fields is dropped");
  assert.equal(state.recoveryCodesRemaining, 0);
  assert.deepEqual(readRecoveryCodes({ recoveryCodes: ["a1", "b2"] }), ["a1", "b2"]);
  assert.equal(readRecoveryCodes({ recoveryCodes: ["a1", 2] }), null, "a non-string code refuses the list");
  assert.equal(readRecoveryCodes({}), null);
  const publicKey = {
    rp: { id: "x", name: "X" }, user: { id: "u", name: "n", displayName: "N" }, challenge: "c",
    pubKeyCredParams: [{ type: "public-key", alg: -7 }], excludeCredentials: [{ id: "k", type: "public-key" }],
  };
  assert.equal(readCreationOptions({ publicKey }), publicKey, "a usable options object passes through whole");
  assert.equal(readCreationOptions({ publicKey: { ...publicKey, challenge: 1 } }), null);
  assert.equal(readCreationOptions({}), null);
  assert.deepEqual(readTotpSetup({ secret: "S", otpauthUri: "otpauth://x" }), { secret: "S", otpauthUri: "otpauth://x" });
  assert.equal(readTotpSetup({ secret: "S" }), null);
});

// Revoked in the same tick as click() on a detached anchor, the URL saved an
// empty file (or nothing) in browsers that start the download afterwards.
test("the recovery-code download attaches the anchor and revokes the URL later", () => {
  const fn = src.slice(src.indexOf("function downloadText("), src.indexOf("function QrImage("));
  assert.match(fn, /document\.body\.appendChild\(a\);\s*a\.click\(\);\s*a\.remove\(\);\s*setTimeout\(\(\) => URL\.revokeObjectURL\(url\), \d[\d_]*\);/);
  assert.doesNotMatch(src, /navigator\.clipboard/, "copies go through useCopyFeedback");
});

// Closing the account kept its own copy of the code / passkey builder, which
// drifted from the shared one. Every profile step-up now goes through it, by
// way of the one hook the password change and the account close share.
test("Delete account and Change password build their second factor through one shared hook", () => {
  const hook = readFileSync(new URL("../src/components/profile/use-second-factor-step-up.ts", import.meta.url), "utf8");
  assert.match(hook, /const r = await buildSecondFactor\(\{\s*code: stepUpCode,\s*passkeyPossible,\s*t,\s*failedMessage: \(\) => failedMessage,/);
  const del = readFileSync(new URL("../src/components/profile/delete-account.tsx", import.meta.url), "utf8");
  const pw = readFileSync(new URL("../src/components/profile/change-password.tsx", import.meta.url), "utf8");
  assert.match(del, /useSecondFactorStepUp\(\{[\s\S]*?failedMessage: t\("profile\.close\.error\.failed"\),/);
  assert.match(pw, /useSecondFactorStepUp\(\{ known: secondFactor, failedMessage: t\("profile\.password\.error\.failed"\) \}\)/);
  for (const [name, body] of [["delete-account", del], ["change-password", pw]] as const) {
    assert.doesNotMatch(body, /\/api\/profile\/mfa\/challenge/, `${name}: no second copy of the challenge request`);
    assert.doesNotMatch(body, /buildSecondFactor|data\.secondFactorRequired|serverMethods/, `${name}: no private copy of the step-up flow`);
  }
});

test("a typed step-up code: six digits (spaces aside) is an authenticator code, anything else a recovery code", async () => {
  const { codeProof } = await import("../src/lib/client/step-up.ts");
  assert.deepEqual(codeProof("123 456"), { method: "totp", code: "123456" });
  assert.deepEqual(codeProof("abcd-efgh"), { method: "recovery", code: "abcd-efgh" });
  assert.deepEqual(codeProof("1234567"), { method: "recovery", code: "1234567" });
});

// The link flows behind the step-up (Discord link, Discord merge, Trakt
// connect): the route asks a two-factor account for a fresh second factor once
// the password passed (guardrail 6g).
test("a link route's second-factor ask is the 400 secondFactorRequired answer, and nothing else", async () => {
  const { asksSecondFactor, withSecondFactor } = await import("../src/lib/client/step-up.ts");
  assert.equal(asksSecondFactor(400, { error: "…", secondFactorRequired: true, methods: ["totp"] }), true);
  assert.equal(asksSecondFactor(400, { error: "…", secondFactorRequired: true }), true, "a refused code keeps the prompt open");
  assert.equal(asksSecondFactor(400, { error: "Invalid Discord user id" }), false);
  assert.equal(asksSecondFactor(401, { error: "password-required", secondFactorRequired: true }), false);
  assert.equal(asksSecondFactor(400, null), false);
  assert.equal(asksSecondFactor(400, { secondFactorRequired: "yes" }), false);
  const body = { discordId: "1" };
  assert.equal(withSecondFactor(body, undefined), body, "no proof, no field");
  assert.deepEqual(withSecondFactor(body, { method: "totp", code: "123456" }), { discordId: "1", secondFactor: { method: "totp", code: "123456" } });
});

test("the Discord and Trakt link flows answer a second-factor ask with the shared prompt, and send the proof only with the password", () => {
  const post = readFileSync(new URL("../src/components/use-step-up-post.ts", import.meta.url), "utf8");
  const trakt = readFileSync(new URL("../src/components/profile/trakt-connect.tsx", import.meta.url), "utf8");
  const discord = readFileSync(new URL("../src/components/discord-link-ui.tsx", import.meta.url), "utf8");
  for (const [name, body] of [["use-step-up-post", post], ["trakt-connect", trakt]] as const) {
    assert.match(body, /useSecondFactorStepUp\(\{ known: /, `${name}: the one shared second-factor hook`);
    assert.match(body, /if \(confirmPassword && factor\.needsSecondFactor\) \{\s*const r = await factor\.secondFactorProof\(\);/, `${name}: the proof rides with the password`);
    assert.match(body, /withSecondFactor\(withStepUpPassword\(/, `${name}: one request carries both`);
    assert.match(body, /asksSecondFactor\(res\.status, [\s\S]{0,40}\)\) \{\s*setStepUp\(true\);\s*setStepUpError\(factor\.refusalMessage\(/, `${name}: an ask opens the prompt with the shared refusal text`);
    assert.doesNotMatch(body, /\/api\/profile\/mfa\/challenge|buildSecondFactor\(/, `${name}: no private copy of the step-up flow`);
  }
  // Both Discord flows pass the page's knowledge on and render the shared field.
  assert.equal(discord.match(/\}, secondFactor\);/g)?.length, 2);
  assert.equal(discord.match(/<SecondFactorCodeField/g)?.length, 2);
  assert.equal(trakt.match(/<SecondFactorCodeField/g)?.length, 1);
  const page = readFileSync(new URL("../src/app/(app)/profile/page.tsx", import.meta.url), "utf8");
  assert.match(page, /<DiscordLinkSection[\s\S]{0,200}secondFactor=\{secondFactor\}/);
  assert.match(page, /<TraktConnect[\s\S]{0,600}secondFactor=\{secondFactor\}/);
});
